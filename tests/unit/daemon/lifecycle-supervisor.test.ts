import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index';
import type { GenerationToken, LifecycleRequest, OwnedResource, RetirementResult } from '../../../src/daemon/lifecycle/types';
import { LifecycleStateStore } from '../../../src/daemon/lifecycle/state-store';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../../src/daemon/lifecycle/supervisor';

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

let reqCounter = 0;
function req(overrides: Partial<LifecycleRequest> & Pick<LifecycleRequest, 'kind' | 'cause'>): LifecycleRequest {
  reqCounter += 1;
  return {
    requestId: `req-${reqCounter}`,
    mode: null,
    observedGeneration: null,
    userInitiated: false,
    evidence: {},
    requestedAtMs: Date.now(),
    ...overrides,
  };
}

/** Controllable fake RuntimeAdapter: each call's promise is held open until
 * the test explicitly resolves it via the returned control handles. */
function makeControllableRuntime(): RuntimeAdapter & {
  resolveStart: (result: { ok: boolean; resources: OwnedResource[]; error?: string }) => void;
  resolveRetire: (result: RetirementResult) => void;
  startCalls: Array<{ effect: unknown; mode: string }>;
  retireCalls: Array<{ token: GenerationToken; resources: OwnedResource[] }>;
} {
  let startResolve: ((r: { ok: boolean; resources: OwnedResource[]; error?: string }) => void) | null = null;
  let retireResolve: ((r: RetirementResult) => void) | null = null;
  const startCalls: Array<{ effect: unknown; mode: string }> = [];
  const retireCalls: Array<{ token: GenerationToken; resources: OwnedResource[] }> = [];

  return {
    startCalls,
    retireCalls,
    async startGeneration(effect, mode) {
      startCalls.push({ effect, mode });
      return new Promise((resolve) => {
        startResolve = resolve;
      });
    },
    async retireGeneration(token, resources) {
      retireCalls.push({ token, resources });
      return new Promise((resolve) => {
        retireResolve = resolve;
      });
    },
    async deliver() {
      return { ok: true, workIds: [], batchId: 'unused' };
    },
    resolveStart(result) {
      if (!startResolve) throw new Error('no pending startGeneration call to resolve');
      startResolve(result);
      startResolve = null;
    },
    resolveRetire(result) {
      if (!retireResolve) throw new Error('no pending retireGeneration call to resolve');
      retireResolve(result);
      retireResolve = null;
    },
  };
}

/** Immediate fake RuntimeAdapter -- resolves synchronously (well, on the
 * next microtask) with caller-supplied canned results. */
function makeImmediateRuntime(opts?: {
  start?: (effect: unknown, mode: string) => { ok: boolean; resources: OwnedResource[]; error?: string };
  retire?: (token: GenerationToken, resources: OwnedResource[]) => RetirementResult;
}): RuntimeAdapter {
  return {
    async startGeneration(effect, mode) {
      return opts?.start ? opts.start(effect, mode) : { ok: true, resources: [] };
    },
    async retireGeneration(token, resources) {
      return opts?.retire ? opts.retire(token, resources) : { status: 'retired', released: resources };
    },
    async deliver() {
      return { ok: true, workIds: [], batchId: 'unused' };
    },
  };
}

async function flush(): Promise<void> {
  // Drain a handful of microtask ticks so chained .then()/await continuations
  // (mailbox flush -> commit -> effect dispatch -> internal awaits) settle.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('AgentLifecycleSupervisor', () => {
  let ctxRoot: string;
  let paths: BusPaths;
  const agentId = 'default/clearworks/knox';

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-supervisor-test-'));
    paths = fakeBusPaths(ctxRoot, 'knox');
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('stop committed while startGeneration is mid-await -> zero successor spawns, durable stopped after reload', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    const startReceipt = await supervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));
    expect(startReceipt.accepted).toBe(true);
    expect(startReceipt.generation).toBe(1);
    expect(runtime.startCalls).toHaveLength(1);

    const stopReceipt = await supervisor.request(req({ kind: 'stop', cause: 'manual-cli' }));
    expect(stopReceipt.accepted).toBe(true);
    expect(stopReceipt.desiredState).toBe('stopped');

    // Now let the stale startGeneration call resolve successfully.
    runtime.resolveStart({ ok: true, resources: [makeResource('r1', agentId, 1)] });
    await flush();

    expect(runtime.startCalls).toHaveLength(1); // zero successor spawns

    const reloaded = store.load();
    expect('corrupt' in reloaded).toBe(false);
    if ('corrupt' in reloaded) return;
    expect(reloaded.desiredState).toBe('stopped');
  });

  it('refresh request whose observedGeneration is stale -> rejected as revoked', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeImmediateRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    await supervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));
    await flush();

    const receipt = await supervisor.request(req({ kind: 'refresh', cause: 'manual-cli', observedGeneration: 999 }));
    expect(receipt.accepted).toBe(false);
    expect(receipt.blockedReason).toMatch(/revoked/);
  });

  it('two equivalent same-generation requests coalesce into one operation with both requestIds in coalescedWith', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    const reqA = req({ kind: 'start', cause: 'manual-cli', mode: 'continue' });
    const reqB = req({ kind: 'start', cause: 'manual-cli', mode: 'continue' });

    const [receiptA, receiptB] = await Promise.all([supervisor.request(reqA), supervisor.request(reqB)]);

    expect(receiptA.operationId).toBe(receiptB.operationId);
    expect(receiptA.coalescedWith).toContain(reqB.requestId);
    expect(receiptB.coalescedWith).toContain(reqA.requestId);

    const op = supervisor.operation(receiptA.operationId);
    expect(op).not.toBeNull();
    expect(op!.coalescedWith).toEqual(expect.arrayContaining([reqA.requestId, reqB.requestId]));
  });

  it('fresh-intent stickiness: fresh request followed by generic continue request still starts fresh', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    const freshReceipt = await supervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'fresh' }));
    expect(freshReceipt.accepted).toBe(true);
    expect(runtime.startCalls).toHaveLength(1);
    expect(runtime.startCalls[0].mode).toBe('fresh');

    // The first start's runtime call is still pending (mid-await); its
    // pendingRequests fresh marker has not been consumed yet. A second,
    // generic 'continue' restart request must still observe 'fresh'.
    const continueReceipt = await supervisor.request(req({ kind: 'restart', cause: 'crash', mode: 'continue' }));
    expect(continueReceipt.accepted).toBe(true);

    // retireGeneration was called for the outgoing (gen 1) resources as
    // part of the restart chain; resolve it so the chain proceeds to start.
    expect(runtime.retireCalls).toHaveLength(1);
    runtime.resolveRetire({ status: 'retired', released: [] });
    await flush();

    expect(runtime.startCalls).toHaveLength(2);
    expect(runtime.startCalls[1].mode).toBe('fresh');
  });

  it('arbitration: context-hard-full (5) and session-age (3) in the same window -> proceeds under context-hard-full, both retained, session-age budget charged despite losing', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    const highSev = req({ kind: 'start', cause: 'context-hard-full', mode: 'continue' });
    const lowSev = req({ kind: 'start', cause: 'session-age', mode: 'continue' });

    const [highReceipt, lowReceipt] = await Promise.all([supervisor.request(highSev), supervisor.request(lowSev)]);

    expect(highReceipt.operationId).toBe(lowReceipt.operationId);
    expect(highReceipt.coalescedWith).toContain(lowSev.requestId);
    expect(lowReceipt.coalescedWith).toContain(highSev.requestId);

    // The winning cause's mode/cause drives the operation: exactly one
    // startGeneration call was issued (the coalesced operation), not two.
    expect(runtime.startCalls).toHaveLength(1);

    const snap = supervisor.snapshot();
    expect(snap.recoveryBudgets['session-age']).toBeDefined();
    expect(snap.recoveryBudgets['session-age'].count).toBe(1);
  });

  it('arbitration tie: two same-severity autonomous causes -> deterministic first-observed tiebreak, both retained', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    const first = req({ kind: 'start', cause: 'context-hard-full', mode: 'continue' }); // severity 5
    const second = req({ kind: 'start', cause: 'image-poison', mode: 'continue' }); // severity 5, later seq

    const [firstReceipt, secondReceipt] = await Promise.all([supervisor.request(first), supervisor.request(second)]);

    expect(firstReceipt.operationId).toBe(secondReceipt.operationId);
    expect(firstReceipt.coalescedWith).toContain(second.requestId);
    expect(secondReceipt.coalescedWith).toContain(first.requestId);

    const snap = supervisor.snapshot();
    expect(snap.recoveryBudgets['context-hard-full'].count).toBe(1);
    expect(snap.recoveryBudgets['image-poison'].count).toBe(1);
  });

  it('explicit stop always wins over any autonomous cause regardless of CAUSE_SEVERITY', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    // Get a generation running first.
    await supervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));
    runtime.resolveStart({ ok: true, resources: [] });
    await flush();

    // Low-severity stop (cause boot-self-heal, severity 1) vs high-severity
    // autonomous crash (severity 6) in the same window: stop must still win.
    const stopReq = req({ kind: 'stop', cause: 'boot-self-heal' });
    const crashReq = req({ kind: 'restart', cause: 'crash', mode: 'continue' });

    const [stopReceipt, crashReceipt] = await Promise.all([supervisor.request(stopReq), supervisor.request(crashReq)]);

    expect(stopReceipt.desiredState).toBe('stopped');
    expect(crashReceipt.desiredState).toBe('stopped');
    expect(stopReceipt.operationId).toBe(crashReceipt.operationId);

    const snap = supervisor.snapshot();
    expect(snap.desiredState).toBe('stopped');
  });

  it('retireGeneration returning blocked -> no replacement spawn, snapshot shows unresolved resources', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const unresolved = [makeResource('stuck-1', agentId, 1)];
    const runtime = makeImmediateRuntime({
      retire: () => ({ status: 'blocked', released: [], unresolved, reason: 'descendant still alive' }),
    });
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    // Start with some resources so there's something to retire.
    const startRuntime = makeImmediateRuntime({ start: () => ({ ok: true, resources: [makeResource('r1', agentId, 1)] }) });
    const bootSupervisor = new AgentLifecycleSupervisor(agentId, store, startRuntime);
    await bootSupervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));
    await flush();

    const stopReceipt = await supervisor.request(req({ kind: 'stop', cause: 'manual-cli' }));
    expect(stopReceipt.accepted).toBe(true);
    await flush();

    const snapAfterBlock = supervisor.snapshot();
    expect(snapAfterBlock.phase).toBe('blocked');
    expect(snapAfterBlock.blockedReason).toBe('descendant still alive');
    expect(snapAfterBlock.retiringResources.map((r) => r.resourceId)).toContain('stuck-1');

    const replacementRuntime = makeImmediateRuntime();
    const replacementSupervisor = new AgentLifecycleSupervisor(agentId, store, replacementRuntime);
    const replacementReceipt = await replacementSupervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));

    expect(replacementReceipt.accepted).toBe(true);
    expect(replacementReceipt.phase).toBe('blocked');
    expect(replacementReceipt.blockedReason).toBe('descendant still alive');
  });

  it('persist failure during a stop commit -> no effect granted, receipt reports not-accepted', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeControllableRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    await supervisor.request(req({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));
    runtime.resolveStart({ ok: true, resources: [] });
    await flush();

    const commitSpy = store.commit.bind(store);
    let intercepted = false;
    store.commit = ((expected, mutate) => {
      if (!intercepted) {
        intercepted = true;
        return { ok: false, code: 'PERSIST_FAILED', message: 'disk full (simulated)' };
      }
      return commitSpy(expected, mutate);
    }) as typeof store.commit;

    const stopReceipt = await supervisor.request(req({ kind: 'stop', cause: 'manual-cli' }));
    expect(stopReceipt.accepted).toBe(false);
    expect(stopReceipt.blockedReason).toMatch(/PERSIST_FAILED/);
    expect(runtime.retireCalls).toHaveLength(0);
  });

  it('halted/quarantined desired state rejects every autonomous cause but accepts an explicit resume', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const runtime = makeImmediateRuntime();
    const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

    const haltReceipt = await supervisor.request(req({ kind: 'halt', cause: 'wedge-alert' }));
    expect(haltReceipt.desiredState).toBe('halted');

    const autonomousReceipt = await supervisor.request(req({ kind: 'restart', cause: 'crash', mode: 'continue' }));
    expect(autonomousReceipt.accepted).toBe(false);
    expect(autonomousReceipt.blockedReason).toMatch(/halted/);

    const resumeReceipt = await supervisor.request(req({ kind: 'resume', cause: 'manual-cli' }));
    expect(resumeReceipt.accepted).toBe(true);
    expect(resumeReceipt.desiredState).toBe('running');

    const snap = supervisor.snapshot();
    expect(snap.desiredState).toBe('running');
  });

  // Task 3.6 Step 3: the 50-minute idle-session watchdog publishes its tick
  // as an attributed, generation-bound observation — but it must never
  // advance the runtime work-progress clock (outstandingWork()/the ledger).
  describe('observe() — watchdog-heartbeat (Task 3.6)', () => {
    it('records the watchdog tick for introspection, generation-bound, without touching outstandingWork() or the ledger', async () => {
      const store = new LifecycleStateStore(paths, agentId);
      const runtime = makeImmediateRuntime();
      const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

      // Seed one real outstanding WorkRecord first, so we can prove the
      // watchdog observation leaves it untouched.
      const before = await supervisor.acceptBatch([
        { sourceKey: 'telegram-msg-1', payload: 'hello', payloadDigest: 'digest-1' },
      ]);
      expect(before.ok).toBe(true);
      const outstandingBefore = supervisor.outstandingWork();
      expect(outstandingBefore).toHaveLength(1);

      expect(supervisor.lastWatchdogHeartbeatObservation()).toBeNull();

      const token: GenerationToken = { agentId, supervisorEpoch: 0, generation: 1 };
      supervisor.observe({
        kind: 'watchdog-heartbeat',
        token,
        atMs: 123_456,
        evidence: { agentName: 'knox', note: 'daemon-observed-process-liveness-only-not-runtime-progress' },
      });

      const observed = supervisor.lastWatchdogHeartbeatObservation();
      expect(observed).not.toBeNull();
      expect(observed?.agentId).toBe(agentId);
      expect(observed?.generation).toBe(1);
      expect(observed?.atMs).toBe(123_456);
      expect(observed?.evidence.agentName).toBe('knox');

      // The watchdog observation must not have advanced/altered the
      // outstanding-work ledger in any way.
      const outstandingAfter = supervisor.outstandingWork();
      expect(outstandingAfter).toHaveLength(1);
      expect(outstandingAfter[0]).toEqual(outstandingBefore[0]);
      // ...nor the phase/desiredState/blockedReason surface.
      const snap = supervisor.snapshot();
      expect(snap.blockedReason).toBeNull();
    });

    it('a second watchdog tick overwrites the introspection value but still never touches outstandingWork()', async () => {
      const store = new LifecycleStateStore(paths, agentId);
      const runtime = makeImmediateRuntime();
      const supervisor = new AgentLifecycleSupervisor(agentId, store, runtime);

      supervisor.observe({
        kind: 'watchdog-heartbeat',
        token: { agentId, supervisorEpoch: 0, generation: 1 },
        atMs: 1_000,
        evidence: {},
      });
      supervisor.observe({
        kind: 'watchdog-heartbeat',
        token: { agentId, supervisorEpoch: 0, generation: 2 },
        atMs: 2_000,
        evidence: {},
      });

      const observed = supervisor.lastWatchdogHeartbeatObservation();
      expect(observed?.generation).toBe(2);
      expect(observed?.atMs).toBe(2_000);
      expect(supervisor.outstandingWork()).toHaveLength(0);
    });
  });
});

function makeResource(resourceId: string, agentId: string, generation: number): OwnedResource {
  return {
    resourceId,
    owner: { agentId, supervisorEpoch: 0, generation },
    kind: 'runtime',
    state: 'acquired',
    pid: null,
    processBirth: null,
    location: null,
  };
}
