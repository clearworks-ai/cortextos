import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index';
import type { LifecycleSnapshot, WorkRecord } from '../../../src/daemon/lifecycle/types';
import { LifecycleStateStore, SCHEMA_VERSION } from '../../../src/daemon/lifecycle/state-store';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../../src/daemon/lifecycle/supervisor';

/**
 * Task 3.2: store/supervisor-level tests for `acceptBatch`/`outstandingWork`
 * (Task 3.1's pure `work-ledger.ts` functions already have their own
 * pure-function test coverage in `lifecycle-work.test.ts`). These tests
 * exercise the real durable store + real store lock via a temp fixture
 * root -- never `~/.cortextos/`.
 */

function fakeBusPaths(ctxRoot: string, agentName: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(ctxRoot, 'orgs', 'x', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'x', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'x', 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', 'x', 'deliverables'),
  };
}

function recordPath(paths: BusPaths): string {
  return join(paths.stateDir, 'lifecycle', 'supervisor.json');
}

/** Never actually invoked by any test here -- `acceptBatch`/`outstandingWork`
 * never touch the RuntimeAdapter -- but `AgentLifecycleSupervisor`'s
 * constructor requires one. */
function makeUnusedRuntime(): RuntimeAdapter {
  return {
    async startGeneration() {
      throw new Error('unexpected startGeneration call in a work-store test');
    },
    async retireGeneration() {
      throw new Error('unexpected retireGeneration call in a work-store test');
    },
    async deliver() {
      throw new Error('unexpected deliver call in a work-store test');
    },
  };
}

describe('AgentLifecycleSupervisor.acceptBatch / outstandingWork', () => {
  let ctxRoot: string;
  let paths: BusPaths;
  const agentId = 'default/clearworks/knox';

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-work-store-test-'));
    paths = fakeBusPaths(ctxRoot, 'knox');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('accepts 3 fresh inputs; a fresh reload sees exactly those 3 records', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeUnusedRuntime());

    const result = await supervisor.acceptBatch([
      { sourceKey: 'telegram:1', payload: 'payload-1', payloadDigest: 'digest-1' },
      { sourceKey: 'telegram:2', payload: 'payload-2', payloadDigest: 'digest-2' },
      { sourceKey: 'telegram:3', payload: 'payload-3', payloadDigest: 'digest-3' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workIds).toHaveLength(3);
    expect(new Set(result.workIds).size).toBe(3);

    // Fresh reload: a brand-new store/supervisor pair over the same paths,
    // with no in-memory cache of its own.
    const reloadedStore = new LifecycleStateStore(paths, agentId);
    const reloadedSupervisor = new AgentLifecycleSupervisor(agentId, reloadedStore, makeUnusedRuntime());

    const outstanding = reloadedSupervisor.outstandingWork();
    expect(outstanding).toHaveLength(3);

    const bySourceKey = new Map(outstanding.map((r) => [r.sourceKey, r]));
    expect(bySourceKey.get('telegram:1')?.payloadDigest).toBe('digest-1');
    expect(bySourceKey.get('telegram:2')?.payloadDigest).toBe('digest-2');
    expect(bySourceKey.get('telegram:3')?.payloadDigest).toBe('digest-3');
    for (const record of outstanding) {
      expect(record.batchId).toBe(result.batchId);
      expect(result.workIds).toContain(record.workId);
      expect(record.phase).toBe('accepted');
    }
  });

  it('a simulated persist (commit) failure returns ok:false and leaves nothing recorded', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    // Pre-adopt BEFORE installing the spy so the adoption write itself
    // (a separate atomicWriteDurableSync call, unrelated to this test) never
    // interferes with the fault we're injecting.
    const adopted = store.adopt('stopped');
    expect(adopted.ok).toBe(true);

    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeUnusedRuntime());

    const atomicModule = await import('../../../src/utils/atomic');
    const original = atomicModule.atomicWriteDurableSync;
    const spy = vi.spyOn(atomicModule, 'atomicWriteDurableSync').mockImplementation((filePath: string, data: string) => {
      if (filePath.endsWith('supervisor.json')) {
        throw new Error('simulated disk failure (snapshot commit)');
      }
      return original(filePath, data);
    });

    let result: Awaited<ReturnType<typeof supervisor.acceptBatch>>;
    try {
      result = await supervisor.acceptBatch([
        { sourceKey: 'telegram:1', payload: 'payload-1', payloadDigest: 'digest-1' },
        { sourceKey: 'telegram:2', payload: 'payload-2', payloadDigest: 'digest-2' },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/PERSIST_FAILED/);

    const loaded = store.load();
    expect('corrupt' in loaded).toBe(false);
    expect((loaded as LifecycleSnapshot).outstandingWork).toHaveLength(0);
  });

  it('a payload-write failure for one of 3 inputs aborts the whole batch -- zero records committed', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const adopted = store.adopt('stopped');
    expect(adopted.ok).toBe(true);

    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeUnusedRuntime());

    const atomicModule = await import('../../../src/utils/atomic');
    const original = atomicModule.atomicWriteDurableSync;
    let callIndex = 0;
    const spy = vi.spyOn(atomicModule, 'atomicWriteDurableSync').mockImplementation((filePath: string, data: string) => {
      const idx = callIndex;
      callIndex += 1;
      // The 2nd payload write (of 3) fails; the commit() write must never
      // even be attempted since acceptBatch aborts before reaching it.
      if (idx === 1) {
        throw new Error('simulated disk failure (payload write)');
      }
      return original(filePath, data);
    });

    let result: Awaited<ReturnType<typeof supervisor.acceptBatch>>;
    try {
      result = await supervisor.acceptBatch([
        { sourceKey: 'telegram:1', payload: 'payload-1', payloadDigest: 'digest-1' },
        { sourceKey: 'telegram:2', payload: 'payload-2', payloadDigest: 'digest-2' },
        { sourceKey: 'telegram:3', payload: 'payload-3', payloadDigest: 'digest-3' },
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/payload write failed/);
    // Only 2 of the planned 3 payload writes were ever attempted (the 3rd
    // input's payload write never happens once the 2nd fails).
    expect(callIndex).toBe(2);

    const loaded = store.load();
    expect('corrupt' in loaded).toBe(false);
    expect((loaded as LifecycleSnapshot).outstandingWork).toHaveLength(0);
  });

  it('upgrades a hand-constructed Phase-1-shaped snapshot (missing outstandingWork) cleanly, then accepts against it', async () => {
    mkdirSync(join(paths.stateDir, 'lifecycle'), { recursive: true });
    const phase1Snapshot: Record<string, unknown> = {
      agentId,
      schemaVersion: 1,
      revision: 3,
      supervisorEpoch: 1,
      desiredState: 'running',
      desiredStateReason: null,
      desiredStateRequestId: null,
      intentRevision: 0,
      currentGeneration: 1,
      nextGeneration: 2,
      phase: 'ready',
      resources: [],
      retiringResources: [],
      // Deliberately OMITTED -- a genuinely Phase-1-shaped record predates
      // this field entirely, not just as `[]`.
      pendingRequests: [],
      recoveryBudgets: {},
      blockedReason: null,
    };
    writeFileSync(recordPath(paths), JSON.stringify(phase1Snapshot));

    const store = new LifecycleStateStore(paths, agentId);
    const loaded = store.load();
    expect('corrupt' in loaded).toBe(false);
    const snapshot = loaded as LifecycleSnapshot;
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snapshot.outstandingWork).toEqual([]);
    expect(snapshot.revision).toBe(3); // upgrade never bumps revision on its own

    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeUnusedRuntime());
    const result = await supervisor.acceptBatch([{ sourceKey: 'telegram:1', payload: 'p', payloadDigest: 'd1' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workIds).toHaveLength(1);

    const reloaded = store.load();
    expect('corrupt' in reloaded).toBe(false);
    const reloadedSnapshot = reloaded as LifecycleSnapshot;
    expect(reloadedSnapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(reloadedSnapshot.outstandingWork).toHaveLength(1);
    expect(reloadedSnapshot.outstandingWork[0]?.sourceKey).toBe('telegram:1');
  });

  it('a duplicate resubmission (same sourceKey + payloadDigest) in a later batch returns the existing workId, not a new record', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeUnusedRuntime());

    const first = await supervisor.acceptBatch([{ sourceKey: 'telegram:1', payload: 'payload-1', payloadDigest: 'digest-1' }]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalWorkId = first.workIds[0];

    const second = await supervisor.acceptBatch([
      { sourceKey: 'telegram:1', payload: 'payload-1', payloadDigest: 'digest-1' }, // duplicate
      { sourceKey: 'telegram:2', payload: 'payload-2', payloadDigest: 'digest-2' }, // fresh
    ]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.workIds).toHaveLength(2);
    expect(second.workIds).toContain(originalWorkId);

    const outstanding = supervisor.outstandingWork();
    expect(outstanding).toHaveLength(2);
    const bySourceKey = new Map(outstanding.map((r: WorkRecord) => [r.sourceKey, r]));
    expect(bySourceKey.get('telegram:1')?.workId).toBe(originalWorkId);
  });

  it('a conflict (same sourceKey, different payloadDigest) aborts the ENTIRE batch, not just the conflicting input', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeUnusedRuntime());

    const first = await supervisor.acceptBatch([{ sourceKey: 'telegram:1', payload: 'payload-1', payloadDigest: 'digest-1' }]);
    expect(first.ok).toBe(true);

    const second = await supervisor.acceptBatch([
      { sourceKey: 'telegram:1', payload: 'payload-1-changed', payloadDigest: 'digest-1-DIFFERENT' }, // conflict
      { sourceKey: 'telegram:2', payload: 'payload-2', payloadDigest: 'digest-2' }, // otherwise-fresh, must NOT land either
    ]);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/conflict|already accepted/i);

    const outstanding = supervisor.outstandingWork();
    // Only the original telegram:1 record exists -- telegram:2 never landed.
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.sourceKey).toBe('telegram:1');
    expect(outstanding[0]?.payloadDigest).toBe('digest-1');
  });
});
