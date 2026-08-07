import { createHmac, randomUUID } from 'crypto';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import {
  MAX_EVENT_RECEIPT_DEDUP_KEYS,
  MAX_EVENT_ROUTE_PROPOSALS,
  clearEventReceiptJournal,
  readEventReceiptIndex,
  readOrCreateEventReceiptKey,
  withEventReceiptDomainLock,
  writeEventReceiptIndex,
} from './event-receipt-index.js';

export const EVENT_RECEIPT_VERSION = 2;
export const MAX_EVENT_RECEIPT_BYTES = 1_024;
export const MAX_EVENT_RECEIPT_LINES = 2_000;
const ROTATE_AT_BYTES = 512 * 1_024;
const EVENT_ID_RE = /^evt_v1_[a-f0-9]{40}$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9_.:-]{0,95}$/;

export type EventIngressDisposition = 'accepted' | 'duplicate' | 'rejected' | 'ignored_disabled';
export type EventRoutingState = 'proposed' | 'attempted' | 'failed';
export type EventProcessingState = 'started' | 'succeeded' | 'failed' | 'needs_human' | 'resync_required' | 'resynced';
export type EventReceiptStage = 'ingress' | 'routing' | 'processing';

export interface EventReceipt {
  version: typeof EVENT_RECEIPT_VERSION;
  receipt_id: string;
  event_id: string;
  at: string;
  stage: EventReceiptStage;
  disposition?: EventIngressDisposition;
  routing_state?: EventRoutingState;
  state?: EventProcessingState;
  route?: string;
  reason?: string;
}

export interface IngressEvent { provider: string; eventType: string; sourceId: string; occurredAt?: string; }
export interface EventReceiptDependencies { writeIndex?: typeof writeEventReceiptIndex; }
interface EventReceiptJournal { version: 1; receipt: EventReceipt; }

function receiptPath(stateDir: string): string { return join(stateDir, 'event-receipts.jsonl'); }
function receiptLockDir(stateDir: string): string { return join(stateDir, '.event-receipt-log'); }
function journalPath(stateDir: string): string { return join(stateDir, 'event-receipt-tx.json'); }
function routeProposalJournalPath(stateDir: string): string { return join(stateDir, 'event-route-proposal-tx.json'); }

function assertSafeCode(value: string | undefined): void {
  if (value !== undefined && !SAFE_CODE_RE.test(value)) throw new Error('invalid event receipt');
}

function assertExactKeys(receipt: EventReceipt): void {
  const allowed = new Set(['version', 'receipt_id', 'event_id', 'at', 'stage', 'disposition', 'routing_state', 'state', 'route', 'reason']);
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) throw new Error('invalid event receipt');
}

export function canonicalEventId(stateDir: string, event: IngressEvent): string {
  for (const value of [event.provider, event.eventType, event.sourceId, event.occurredAt ?? '']) if (typeof value !== 'string' || value.length > 512) throw new Error('invalid ingress event');
  return withEventReceiptDomainLock(stateDir, () => {
    const key = readOrCreateEventReceiptKey(stateDir);
    const material = [event.provider, event.eventType, event.sourceId, event.occurredAt ?? ''].join('\u0000');
    return 'evt_v1_' + createHmac('sha256', key).update(material).digest('hex').slice(0, 40);
  });
}

export function assertEventReceipt(receipt: EventReceipt): void {
  assertExactKeys(receipt);
  if (receipt.version !== EVENT_RECEIPT_VERSION || !EVENT_ID_RE.test(receipt.event_id) || !/^[0-9a-f-]{36}$/i.test(receipt.receipt_id) || Number.isNaN(Date.parse(receipt.at))) throw new Error('invalid event receipt');
  assertSafeCode(receipt.route);
  assertSafeCode(receipt.reason);
  if (receipt.stage === 'ingress') {
    if (!receipt.disposition || receipt.routing_state || receipt.state || receipt.route) throw new Error('invalid event receipt');
  } else if (receipt.stage === 'routing') {
    if (!receipt.routing_state || !receipt.route || receipt.disposition || receipt.state) throw new Error('invalid event receipt');
  } else if (receipt.stage === 'processing') {
    if (!receipt.state || receipt.disposition || receipt.routing_state) throw new Error('invalid event receipt');
  } else throw new Error('invalid event receipt');
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf-8') > MAX_EVENT_RECEIPT_BYTES) throw new Error('event receipt exceeds bounded size');
}

function rotateIfNeeded(filePath: string): void {
  if (!existsSync(filePath) || statSync(filePath).size < ROTATE_AT_BYTES) return;
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  if (lines.length > MAX_EVENT_RECEIPT_LINES) atomicWriteSync(filePath, lines.slice(-MAX_EVENT_RECEIPT_LINES).join('\n') + '\n');
}

function appendReceiptLocked(stateDir: string, receipt: EventReceipt): void {
  assertEventReceipt(receipt);
  ensureDir(stateDir);
  ensureDir(receiptLockDir(stateDir));
  withFileLockSync(receiptLockDir(stateDir), () => {
    const filePath = receiptPath(stateDir);
    rotateIfNeeded(filePath);
    appendFileSync(filePath, JSON.stringify(receipt) + '\n', { encoding: 'utf-8', mode: 0o600 });
  });
}

function hasReceiptLocked(stateDir: string, receiptId: string): boolean {
  const filePath = receiptPath(stateDir);
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, 'utf-8').split('\n').some(line => {
    try { return !!line && (JSON.parse(line) as EventReceipt).receipt_id === receiptId; } catch { return false; }
  });
}

function pruneDedup(index: ReturnType<typeof readEventReceiptIndex>): void {
  const entries = Object.entries(index.dedup).sort(([, left], [, right]) => left.localeCompare(right));
  for (const [eventId] of entries.slice(0, Math.max(0, entries.length - MAX_EVENT_RECEIPT_DEDUP_KEYS))) delete index.dedup[eventId];
}

function routeProposalKey(eventId: string, route: string): string { return `${eventId}:${route}`; }

function pruneRouteProposals(index: ReturnType<typeof readEventReceiptIndex>): void {
  const proposedRoutes = index.proposedRoutes ?? (index.proposedRoutes = {});
  const entries = Object.entries(proposedRoutes).sort(([, left], [, right]) => left.localeCompare(right));
  for (const [claim] of entries.slice(0, Math.max(0, entries.length - MAX_EVENT_ROUTE_PROPOSALS))) delete proposedRoutes[claim];
}

function recoverRouteProposalJournalLocked(stateDir: string): void {
  const filePath = routeProposalJournalPath(stateDir);
  if (!existsSync(filePath)) return;
  let journal: EventReceiptJournal;
  try {
    journal = JSON.parse(readFileSync(filePath, 'utf-8')) as EventReceiptJournal;
    if (journal.version !== 1) throw new Error('invalid');
    assertEventReceipt(journal.receipt);
    if (journal.receipt.stage !== 'routing' || journal.receipt.routing_state !== 'proposed' || !journal.receipt.route) throw new Error('invalid');
  } catch {
    throw new Error('event route proposal transaction is unreadable');
  }
  const index = readEventReceiptIndex(stateDir);
  const proposedRoutes = index.proposedRoutes ?? (index.proposedRoutes = {});
  if (!hasReceiptLocked(stateDir, journal.receipt.receipt_id)) appendReceiptLocked(stateDir, journal.receipt);
  const claim = routeProposalKey(journal.receipt.event_id, journal.receipt.route);
  if (!proposedRoutes[claim]) {
    proposedRoutes[claim] = journal.receipt.at;
    pruneRouteProposals(index);
    writeEventReceiptIndex(stateDir, index);
  }
  try { unlinkSync(filePath); } catch { /* recovered journal may already be absent */ }
}

function recoverIngressJournalLocked(stateDir: string): void {
  const filePath = journalPath(stateDir);
  if (!existsSync(filePath)) return;
  let journal: EventReceiptJournal;
  try {
    journal = JSON.parse(readFileSync(filePath, 'utf-8')) as EventReceiptJournal;
    if (journal.version !== 1) throw new Error('invalid');
    assertEventReceipt(journal.receipt);
    if (journal.receipt.stage !== 'ingress' || journal.receipt.disposition !== 'accepted') throw new Error('invalid');
  } catch {
    throw new Error('event receipt transaction is unreadable');
  }
  const index = readEventReceiptIndex(stateDir);
  if (!hasReceiptLocked(stateDir, journal.receipt.receipt_id)) appendReceiptLocked(stateDir, journal.receipt);
  if (!index.dedup[journal.receipt.event_id]) {
    index.dedup[journal.receipt.event_id] = journal.receipt.at;
    pruneDedup(index);
    writeEventReceiptIndex(stateDir, index);
  }
  clearEventReceiptJournal(stateDir);
}

export function appendEventReceipt(stateDir: string, receipt: EventReceipt): void {
    appendReceiptLocked(stateDir, receipt);
}

export function readEventReceipts(stateDir: string, limit = 200): EventReceipt[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_RECEIPT_LINES) throw new Error('invalid event receipt limit');
  const filePath = receiptPath(stateDir);
  if (!existsSync(filePath)) return [];
  try {
    const receipts = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(line => {
      const receipt = JSON.parse(line) as EventReceipt;
      assertEventReceipt(receipt);
      return receipt;
    });
    return receipts.slice(-limit);
  } catch {
    throw new Error('event receipts unreadable');
  }
}

export function recordIngressReceipt(stateDir: string, event: IngressEvent, enabled = true, dependencies: EventReceiptDependencies = {}): EventReceipt {
  return withEventReceiptDomainLock(stateDir, () => {
    recoverIngressJournalLocked(stateDir);
    for (const value of [event.provider, event.eventType, event.sourceId, event.occurredAt ?? '']) if (typeof value !== 'string' || value.length > 512) throw new Error('invalid ingress event');
    const key = readOrCreateEventReceiptKey(stateDir);
    const material = [event.provider, event.eventType, event.sourceId, event.occurredAt ?? ''].join('\u0000');
    const eventId = 'evt_v1_' + createHmac('sha256', key).update(material).digest('hex').slice(0, 40);
    const at = new Date().toISOString();
    const index = readEventReceiptIndex(stateDir);
    const disposition: EventIngressDisposition = !enabled ? 'ignored_disabled' : index.dedup[eventId] ? 'duplicate' : 'accepted';
    const receipt: EventReceipt = { version: EVENT_RECEIPT_VERSION, receipt_id: randomUUID(), event_id: eventId, at, stage: 'ingress', disposition };
    if (disposition !== 'accepted') {
      appendReceiptLocked(stateDir, receipt);
      return receipt;
    }
    atomicWriteSync(journalPath(stateDir), JSON.stringify({ version: 1, receipt }));
    try {
      appendReceiptLocked(stateDir, receipt);
    } catch (error) {
      // The caller has not observed acceptance, so a synchronous append
      // failure must not leave a journal that a later retry silently commits.
      // Otherwise the retry is reported as duplicate and is never routed.
      clearEventReceiptJournal(stateDir);
      throw error;
    }
    index.dedup[eventId] = at;
    pruneDedup(index);
    try {
      (dependencies.writeIndex ?? writeEventReceiptIndex)(stateDir, index);
      clearEventReceiptJournal(stateDir);
    } catch {
      // The acceptance receipt is already durable. Return it to the caller so
      // routing proceeds; retain the journal so the dedup index heals before
      // any subsequent ingress can be evaluated.
    }
    return receipt;
  });
}

export function recordRejectedIngressReceipt(stateDir: string, event: IngressEvent, reason: string): EventReceipt {
  const eventId = canonicalEventId(stateDir, event);
  const receipt: EventReceipt = { version: EVENT_RECEIPT_VERSION, receipt_id: randomUUID(), event_id: eventId, at: new Date().toISOString(), stage: 'ingress', disposition: 'rejected', reason };
  appendReceiptLocked(stateDir, receipt);
  return receipt;
}

export function recordEventRoutingReceipt(stateDir: string, eventId: string, routingState: EventRoutingState, route: string, reason?: string): EventReceipt {
  const receipt: EventReceipt = { version: EVENT_RECEIPT_VERSION, receipt_id: randomUUID(), event_id: eventId, at: new Date().toISOString(), stage: 'routing', routing_state: routingState, route, reason };
  appendReceiptLocked(stateDir, receipt);
  return receipt;
}

/**
 * Atomically claims and records one shadow proposal per event/route pair.
 * A journal heals crashes between receipt append and durable index update.
 */
export function recordEventRoutingProposalOnce(stateDir: string, eventId: string, route: string, reason?: string): EventReceipt | undefined {
  return withEventReceiptDomainLock(stateDir, () => {
    recoverRouteProposalJournalLocked(stateDir);
    const candidate: EventReceipt = { version: EVENT_RECEIPT_VERSION, receipt_id: randomUUID(), event_id: eventId, at: new Date().toISOString(), stage: 'routing', routing_state: 'proposed', route, reason };
    assertEventReceipt(candidate);
    const index = readEventReceiptIndex(stateDir);
    const proposedRoutes = index.proposedRoutes ?? (index.proposedRoutes = {});
    const claim = routeProposalKey(eventId, route);
    if (proposedRoutes[claim]) return undefined;
    atomicWriteSync(routeProposalJournalPath(stateDir), JSON.stringify({ version: 1, receipt: candidate }));
    try {
      appendReceiptLocked(stateDir, candidate);
    } catch (error) {
      try { unlinkSync(routeProposalJournalPath(stateDir)); } catch { /* failed append leaves no claim to heal */ }
      throw error;
    }
    proposedRoutes[claim] = candidate.at;
    pruneRouteProposals(index);
    try {
      writeEventReceiptIndex(stateDir, index);
      unlinkSync(routeProposalJournalPath(stateDir));
    } catch {
      // The receipt is durable and the journal will restore the index before
      // the next proposal claim. Returning preserves receipt-before-cursor.
    }
    return candidate;
  });
}

export function recordEventProcessingReceipt(stateDir: string, eventId: string, state: EventProcessingState, route?: string, reason?: string): EventReceipt {
  const receipt: EventReceipt = { version: EVENT_RECEIPT_VERSION, receipt_id: randomUUID(), event_id: eventId, at: new Date().toISOString(), stage: 'processing', state, route, reason };
  appendReceiptLocked(stateDir, receipt);
  return receipt;
}
