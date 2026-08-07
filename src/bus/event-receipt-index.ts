import { existsSync, readFileSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

export const EVENT_RECEIPT_INDEX_VERSION = 2;
export const MAX_EVENT_RECEIPT_DEDUP_KEYS = 10_000;
const MAX_CURSOR_ENTRIES = 1_000;
const EVENT_ID_RE = /^evt_v1_[a-f0-9]{40}$/;
const SAFE_CURSOR_RE = /^[a-zA-Z0-9_.:-]{1,160}$/;

export interface EventReceiptIndex {
  version: typeof EVENT_RECEIPT_INDEX_VERSION;
  dedup: Record<string, string>;
  cursors: Record<string, string>;
}

function indexPath(stateDir: string): string { return join(stateDir, 'event-receipt-index.json'); }
function lockDir(stateDir: string): string { return join(stateDir, '.event-receipt-domain'); }
function secretPath(stateDir: string): string { return join(stateDir, 'event-receipt-secret'); }
function emptyIndex(): EventReceiptIndex { return { version: EVENT_RECEIPT_INDEX_VERSION, dedup: {}, cursors: {} }; }

function assertIndex(index: EventReceiptIndex): void {
  if (index.version !== EVENT_RECEIPT_INDEX_VERSION || !index.dedup || typeof index.dedup !== 'object' || !index.cursors || typeof index.cursors !== 'object') throw new Error('event receipt index is invalid');
  if (Object.keys(index.dedup).length > MAX_EVENT_RECEIPT_DEDUP_KEYS || Object.keys(index.cursors).length > MAX_CURSOR_ENTRIES) throw new Error('event receipt index exceeds bounded capacity');
  for (const [eventId, at] of Object.entries(index.dedup)) if (!EVENT_ID_RE.test(eventId) || Number.isNaN(Date.parse(at))) throw new Error('event receipt index is invalid');
  for (const [cursor, value] of Object.entries(index.cursors)) if (!SAFE_CURSOR_RE.test(cursor) || !SAFE_CURSOR_RE.test(value)) throw new Error('event receipt index is invalid');
}

export function readEventReceiptIndex(stateDir: string): EventReceiptIndex {
  const filePath = indexPath(stateDir);
  if (!existsSync(filePath)) return emptyIndex();
  try {
    const index = JSON.parse(readFileSync(filePath, 'utf-8')) as EventReceiptIndex;
    assertIndex(index);
    return index;
  } catch {
    throw new Error('event receipt index is unreadable');
  }
}

export function writeEventReceiptIndex(stateDir: string, index: EventReceiptIndex): void {
  assertIndex(index);
  atomicWriteSync(indexPath(stateDir), JSON.stringify(index));
}

export function withEventReceiptDomainLock<T>(stateDir: string, fn: () => T): T {
  ensureDir(stateDir);
  ensureDir(lockDir(stateDir));
  return withFileLockSync(lockDir(stateDir), fn);
}

/** Must be called inside the event receipt domain lock. The key never leaves disk. */
export function readOrCreateEventReceiptKey(stateDir: string): Buffer {
  const filePath = secretPath(stateDir);
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, 'utf-8').trim();
    if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('event receipt identity key is unreadable');
    return Buffer.from(stored, 'hex');
  }
  const key = randomBytes(32);
  atomicWriteSync(filePath, key.toString('hex'));
  const stored = readFileSync(filePath, 'utf-8').trim();
  if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('event receipt identity key is unreadable');
  return Buffer.from(stored, 'hex');
}

function pruneDedup(index: EventReceiptIndex): void {
  const entries = Object.entries(index.dedup).sort(([, left], [, right]) => left.localeCompare(right));
  for (const [eventId] of entries.slice(0, Math.max(0, entries.length - MAX_EVENT_RECEIPT_DEDUP_KEYS))) delete index.dedup[eventId];
}

/** Compatibility helper for callers that need a durable dedup claim without a receipt. */
export function claimEventReceipt(stateDir: string, eventId: string, at = new Date().toISOString()): 'accepted' | 'duplicate' {
  if (!EVENT_ID_RE.test(eventId) || Number.isNaN(Date.parse(at))) throw new Error('invalid event receipt claim');
  return withEventReceiptDomainLock(stateDir, () => {
    const index = readEventReceiptIndex(stateDir);
    if (index.dedup[eventId]) return 'duplicate';
    index.dedup[eventId] = at;
    pruneDedup(index);
    writeEventReceiptIndex(stateDir, index);
    return 'accepted';
  });
}

export function releaseEventReceiptClaim(stateDir: string, eventId: string, at: string): void {
  if (!EVENT_ID_RE.test(eventId) || Number.isNaN(Date.parse(at))) return;
  withEventReceiptDomainLock(stateDir, () => {
    const index = readEventReceiptIndex(stateDir);
    if (index.dedup[eventId] !== at) return;
    delete index.dedup[eventId];
    writeEventReceiptIndex(stateDir, index);
  });
}

export function advanceEventCursor(stateDir: string, cursor: string, value: string): boolean {
  if (!SAFE_CURSOR_RE.test(cursor) || !SAFE_CURSOR_RE.test(value)) throw new Error('invalid event receipt cursor');
  return withEventReceiptDomainLock(stateDir, () => {
    const index = readEventReceiptIndex(stateDir);
    const current = index.cursors[cursor];
    if (current !== undefined && current >= value) return false;
    index.cursors[cursor] = value;
    writeEventReceiptIndex(stateDir, index);
    return true;
  });
}

export function getEventCursor(stateDir: string, cursor: string): string | undefined {
  if (!SAFE_CURSOR_RE.test(cursor)) throw new Error('invalid event receipt cursor');
  return withEventReceiptDomainLock(stateDir, () => readEventReceiptIndex(stateDir).cursors[cursor]);
}

export function clearEventReceiptJournal(stateDir: string): void {
  try { unlinkSync(join(stateDir, 'event-receipt-tx.json')); } catch { /* absent journal is normal */ }
}
