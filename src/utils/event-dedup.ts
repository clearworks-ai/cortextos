import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export interface EventDedupResult {
  surface: boolean;
  reason: 'first-seen' | 'duplicate' | 'duplicate-fire-once' | 'invalid-key' | 'no-ctx-root';
  ageSec?: number;
}

interface EventLedgerEntry {
  firstSeenAt: number;
  fireOnce: boolean;
}

type EventLedger = Record<string, EventLedgerEntry>;

const DEFAULT_TTL_SEC = 30 * 86400;
const MIN_PRUNE_SEC = 30 * 86400;
const FIRE_ONCE_PRUNE_SEC = 365 * 86400;

const SOURCE_KEY_PATTERN = /^[a-z0-9_-]{1,32}:[A-Za-z0-9_/+=@.<>-]{1,512}$/;

export function isValidSourceKey(source: string): boolean {
  return typeof source === 'string' && SOURCE_KEY_PATTERN.test(source);
}

function isLedgerEntry(value: unknown): value is EventLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.firstSeenAt === 'number' &&
    Number.isFinite(entry.firstSeenAt) &&
    typeof entry.fireOnce === 'boolean'
  );
}

function readLedger(filePath: string): EventLedger {
  if (!existsSync(filePath)) {
    return {};
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      return {};
    }
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const ledger: EventLedger = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isLedgerEntry(value)) {
      ledger[key] = { firstSeenAt: value.firstSeenAt, fireOnce: value.fireOnce };
    }
  }

  return ledger;
}

function pruneLedger(ledger: EventLedger, now: number, ttlSec: number): EventLedger {
  const pruneAfterSec = Math.max(ttlSec, MIN_PRUNE_SEC);
  const next: EventLedger = {};

  for (const [key, entry] of Object.entries(ledger)) {
    const ageSec = now - entry.firstSeenAt;
    const limitSec = entry.fireOnce ? FIRE_ONCE_PRUNE_SEC : pruneAfterSec;
    if (ageSec <= limitSec) {
      next[key] = entry;
    }
  }

  return next;
}

function writeLedger(ledgerPath: string, ledger: EventLedger): void {
  ensureDir(dirname(ledgerPath));
  atomicWriteSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

export function checkAndRecordSourceEvent(
  ctxRoot: string,
  source: string,
  opts?: { fireOnce?: boolean; ttlSec?: number },
): EventDedupResult {
  if (!ctxRoot) {
    return { surface: true, reason: 'no-ctx-root' };
  }

  if (!isValidSourceKey(source)) {
    return { surface: true, reason: 'invalid-key' };
  }

  const ttlSec = opts?.ttlSec ?? DEFAULT_TTL_SEC;
  const fireOnce = opts?.fireOnce === true;
  const ledgerPath = join(ctxRoot, 'state', 'comms-event-dedup.json');
  const now = Math.floor(Date.now() / 1000);

  const ledger = pruneLedger(readLedger(ledgerPath), now, ttlSec);
  const existing = ledger[source];

  if (existing !== undefined) {
    const ageSec = now - existing.firstSeenAt;

    if (existing.fireOnce) {
      return { surface: false, reason: 'duplicate-fire-once', ageSec };
    }

    if (ageSec < ttlSec) {
      if (fireOnce) {
        ledger[source] = { firstSeenAt: existing.firstSeenAt, fireOnce: true };
        writeLedger(ledgerPath, ledger);
      }
      return { surface: false, reason: 'duplicate', ageSec };
    }
  }

  ledger[source] = { firstSeenAt: now, fireOnce };
  writeLedger(ledgerPath, ledger);
  return { surface: true, reason: 'first-seen' };
}
