import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { AgentConfig, BusPaths } from '../../src/types/index.js';
import { LifecycleStateStore, admitDaemonWriter } from '../../src/daemon/lifecycle/state-store.js';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../src/daemon/lifecycle/supervisor.js';
import { canonicalAgentId } from '../../src/daemon/lifecycle/types.js';
import type {
  DispatchResult,
  EffectToken,
  GenerationToken,
  LifecycleRequest,
  OwnedResource,
  RequestCause,
  RetirementResult,
  StartMode,
} from '../../src/daemon/lifecycle/types.js';

/**
 * Task 5.5: daemon crash, corrupt store, duplicate daemon writer, and
 * multi-agent concurrency -- proves the durability/admission story from
 * Tasks 1.2/1.4/2.5 under adversarial INFRASTRUCTURE conditions, not just
 * adversarial request orderings (Tasks 5.1-5.4's scope).
 *
 * Steps 1 (daemon crash/restart recovery) live in the EXTENDED
 * `lifecycle-invariants.test.ts` per this task's own file ("Files to
 * Modify"). This file covers Steps 2 (corrupt store, full boot path), 3
 * (full-disk/failed-persist), 4 (duplicate daemon writer), 5 (multi-agent
 * isolation), and 6 (crash between commit and effect).
 *
 * Fidelity level: Steps 3/4/6 drive the real `AgentLifecycleSupervisor`
 * (Task 1.5) + real `LifecycleStateStore`/`admitDaemonWriter` (Task 1.4)
 * directly over a temp fixture root, through a configurable fake
 * `RuntimeAdapter` -- the same level Task 5.1's `lifecycle-invariants.test.ts`
 * already established as legitimate. Steps 2/5 drive the real `AgentManager`
 * (Task 2.5) multi-agent registry end-to-end (real `AgentProcess`, real
 * `AgentLifecycleSupervisor`, real `AgentProcessRuntimeAdapter`, real
 * `LifecycleStateStore`) -- only the PTY spawn boundary and unrelated
 * Telegram/FastChecker/CronScheduler/WorkerProcess wiring are faked, mirroring
 * `tests/integration/lifecycle-manager.test.ts` (Task 2.5) exactly, because
 * this task's own text requires "driven through the full AgentManager/
 * supervisor boot path rather than calling `LifecycleStateStore.load()`
 * directly" for the corrupt-store case, and the multi-agent isolation case is
 * inherently about the real per-agent registry.
 */

// ---------------------------------------------------------------------------
// Shared fixtures (Steps 3/4/6 -- direct supervisor/store level)
// ---------------------------------------------------------------------------

function fakeBusPaths(ctxRoot: string, agentName: string, org: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(ctxRoot, 'orgs', org, 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', org, 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', org, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', org, 'deliverables'),
  };
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function oneResource(token: GenerationToken, kind: OwnedResource['kind'] = 'runtime'): OwnedResource {
  return {
    resourceId: `${token.agentId}#${kind}#${token.generation}`,
    owner: token,
    kind,
    state: 'acquired',
    pid: null,
    processBirth: null,
    location: null,
  };
}

class FakeRuntimeAdapter implements RuntimeAdapter {
  startGeneration = vi.fn(async (effect: EffectToken, _mode: StartMode) => ({
    ok: true as const,
    resources: [oneResource({ agentId: effect.agentId, supervisorEpoch: effect.supervisorEpoch, generation: effect.generation })],
  }));

  retireGeneration = vi.fn(async (_token: GenerationToken, resources: OwnedResource[]): Promise<RetirementResult> => ({
    status: 'retired' as const,
    released: resources.map((r) => ({ ...r, state: 'released' as const })),
  }));

  deliver = vi.fn(async (effect: EffectToken, _payload: string, workIds: string[]): Promise<DispatchResult> => ({
    ok: true as const,
    workIds,
    batchId: effect.effectId,
  }));
}

function mkReq(overrides: Partial<LifecycleRequest> & { kind: LifecycleRequest['kind']; cause: RequestCause }): LifecycleRequest {
  return {
    requestId: randomUUID(),
    mode: null,
    observedGeneration: null,
    userInitiated: true,
    evidence: {},
    requestedAtMs: Date.now(),
    ...overrides,
  };
}

const INSTANCE = 'recovery-boundaries-test';
const ORG = 'test';
const NAME = 'recovery-fixture';

let testDir: string;
let ctxRoot: string;
let paths: BusPaths;
let agentId: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-recovery-boundaries-'));
  ctxRoot = join(testDir, 'instance');
  paths = fakeBusPaths(ctxRoot, NAME, ORG);
  mkdirSync(paths.stateDir, { recursive: true });
  agentId = canonicalAgentId({ instanceId: INSTANCE, org: ORG, name: NAME });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

function freshSupervisor(adapter: RuntimeAdapter = new FakeRuntimeAdapter()): AgentLifecycleSupervisor {
  const store = new LifecycleStateStore(paths, agentId);
  return new AgentLifecycleSupervisor(agentId, store, adapter);
}

function reloadSnapshot(): ReturnType<LifecycleStateStore['load']> {
  const freshStore = new LifecycleStateStore(paths, agentId);
  return freshStore.load();
}

async function settleStart(supervisor: AgentLifecycleSupervisor, cause: RequestCause = 'manual-cli'): Promise<number> {
  const receipt = await supervisor.request(mkReq({ kind: 'start', cause, mode: 'continue' }));
  expect(receipt.accepted).toBe(true);
  await flush();
  return supervisor.snapshot().currentGeneration!;
}

// =============================================================================
// Step 3: full-disk / failed-persist
// =============================================================================

describe('Task 5.5 Step 3: full-disk / failed-persist', () => {
  it('an injected persist failure mid-commit fails closed: no effect is ever granted, and the in-memory snapshot is not advanced', async () => {
    const adapter = new FakeRuntimeAdapter();
    const supervisor = freshSupervisor(adapter);
    await settleStart(supervisor); // generation 1, ready
    expect(adapter.startGeneration).toHaveBeenCalledTimes(1);

    // Mock the durable-write primitive itself (same technique Task 1.4's own
    // `lifecycle-state-store.test.ts` uses) -- a permission-based simulation
    // would also break the LOCK acquire path, which needs to create/rename
    // directories under the same `lifecycle/` root as the write under test.
    const atomicModule = await import('../../src/utils/atomic.js');
    const spy = vi.spyOn(atomicModule, 'atomicWriteDurableSync').mockImplementation(() => {
      throw new Error('simulated ENOSPC: no space left on device');
    });

    let restartReceipt;
    try {
      restartReceipt = await supervisor.request(mkReq({ kind: 'restart', cause: 'manual-cli', mode: 'continue' }));
      await flush();
    } finally {
      spy.mockRestore();
    }

    expect(restartReceipt.accepted).toBe(false);
    expect(restartReceipt.blockedReason).toMatch(/PERSIST_FAILED/);

    // No effect was ever granted on the strength of the failed commit: the
    // runtime was never even asked to retire the old generation or spawn a
    // successor -- the commit failed BEFORE either effect call.
    expect(adapter.retireGeneration).not.toHaveBeenCalled();
    expect(adapter.startGeneration).toHaveBeenCalledTimes(1); // still just the original settleStart call

    // The in-memory snapshot reflects the OLD state, never a partially
    // applied one.
    const snap = supervisor.snapshot();
    expect(snap.currentGeneration).toBe(1);
    expect(snap.phase).toBe('ready');
    expect(snap.desiredState).toBe('running');

    // With the fault cleared, the store is provably intact -- the failed
    // attempt corrupted nothing.
    const reloaded = reloadSnapshot();
    expect('corrupt' in reloaded).toBe(false);
    if (!('corrupt' in reloaded)) {
      expect(reloaded.currentGeneration).toBe(1);
      expect(reloaded.revision).toBeGreaterThan(0);
    }

    // A subsequent, un-faulted request proceeds completely normally --
    // proves the earlier failure left the store in a genuinely usable state,
    // not a wedged one.
    const secondReceipt = await supervisor.request(mkReq({ kind: 'stop', cause: 'manual-cli', mode: null }));
    expect(secondReceipt.accepted).toBe(true);
    await flush();
    expect(supervisor.snapshot().desiredState).toBe('stopped');
  });

  it('an injected persist failure during acceptBatch aborts the WHOLE batch: nothing is committed, and the caller must not ACK its source', async () => {
    const supervisor = freshSupervisor();
    // Establish a genuinely valid, already-adopted durable record first
    // (mirrors the other tests in this file) so the fault injected below is
    // isolated to THIS one acceptBatch attempt, not conflated with "the
    // store was never adopted at all yet".
    const priorAccept = await supervisor.acceptBatch([{ sourceKey: 'src-0', payload: 'p0', payloadDigest: 'd0' }]);
    if (!priorAccept.ok) throw new Error('prior acceptBatch failed');

    const atomicModule = await import('../../src/utils/atomic.js');
    const spy = vi.spyOn(atomicModule, 'atomicWriteDurableSync').mockImplementation(() => {
      throw new Error('simulated disk failure during payload write');
    });

    let result;
    try {
      result = await supervisor.acceptBatch([{ sourceKey: 'src-1', payload: 'p1', payloadDigest: 'd1' }]);
    } finally {
      spy.mockRestore();
    }

    expect(result.ok).toBe(false);

    // Nothing new was durably accepted -- a fresh reload sees only the
    // PRIOR (successful) record, never a half-written one for src-1.
    const reloaded = reloadSnapshot();
    expect('corrupt' in reloaded).toBe(false);
    if (!('corrupt' in reloaded)) {
      expect(reloaded.outstandingWork).toHaveLength(1);
      expect(reloaded.outstandingWork[0]?.sourceKey).toBe('src-0');
    }
    expect(supervisor.outstandingWork()).toHaveLength(1);
    expect(supervisor.outstandingWork().some((r) => r.sourceKey === 'src-1')).toBe(false);
  });
});

// =============================================================================
// Step 4: duplicate daemon writer
// =============================================================================

describe('Task 5.5 Step 4: duplicate daemon writer', () => {
  it('a second admitDaemonWriter call against a genuinely live previous daemon is rejected, and stays rejected no matter how long the second caller waits (no timeout-based theft)', () => {
    const electionRoot = join(testDir, 'daemon-election-live');
    mkdirSync(electionRoot, { recursive: true });

    const first = admitDaemonWriter(electionRoot, 'daemon-a');
    expect(first.ok).toBe(true);
    // The recorded pid is THIS test process's own pid -- definitely alive,
    // per Task 1.4's own established pattern for the "genuinely live" case.
    const rawBefore = JSON.parse(readFileSync(join(electionRoot, 'lifecycle-daemon.json'), 'utf-8'));
    expect(rawBefore.pid).toBe(process.pid);

    vi.useFakeTimers();
    try {
      // `admitDaemonWriter` performs no internal polling/backoff of its own
      // -- it is a single synchronous decision. Advancing a huge amount of
      // virtual time before the second (synchronous) call proves there is no
      // hidden timeout path anywhere in the takeover decision: elapsed time
      // alone can never authorize a steal from a genuinely live holder.
      vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365); // one year
      const second = admitDaemonWriter(electionRoot, 'daemon-b');
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toMatch(/alive/);
    } finally {
      vi.useRealTimers();
    }

    // Still epoch 1, still daemon-a -- "waiting a year" changed nothing.
    const rawAfter = JSON.parse(readFileSync(join(electionRoot, 'lifecycle-daemon.json'), 'utf-8'));
    expect(rawAfter.epoch).toBe(1);
    expect(rawAfter.daemonUuid).toBe('daemon-a');
  });

  it('an ambiguous liveness result (EPERM) also blocks takeover -- distinct from, and just as final as, a genuinely live holder', () => {
    const electionRoot = join(testDir, 'daemon-election-ambiguous');
    mkdirSync(electionRoot, { recursive: true });
    admitDaemonWriter(electionRoot, 'daemon-a');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    try {
      const result = admitDaemonWriter(electionRoot, 'daemon-b');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/ambiguous/);
    } finally {
      killSpy.mockRestore();
    }

    const raw = JSON.parse(readFileSync(join(electionRoot, 'lifecycle-daemon.json'), 'utf-8'));
    expect(raw.epoch).toBe(1);
    expect(raw.daemonUuid).toBe('daemon-a');
  });

  it('once the previous daemon is conclusively dead, a fresh admitDaemonWriter call succeeds with an incremented epoch', () => {
    const electionRoot = join(testDir, 'daemon-election-dead');
    mkdirSync(electionRoot, { recursive: true });
    admitDaemonWriter(electionRoot, 'daemon-a');

    // A real, disposable, genuinely-dead child process (this build's own
    // established gotcha: never reuse the TEST WORKER'S OWN pid for a
    // liveness check). `spawnSync` blocks until it exits, so the pid is
    // DEFINITELY dead by the time we read it back.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid as number;
    expect(typeof deadPid).toBe('number');

    const recordPath = join(electionRoot, 'lifecycle-daemon.json');
    const raw = JSON.parse(readFileSync(recordPath, 'utf-8'));
    raw.pid = deadPid;
    writeFileSync(recordPath, JSON.stringify(raw));

    const second = admitDaemonWriter(electionRoot, 'daemon-b');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.epoch).toBe(2);

    const rawAfter = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(rawAfter.daemonUuid).toBe('daemon-b');
    expect(rawAfter.epoch).toBe(2);

    // And a THIRD admission attempt against the now-live daemon-b is, in
    // turn, correctly rejected -- the election discipline applies uniformly,
    // not just to the first holder.
    const third = admitDaemonWriter(electionRoot, 'daemon-c');
    expect(third.ok).toBe(false);
  });
});

// =============================================================================
// Step 6: crash between commit and effect
// =============================================================================

describe('Task 5.5 Step 6: crash between commit and effect', () => {
  it('a generation whose commit lands but whose effect never executes (simulated daemon crash) is recovered consistently on a fresh boot -- never silently dropped, never double-executed', async () => {
    const adapter1 = new FakeRuntimeAdapter();
    // This effect will NEVER resolve -- models the daemon dying at the exact
    // instant after the commit below lands but before the runtime effect
    // (the process spawn) completes.
    const neverResolves = new Promise<{ ok: boolean; resources: OwnedResource[] }>(() => {});
    adapter1.startGeneration.mockReturnValueOnce(neverResolves);
    const supervisor1 = freshSupervisor(adapter1);

    const startReceipt = await supervisor1.request(mkReq({ kind: 'start', cause: 'manual-cli', mode: 'continue' }));
    expect(startReceipt.accepted).toBe(true);
    expect(startReceipt.generation).toBe(1);

    // The DECISION committed durably (synchronous, before any effect is
    // awaited) -- this is the exact "crash between commit and effect"
    // window: everything below this line never happens for supervisor1's
    // own in-flight effect (it is simply abandoned in memory, never
    // resolved, never even referenced again).
    const committedSnap = supervisor1.snapshot();
    expect(committedSnap.currentGeneration).toBe(1);
    expect(committedSnap.phase).toBe('starting');
    expect(committedSnap.resources).toHaveLength(0); // the effect never delivered resources

    // "Fresh boot": a brand-new supervisor object (with its OWN fresh
    // adapter, standing in for a fresh daemon incarnation) over the SAME
    // durable store.
    const adapter2 = new FakeRuntimeAdapter();
    const supervisor2 = freshSupervisor(adapter2);
    const rebootSnap = supervisor2.snapshot();

    // Never silently dropped: the committed decision survived the crash
    // intact and is fully visible/inspectable.
    expect(rebootSnap.currentGeneration).toBe(1);
    expect(rebootSnap.phase).toBe('starting');
    expect(rebootSnap.desiredState).toBe('running');

    // HONEST FINDING, made deterministic per this task's own instruction
    // ("if genuinely ambiguous, make it deterministic and assert it"): a
    // bare reconciling 'start' request is NOT what resumes a crashed
    // 'starting' generation. `handleAutonomous`'s own "already
    // running/ready" branch (`desiredState === 'running' && phase !==
    // 'absent'`) treats ANY non-absent phase -- including a genuinely stuck
    // 'starting' with zero resources -- as already trivially satisfied, and
    // never calls `startGeneration` again. This is NOT "silently dropped"
    // (the durable phase/generation stay fully visible/inspectable forever,
    // exactly as asserted above) -- it is simply that a bare 'start' alone
    // never re-attempts the effect.
    const noopStart = await supervisor2.request(mkReq({ kind: 'start', cause: 'boot-self-heal', mode: 'continue' }));
    expect(noopStart.accepted).toBe(true);
    expect(adapter2.startGeneration).not.toHaveBeenCalled();
    expect(supervisor2.snapshot().currentGeneration).toBe(1); // unchanged -- no resume, no new generation either

    // The as-built mechanism that DOES actually recover it: a 'restart' (or
    // 'refresh') reconciliation request. ANSWER TO (a) vs (b): this is (b),
    // "treat it as needing reconciliation" -- the stuck generation is never
    // resumed in place (its own dangling effect promise is simply abandoned
    // forever); instead it is retired (a clean no-op here, since it never
    // acquired any resources to begin with) and REPLACED by a genuinely NEW
    // generation. It is never (a) "resume the effect for that exact
    // generation" -- no code path re-invokes `startGeneration` for
    // generation 1.
    const restartReceipt = await supervisor2.request(mkReq({ kind: 'restart', cause: 'reaper', mode: 'continue' }));
    expect(restartReceipt.accepted).toBe(true);
    await flush();

    expect(adapter2.retireGeneration).toHaveBeenCalledTimes(1); // retiring generation 1 (no resources -- a clean no-op)
    expect(adapter2.startGeneration).toHaveBeenCalledTimes(1); // exactly once -- generation 2, never a second call for generation 1
    const recoveredSnap = supervisor2.snapshot();
    expect(recoveredSnap.currentGeneration).toBe(2); // a NEW generation, never the crashed generation 1 "resumed"
    expect(recoveredSnap.phase).toBe('ready');

    // Never double-executed: the ORIGINAL crashed effect (generation 1's
    // `startGeneration`, still pending forever inside supervisor1's own
    // abandoned promise chain) is unconditionally fenced as stale against
    // the now-current generation 2 -- if it somehow resolved late, it could
    // never be promoted alongside generation 2's real resources.
    const staleEffect: EffectToken = {
      agentId,
      supervisorEpoch: committedSnap.supervisorEpoch,
      generation: 1,
      intentRevision: committedSnap.intentRevision,
      effectId: 'stale-effect-generation-1',
    };
    expect(supervisor2.isEffectLive(staleEffect)).toBe(false);

    // No corruption, no ambiguity survives into the final durable record.
    const finalReloaded = reloadSnapshot();
    expect('corrupt' in finalReloaded).toBe(false);
    if (!('corrupt' in finalReloaded)) {
      expect(finalReloaded.currentGeneration).toBe(2);
      expect(finalReloaded.resources).toHaveLength(1);
    }
  });
});

// =============================================================================
// Steps 2 & 5: corrupt store through the full AgentManager boot path, and
// multi-agent concurrency isolation
// =============================================================================

let mockPty: {
  spawn: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  getPid: ReturnType<typeof vi.fn>;
  getHostPid: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  getOutputBuffer: ReturnType<typeof vi.fn>;
};

let onExitHandlers: Array<(exitCode: number, signal?: number) => void> = [];
// Gotcha from Task 2.5 (this build's own established precedent): never reuse
// the test worker's own `process.pid` for a mocked PTY's pid -- spawn a real
// disposable child instead, so liveness checks see a genuinely-alive pid
// that is also safe to kill.
let dummyChildren: ChildProcess[] = [];

function freshMockPty(): typeof mockPty {
  const idx = onExitHandlers.length;
  onExitHandlers.push(() => {});
  const child = spawn('sleep', ['60']);
  dummyChildren.push(child);
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockImplementation(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      setImmediate(() => onExitHandlers[idx]?.(0));
    }),
    write: vi.fn(),
    getPid: vi.fn().mockImplementation(() => child.pid),
    getHostPid: vi.fn().mockImplementation(() => child.pid),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      onExitHandlers[idx] = cb;
    }),
    getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true }),
  };
}

function nextPty(): typeof mockPty {
  return freshMockPty();
}

vi.mock('../../src/pty/agent-pty.js', () => ({ AgentPTY: function () { return nextPty(); } }));
vi.mock('../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: function () { return nextPty(); } }));
vi.mock('../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function () { return nextPty(); },
  hermesDbExists: () => false,
}));
vi.mock('../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function () { return nextPty(); },
  opencodeSessionExists: () => false,
}));
vi.mock('../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    startCount = 0;
    stopCount = 0;
    constructor(public process: unknown) {}
    async start() { this.startCount++; }
    stop() { this.stopCount++; }
    wake() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    async handleActivityCallback() { /* no-op */ }
  },
}));
vi.mock('../../src/telegram/api.js', () => ({
  TelegramAPI: class { async sendMessage() { /* no-op */ } },
}));
vi.mock('../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() { return new Promise<void>(() => {}); }
    stop() { /* no-op */ }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
  },
}));
vi.mock('../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    constructor(_opts: { agentName: string }) {}
    start() { /* no-op */ }
    stop() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));
vi.mock('../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    async spawn() { /* no-op */ }
    async terminate() { /* no-op */ }
    onDone() { /* no-op */ }
    isFinished() { return true; }
    getStatus() { return {}; }
  },
}));
vi.mock('../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../src/daemon/agent-manager.js');

type AnyAgentManager = InstanceType<typeof AgentManager> & {
  agents: Map<string, { process: { getStatus(): { status: string } }; checker: unknown; supervised?: boolean; supervisor?: unknown }>;
  supervisors: Map<string, AgentLifecycleSupervisor>;
  getSupervisorForAgent(name: string): AgentLifecycleSupervisor | undefined;
};

const MGR_INSTANCE_ID = 'lifecycle-recovery-boundaries-mgr-test';
const MGR_ORG = 'acme';

function supervisorRecordPath(mgrCtxRoot: string, name: string): string {
  return join(mgrCtxRoot, 'state', name, 'lifecycle', 'supervisor.json');
}

describe('Task 5.5 Step 2 & Step 5: corrupt store through the full AgentManager boot path, and multi-agent isolation', () => {
  let mgrTestDir: string;
  let mgrCtxRoot: string;
  let frameworkRoot: string;
  let agentDirAlice: string;
  let agentDirBob: string;

  beforeEach(() => {
    onExitHandlers = [];
    dummyChildren = [];
    mgrTestDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-recovery-boundaries-mgr-'));
    mgrCtxRoot = join(mgrTestDir, 'instance');
    frameworkRoot = join(mgrTestDir, 'framework');
    agentDirAlice = join(frameworkRoot, 'orgs', MGR_ORG, 'agents', 'alice');
    agentDirBob = join(frameworkRoot, 'orgs', MGR_ORG, 'agents', 'bob');
    mkdirSync(agentDirAlice, { recursive: true });
    mkdirSync(agentDirBob, { recursive: true });
    mkdirSync(join(mgrCtxRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const child of dummyChildren) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(mgrTestDir, { recursive: true, force: true });
  });

  it('Step 2: a corrupt on-disk record, driven through the full AgentManager boot path, is never repaired/reset, never restored from a .bak, and reports blocked when the supervisor object is addressed directly', async () => {
    const am = new AgentManager(MGR_INSTANCE_ID, mgrCtxRoot, frameworkRoot, MGR_ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

    await am.startAgent('alice', agentDirAlice, config, MGR_ORG);
    await am.stopAgent('alice'); // a real, valid 'stopped' durable record now exists

    const recordPath = supervisorRecordPath(mgrCtxRoot, 'alice');
    const validRaw = readFileSync(recordPath, 'utf-8');
    expect(validRaw).toContain('"stopped"');

    // Reuse Task 1.4's own truncated-JSON corruption case, here driven
    // through the full boot path rather than a bare `LifecycleStateStore.load()` call.
    const truncated = validRaw.slice(0, Math.floor(validRaw.length / 2));
    writeFileSync(recordPath, truncated);

    // A `.bak` sitting right next to it with enticing, DIFFERENT ('running')
    // content -- must never be consulted as a fallback.
    writeFileSync(`${recordPath}.bak`, validRaw.replace('"stopped"', '"running"'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Fresh daemon incarnation, same ctxRoot -- exercises the corrupt-store
    // handling through the REAL AgentManager boot path.
    const am2 = new AgentManager(MGR_INSTANCE_ID, mgrCtxRoot, frameworkRoot, MGR_ORG) as unknown as AnyAgentManager;
    await am2.startAgent('alice', agentDirAlice, config, MGR_ORG);

    // AgentManager's own documented fail-closed design (`resolveSupervisorGate`):
    // corrupt evidence is "conflicting legacy evidence" -- it falls back to
    // the legacy (non-supervised) path for THIS agent THIS run with a
    // visible warning, rather than guessing or repairing anything.
    expect(am2.agents.get('alice')!.supervised).toBe(false);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('corrupt'))).toBe(true);

    // `getSupervisorForAgent()` deliberately returns `undefined` here -- by
    // its own doc comment, it reports `undefined` for "a known-but-not-
    // supervised agent... even though a supervisor object exists for every
    // agent per Task 2.5's lazy-adoption-on-first-touch design", precisely
    // because this agent isn't routed through it. Confirm that honestly,
    // then reach the real underlying object via the raw registry to prove
    // it was still constructed and reports the corrupt store correctly.
    expect(am2.getSupervisorForAgent('alice')).toBeUndefined();

    // The supervisor object is STILL constructed (Task 2.5: "constructed for
    // every agent") -- addressed DIRECTLY via the raw registry, it reports
    // the corrupt store honestly as blocked, never a guessed fresh generation 1.
    const supervisor = am2.supervisors.get('alice');
    expect(supervisor).toBeDefined();
    const receipt = await supervisor!.request({
      requestId: randomUUID(),
      kind: 'stop',
      cause: 'manual-cli',
      mode: null,
      observedGeneration: null,
      userInitiated: true,
      evidence: {},
      requestedAtMs: Date.now(),
    });
    expect(receipt.accepted).toBe(false);
    expect(receipt.generation).toBeNull(); // never a guessed generation
    expect(receipt.blockedReason).toMatch(/store unavailable/);
    expect(receipt.desiredState).not.toBe('running'); // the enticing .bak content never took effect

    // No silent repair: the corrupt bytes on disk are byte-identical to what
    // we deliberately wrote.
    expect(readFileSync(recordPath, 'utf-8')).toBe(truncated);

    // Static confirmation (mirrors this build's own Task 1.6 isolation-gate
    // style): the store's actual code contains no `.bak` READ of any kind --
    // its only two mentions of the literal string are doc comments
    // explicitly PROHIBITING the behavior, never a real fallback read.
    const stateStoreSrc = readFileSync(join(process.cwd(), 'src/daemon/lifecycle/state-store.ts'), 'utf-8');
    const codeOnly = stateStoreSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toContain('.bak');

    await am2.stopAgent('alice').catch(() => {}); // best-effort cleanup (legacy path)
  });

  it('Step 5: multi-agent concurrency isolation -- one corrupted/blocked agent must never delay or block another agent\'s control requests', async () => {
    const am = new AgentManager(MGR_INSTANCE_ID, mgrCtxRoot, frameworkRoot, MGR_ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

    await am.startAgent('alice', agentDirAlice, config, MGR_ORG);
    await am.startAgent('bob', agentDirBob, config, MGR_ORG);
    expect(am.agents.get('alice')!.supervised).toBe(true);
    expect(am.agents.get('bob')!.supervised).toBe(true);

    // Corrupt ONLY alice's on-disk record, sharing the same ctxRoot/daemon
    // as bob but a physically distinct `<stateDir>/lifecycle/supervisor.json`
    // (per-agent `stateDir` under `this.ctxRoot`).
    const aliceRecordPath = supervisorRecordPath(mgrCtxRoot, 'alice');
    writeFileSync(aliceRecordPath, '{"agentId":"broken", not valid json');

    // alice's own next control request correctly fails closed -- confirms
    // the corruption actually bit and did not silently no-op or repair.
    const aliceSupervisor = am.getSupervisorForAgent('alice')!;
    const aliceReceipt = await aliceSupervisor.request({
      requestId: randomUUID(),
      kind: 'stop',
      cause: 'manual-cli',
      mode: null,
      observedGeneration: null,
      userInitiated: true,
      evidence: {},
      requestedAtMs: Date.now(),
    });
    expect(aliceReceipt.accepted).toBe(false);
    expect(aliceReceipt.blockedReason).toMatch(/store unavailable/);

    // THE ACTUAL ISOLATION ASSERTION: bob's stop, issued right after alice's
    // corruption is confirmed live, must complete promptly and successfully
    // -- entirely unaffected by alice's corrupted/blocked store (separate
    // lock root per agent, per Task 1.2/1.4's per-agent `stateDir`).
    const startedAt = Date.now();
    await am.stopAgent('bob');
    const elapsedMs = Date.now() - startedAt;

    expect(am.agents.has('bob')).toBe(false);
    expect(elapsedMs).toBeLessThan(5000);

    const bobRecordPath = supervisorRecordPath(mgrCtxRoot, 'bob');
    const bobSnapshot = JSON.parse(readFileSync(bobRecordPath, 'utf-8'));
    expect(bobSnapshot.desiredState).toBe('stopped');

    // And bob's control channel keeps working normally afterward, too --
    // proves this isn't a one-off race but a durable property of the
    // per-agent isolation.
    await am.startAgent('bob', agentDirBob, config, MGR_ORG);
    expect(am.agents.get('bob')!.supervised).toBe(true);
    await am.stopAgent('bob');
    expect(am.agents.has('bob')).toBe(false);

    // alice, meanwhile, is still exactly as blocked as she started --
    // her corruption was never magically healed by bob's activity.
    const aliceStillBlocked = await aliceSupervisor.request({
      requestId: randomUUID(),
      kind: 'start',
      cause: 'manual-cli',
      mode: 'continue',
      observedGeneration: null,
      userInitiated: true,
      evidence: {},
      requestedAtMs: Date.now(),
    });
    expect(aliceStillBlocked.accepted).toBe(false);

    // Cleanup: remove alice's entry via `agents.delete` directly (her
    // supervised stop cannot durably resolve against a permanently corrupt
    // store, and that is the whole point of this test) so `afterEach`'s
    // dummy-child cleanup still runs cleanly.
    am.agents.delete('alice');
  });
});
