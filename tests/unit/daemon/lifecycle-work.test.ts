import { describe, expect, it } from 'vitest';
import {
  accept,
  archiveTerminal,
  cancel,
  complete,
  fail,
  linkRetry,
  markDispatched,
  markExecuting,
  markRuntimeAccepted,
  needsReview,
  outstandingWork,
} from '../../../src/daemon/lifecycle/work-ledger';
import type { GenerationToken, LifecycleSnapshot, WorkRecord } from '../../../src/daemon/lifecycle/types';

function makeOwner(generation = 1): GenerationToken {
  return { agentId: 'default/clearworks/knox', supervisorEpoch: 1, generation };
}

function makeSnapshot(outstandingWork: WorkRecord[] = []): LifecycleSnapshot {
  return {
    agentId: 'default/clearworks/knox',
    schemaVersion: 1,
    revision: 1,
    supervisorEpoch: 1,
    desiredState: 'running',
    desiredStateReason: null,
    desiredStateRequestId: null,
    intentRevision: 1,
    currentGeneration: 1,
    nextGeneration: 2,
    phase: 'ready',
    resources: [],
    retiringResources: [],
    outstandingWork,
    pendingRequests: [],
    recoveryBudgets: {},
    blockedReason: null,
  };
}

describe('work-ledger: happy path', () => {
  it('accept -> markDispatched -> markRuntimeAccepted -> markExecuting -> complete', () => {
    const snapshot = makeSnapshot();
    const owner = makeOwner();

    const acceptResult = accept(
      snapshot,
      { sourceKey: 'telegram:123', payloadDigest: 'digest-a', payloadRef: 'ref-a', batchId: null },
      owner,
      'work-1',
      1000,
    );
    if ('conflict' in acceptResult) throw new Error('expected new record');
    expect(acceptResult.record.phase).toBe('accepted');
    expect(acceptResult.record.lastTransitionAtMs).toBe(1000);
    expect(acceptResult.snapshot.outstandingWork).toHaveLength(1);

    const dispatched = markDispatched(acceptResult.record, 'batch-1', 1100);
    expect(dispatched.phase).toBe('dispatched');
    expect(dispatched.batchId).toBe('batch-1');
    expect(dispatched.lastTransitionAtMs).toBe(1100);

    const runtimeAccepted = markRuntimeAccepted(dispatched, 'turn-1', 1200);
    expect(runtimeAccepted.phase).toBe('runtime-accepted');
    expect(runtimeAccepted.runtimeTurnId).toBe('turn-1');
    expect(runtimeAccepted.lastTransitionAtMs).toBe(1200);

    const executing = markExecuting(runtimeAccepted, 1300);
    expect(executing.phase).toBe('executing');
    expect(executing.lastTransitionAtMs).toBe(1300);

    const completed = complete(executing, 'ok', 1400);
    expect(completed.phase).toBe('completed');
    expect(completed.outcome).toBe('ok');
    expect(completed.lastTransitionAtMs).toBe(1400);

    // never mutated the original record objects along the way
    expect(acceptResult.record.phase).toBe('accepted');
    expect(dispatched.phase).toBe('dispatched');
    expect(runtimeAccepted.phase).toBe('runtime-accepted');
    expect(executing.phase).toBe('executing');
  });
});

describe('work-ledger: illegal transitions', () => {
  it('complete() on an already-completed record throws', () => {
    const owner = makeOwner();
    const record: WorkRecord = {
      workId: 'w-1',
      sourceKey: 'k-1',
      payloadDigest: 'd-1',
      payloadRef: 'r-1',
      owner,
      phase: 'completed',
      batchId: null,
      runtimeTurnId: null,
      outcome: 'ok',
      retryOf: null,
      acceptedAtMs: 1,
      lastTransitionAtMs: 2,
    };
    expect(() => complete(record, 'ok-again', 3)).toThrow(/completed.*executing|illegal transition/i);
  });

  it('markExecuting() on an accepted (not yet dispatched) record throws', () => {
    const owner = makeOwner();
    const record: WorkRecord = {
      workId: 'w-2',
      sourceKey: 'k-2',
      payloadDigest: 'd-2',
      payloadRef: 'r-2',
      owner,
      phase: 'accepted',
      batchId: null,
      runtimeTurnId: null,
      outcome: null,
      retryOf: null,
      acceptedAtMs: 1,
      lastTransitionAtMs: 1,
    };
    expect(() => markExecuting(record, 2)).toThrow(/illegal transition/i);
  });

  it('cancel() on a needs-review record throws', () => {
    const owner = makeOwner();
    const record: WorkRecord = {
      workId: 'w-3',
      sourceKey: 'k-3',
      payloadDigest: 'd-3',
      payloadRef: 'r-3',
      owner,
      phase: 'needs-review',
      batchId: null,
      runtimeTurnId: null,
      outcome: 'unclear',
      retryOf: null,
      acceptedAtMs: 1,
      lastTransitionAtMs: 2,
    };
    expect(() => cancel(record, 'stop', 3)).toThrow(/illegal transition/i);
  });
});

describe('work-ledger: accept sourceKey semantics', () => {
  it('same sourceKey, different payloadDigest -> conflict, no new record created', () => {
    const owner = makeOwner();
    const first = accept(
      makeSnapshot(),
      { sourceKey: 'telegram:123', payloadDigest: 'digest-a', payloadRef: 'ref-a', batchId: null },
      owner,
      'work-1',
      1000,
    );
    if ('conflict' in first) throw new Error('expected new record on first accept');

    const second = accept(
      first.snapshot,
      { sourceKey: 'telegram:123', payloadDigest: 'digest-b', payloadRef: 'ref-b', batchId: null },
      owner,
      'work-2',
      1100,
    );

    expect('conflict' in second).toBe(true);
    if (!('conflict' in second)) throw new Error('expected conflict');
    expect(second.existing.workId).toBe('work-1');
    expect(first.snapshot.outstandingWork).toHaveLength(1);
  });

  it('same sourceKey and same payloadDigest -> duplicate, existing record returned unchanged', () => {
    const owner = makeOwner();
    const first = accept(
      makeSnapshot(),
      { sourceKey: 'telegram:123', payloadDigest: 'digest-a', payloadRef: 'ref-a', batchId: null },
      owner,
      'work-1',
      1000,
    );
    if ('conflict' in first) throw new Error('expected new record on first accept');

    const second = accept(
      first.snapshot,
      { sourceKey: 'telegram:123', payloadDigest: 'digest-a', payloadRef: 'ref-a', batchId: null },
      owner,
      'work-2',
      1100,
    );

    if ('conflict' in second) throw new Error('expected duplicate, not conflict');
    expect(second.record.workId).toBe('work-1');
    expect(second.record.lastTransitionAtMs).toBe(1000); // untouched, not bumped to 1100
    expect(second.snapshot.outstandingWork).toHaveLength(1); // no new record appended
  });
});

describe('work-ledger: batch mapping', () => {
  it('a batch of 3 inputs independently reaches its own terminal outcome, sharing batchId', () => {
    const owner = makeOwner();
    let snapshot = makeSnapshot();

    const inputs = [
      { sourceKey: 'a', payloadDigest: 'da', payloadRef: 'ra' },
      { sourceKey: 'b', payloadDigest: 'db', payloadRef: 'rb' },
      { sourceKey: 'c', payloadDigest: 'dc', payloadRef: 'rc' },
    ];

    const accepted: WorkRecord[] = [];
    inputs.forEach((input, i) => {
      const result = accept(snapshot, { ...input, batchId: null }, owner, `work-${i}`, 1000);
      if ('conflict' in result) throw new Error('unexpected conflict');
      snapshot = result.snapshot;
      accepted.push(result.record);
    });

    const batchId = 'batch-xyz';
    const dispatched = accepted.map((r) => markDispatched(r, batchId, 1100));
    expect(dispatched.every((r) => r.batchId === batchId)).toBe(true);

    const runtimeAccepted = dispatched.map((r) => markRuntimeAccepted(r, 'turn-1', 1200));
    const executing = runtimeAccepted.map((r) => markExecuting(r, 1300));

    const done = complete(executing[0]!, 'ok', 1400);
    const failed = fail(executing[1]!, 'boom', 1400);
    const cancelled = cancel(executing[2]!, 'stopped', 1400);

    expect(done.phase).toBe('completed');
    expect(failed.phase).toBe('failed');
    expect(cancelled.phase).toBe('cancelled');
    expect([done.batchId, failed.batchId, cancelled.batchId]).toEqual([batchId, batchId, batchId]);
  });
});

describe('work-ledger: archiveTerminal', () => {
  it('bounds terminal history to maxRetained, always retains needs-review and non-terminal', () => {
    const owner = makeOwner();
    const base = {
      sourceKey: 'k',
      payloadDigest: 'd',
      payloadRef: 'r',
      owner,
      batchId: null,
      runtimeTurnId: null,
      retryOf: null,
      acceptedAtMs: 0,
    };

    const terminal1: WorkRecord = { ...base, workId: 't1', sourceKey: 'k1', phase: 'completed', outcome: 'ok', lastTransitionAtMs: 100 };
    const terminal2: WorkRecord = { ...base, workId: 't2', sourceKey: 'k2', phase: 'failed', outcome: 'bad', lastTransitionAtMs: 200 };
    const terminal3: WorkRecord = { ...base, workId: 't3', sourceKey: 'k3', phase: 'cancelled', outcome: 'stopped', lastTransitionAtMs: 300 };
    const review: WorkRecord = { ...base, workId: 'r1', sourceKey: 'k4', phase: 'needs-review', outcome: 'unclear', lastTransitionAtMs: 50 };
    const running: WorkRecord = { ...base, workId: 'e1', sourceKey: 'k5', phase: 'executing', outcome: null, lastTransitionAtMs: 60 };

    const snapshot = makeSnapshot([terminal1, terminal2, terminal3, review, running]);
    const archived = archiveTerminal(snapshot, 1);

    const ids = archived.map((r) => r.workId).sort();
    // newest terminal record (t3, lastTransitionAtMs=300) retained; t1/t2 dropped
    expect(ids).toEqual(['e1', 'r1', 't3']);
  });
});

describe('work-ledger: outstandingWork', () => {
  it('includes needs-review and excludes completed/failed/cancelled', () => {
    const owner = makeOwner();
    const base = {
      sourceKey: 'k',
      payloadDigest: 'd',
      payloadRef: 'r',
      owner,
      batchId: null,
      runtimeTurnId: null,
      retryOf: null,
      acceptedAtMs: 0,
      lastTransitionAtMs: 0,
    };
    const records: WorkRecord[] = [
      { ...base, workId: 'w1', phase: 'accepted', outcome: null },
      { ...base, workId: 'w2', phase: 'dispatched', outcome: null },
      { ...base, workId: 'w3', phase: 'runtime-accepted', outcome: null },
      { ...base, workId: 'w4', phase: 'executing', outcome: null },
      { ...base, workId: 'w5', phase: 'needs-review', outcome: 'unclear' },
      { ...base, workId: 'w6', phase: 'completed', outcome: 'ok' },
      { ...base, workId: 'w7', phase: 'failed', outcome: 'bad' },
      { ...base, workId: 'w8', phase: 'cancelled', outcome: 'stopped' },
    ];
    const snapshot = makeSnapshot(records);
    const ids = outstandingWork(snapshot).map((r) => r.workId).sort();
    expect(ids).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });
});

describe('work-ledger: stale-generation isolation', () => {
  it('transitioning a generation-1 record never touches a generation-2 record object', () => {
    const gen1 = makeOwner(1);
    const gen2 = makeOwner(2);
    const base = {
      sourceKey: 'same-source-key',
      payloadDigest: 'd',
      payloadRef: 'r',
      batchId: null,
      runtimeTurnId: null,
      retryOf: null,
      acceptedAtMs: 0,
      lastTransitionAtMs: 0,
      outcome: null,
    };
    const gen1Record: WorkRecord = { ...base, workId: 'w-gen1', owner: gen1, phase: 'accepted' };
    const gen2Record: WorkRecord = { ...base, workId: 'w-gen2', owner: gen2, phase: 'accepted' };

    const gen2Snapshot = JSON.parse(JSON.stringify(gen2Record));

    cancel(gen1Record, 'stale generation superseded', 500);

    expect(gen2Record).toEqual(gen2Snapshot);
    expect(gen2Record.phase).toBe('accepted');
  });
});

describe('work-ledger: linkRetry', () => {
  it('sets retryOf on a new record without mutating the original terminal record', () => {
    const owner = makeOwner();
    const original: WorkRecord = {
      workId: 'orig-1',
      sourceKey: 'k-orig',
      payloadDigest: 'd-orig',
      payloadRef: 'r-orig',
      owner,
      phase: 'failed',
      batchId: null,
      runtimeTurnId: null,
      outcome: 'boom',
      retryOf: null,
      acceptedAtMs: 1,
      lastTransitionAtMs: 2,
    };
    const snapshot = makeSnapshot([original]);
    const retryResult = accept(
      snapshot,
      { sourceKey: 'k-retry', payloadDigest: 'd-retry', payloadRef: 'r-retry', batchId: null },
      owner,
      'retry-1',
      1000,
    );
    if ('conflict' in retryResult) throw new Error('unexpected conflict');

    const linked = linkRetry('orig-1', retryResult.record);
    expect(linked.retryOf).toBe('orig-1');
    expect(linked.workId).toBe('retry-1');
    expect(original.retryOf).toBeNull();
    expect(original.phase).toBe('failed');
  });
});
