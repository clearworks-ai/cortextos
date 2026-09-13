/**
 * Pure, I/O-free work-record transition functions.
 *
 * This module implements the `accepted -> dispatched -> runtime-accepted ->
 * executing -> {completed | failed | cancelled | needs-review}` state machine
 * over `WorkRecord[]` (per `LifecycleSnapshot.outstandingWork`).
 *
 * No `fs`, no `child_process`, no ambient clock: every function that needs
 * "now" takes `nowMs: number` as an explicit parameter. `workId` uniqueness
 * and generation-scoping are entirely the caller's (Task 3.2's) responsibility
 * — these functions operate only on the record(s) handed to them and never
 * search by generation or mutate in place.
 */

import type { GenerationToken, LifecycleSnapshot, WorkPhase, WorkRecord } from './types.js';

const LEGAL_TRANSITIONS: Record<WorkPhase, WorkPhase[]> = {
  accepted: ['dispatched', 'cancelled', 'needs-review'],
  dispatched: ['runtime-accepted', 'cancelled', 'needs-review', 'failed'],
  'runtime-accepted': ['executing', 'cancelled', 'needs-review', 'failed'],
  executing: ['completed', 'failed', 'needs-review', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  'needs-review': [],
};

const TERMINAL_PHASES: ReadonlySet<WorkPhase> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Applies one legal phase transition, returning a *new* `WorkRecord` (never
 * mutates `record`). Throws if `to` is not reachable from `record.phase`.
 */
function transition(record: WorkRecord, to: WorkPhase, nowMs: number, patch?: Partial<WorkRecord>): WorkRecord {
  const legal = LEGAL_TRANSITIONS[record.phase];
  if (!legal.includes(to)) {
    throw new Error(
      `work-ledger: illegal transition for workId ${record.workId}: '${record.phase}' -> '${to}' is not permitted`,
    );
  }
  return {
    ...record,
    ...patch,
    phase: to,
    lastTransitionAtMs: nowMs,
  };
}

export type AcceptInput = {
  sourceKey: string;
  payloadDigest: string;
  payloadRef: string;
  batchId: string | null;
};

export type AcceptResult =
  | { snapshot: LifecycleSnapshot; record: WorkRecord }
  | { conflict: true; existing: WorkRecord };

/**
 * Accepts a new unit of work into the ledger.
 *
 * - No existing record for `input.sourceKey` -> creates and appends a new
 *   `WorkRecord` in phase `accepted`.
 * - Existing record with the same `sourceKey` AND the same `payloadDigest`
 *   -> duplicate delivery of already-accepted work; the existing record is
 *   returned unchanged (not re-accepted, `lastTransitionAtMs` untouched).
 * - Existing record with the same `sourceKey` but a DIFFERENT `payloadDigest`
 *   -> conflict; never silently overwritten or content-hash-deduped.
 */
export function accept(
  snapshot: LifecycleSnapshot,
  input: AcceptInput,
  owner: GenerationToken,
  workId: string,
  nowMs: number,
): AcceptResult {
  const existing = snapshot.outstandingWork.find((r) => r.sourceKey === input.sourceKey);

  if (existing) {
    if (existing.payloadDigest === input.payloadDigest) {
      // Duplicate delivery of already-accepted work — not a conflict, not a
      // re-acceptance. Return the existing record unchanged.
      return { snapshot, record: existing };
    }
    // Same sourceKey, different payloadDigest — a real conflict.
    return { conflict: true, existing };
  }

  const record: WorkRecord = {
    workId,
    sourceKey: input.sourceKey,
    payloadDigest: input.payloadDigest,
    payloadRef: input.payloadRef,
    owner,
    phase: 'accepted',
    batchId: input.batchId,
    runtimeTurnId: null,
    outcome: null,
    retryOf: null,
    acceptedAtMs: nowMs,
    lastTransitionAtMs: nowMs,
  };

  const nextSnapshot: LifecycleSnapshot = {
    ...snapshot,
    outstandingWork: [...snapshot.outstandingWork, record],
  };

  return { snapshot: nextSnapshot, record };
}

export function markDispatched(record: WorkRecord, batchId: string, nowMs: number): WorkRecord {
  return transition(record, 'dispatched', nowMs, { batchId });
}

export function markRuntimeAccepted(record: WorkRecord, runtimeTurnId: string, nowMs: number): WorkRecord {
  return transition(record, 'runtime-accepted', nowMs, { runtimeTurnId });
}

export function markExecuting(record: WorkRecord, nowMs: number): WorkRecord {
  return transition(record, 'executing', nowMs);
}

export function complete(record: WorkRecord, outcome: string, nowMs: number): WorkRecord {
  return transition(record, 'completed', nowMs, { outcome });
}

export function fail(record: WorkRecord, outcome: string, nowMs: number): WorkRecord {
  return transition(record, 'failed', nowMs, { outcome });
}

export function cancel(record: WorkRecord, reason: string, nowMs: number): WorkRecord {
  return transition(record, 'cancelled', nowMs, { outcome: reason });
}

export function needsReview(record: WorkRecord, reason: string, nowMs: number): WorkRecord {
  return transition(record, 'needs-review', nowMs, { outcome: reason });
}

/**
 * Returns a copy of `retryRecord` linked to `originalWorkId` via `retryOf`.
 * Does not look anything up in a snapshot — the caller is responsible for
 * constructing `retryRecord` via `accept()` first (a deliberate retry is
 * always a NEW `workId`, never a mutation of the original terminal record).
 */
export function linkRetry(originalWorkId: string, retryRecord: WorkRecord): WorkRecord {
  return { ...retryRecord, retryOf: originalWorkId };
}

/**
 * Work that is not yet resolved. `needs-review` counts as outstanding — it is
 * an unresolved-with-uncertain-outcome state that the wedge detector (3.6)
 * and Scenario A replay (3.9) must be able to see.
 */
export function outstandingWork(snapshot: LifecycleSnapshot): WorkRecord[] {
  return snapshot.outstandingWork.filter(
    (r) => r.phase !== 'completed' && r.phase !== 'failed' && r.phase !== 'cancelled',
  );
}

/**
 * Bounds terminal (`completed`/`failed`/`cancelled`) history to the newest
 * `maxRetained` records (by `lastTransitionAtMs` descending). Every
 * `needs-review` record and every non-terminal record is always retained
 * regardless of count — archival never expires unresolved work.
 */
export function archiveTerminal(snapshot: LifecycleSnapshot, maxRetained: number): WorkRecord[] {
  const terminal: WorkRecord[] = [];
  const retainedAlways: WorkRecord[] = [];

  for (const record of snapshot.outstandingWork) {
    if (TERMINAL_PHASES.has(record.phase)) {
      terminal.push(record);
    } else {
      retainedAlways.push(record);
    }
  }

  terminal.sort((a, b) => b.lastTransitionAtMs - a.lastTransitionAtMs);
  const keptTerminal = terminal.slice(0, Math.max(0, maxRetained));

  return [...retainedAlways, ...keptTerminal];
}
