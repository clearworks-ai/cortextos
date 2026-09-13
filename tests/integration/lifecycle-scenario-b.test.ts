import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig, BusPaths } from '../../src/types/index';

/**
 * Task 2.10: permanent regression test for deep-dive Scenario B — "I stopped
 * it, but another copy came back" — proven to FAIL against the pre-supervisor
 * code path and to PASS against the code produced by Tasks 2.4/2.5/2.6.
 *
 * ---------------------------------------------------------------------------
 * (a) THE PRE-FIX CODE BEING REPLAYED, quoted verbatim so the control run
 *     stays auditable even though the files under test are already fixed by
 *     the time this test exists (fetched via `git show 85aab8fb^` /
 *     `git show 62b3f299^`, the commits immediately before Tasks 2.4 and 2.5
 *     respectively):
 *
 *   agent-process.ts (pre-Task-2.4 `sessionRefresh()`):
 *     async sessionRefresh(): Promise<void> {
 *       this.log('Session refresh (--continue restart)');
 *       try {
 *         const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
 *         const token: GenerationToken = {
 *           agentId: canonicalAgentId({ instanceId: this.env.instanceId, org: this.env.org, name: this.name }),
 *           supervisorEpoch: 0,
 *           generation: this.lifecycleGeneration,
 *         };
 *         projectSessionRefreshMarker(paths.stateDir, token);
 *       } catch (err) {
 *         this.log(`Failed to write .session-refresh marker: ${err}`);
 *       }
 *       await this.stop();
 *       await this.start();
 *       this.log('Session refreshed');
 *     }
 *
 *   agent-manager.ts (pre-Task-2.5 `stopAgent()`, relevant excerpt):
 *     async stopAgent(name: string, userInitiated = false): Promise<void> {
 *       ...
 *       this.stoppingAgents.add(name);
 *       try {
 *         const scheduler = this.cronSchedulers.get(name);
 *         entry.stopped = true;
 *         ...
 *         entry.checker.stop();
 *         await entry.process.stop();
 *         ...
 *         this.agents.delete(name);
 *         if (userInitiated) { ...; return; }
 *         ...
 *       } finally { this.stoppingAgents.delete(name); }
 *     }
 *
 *   These two bodies are STILL LIVE in the current source, byte-for-byte,
 *   behind `if (entry.supervised === true && entry.supervisor)` /
 *   `if (!this.supervised)` gates (Task 2.4/2.5's own doc comments confirm
 *   this explicitly: "byte-for-byte the pre-Task-2.4 body"). The CONTROL
 *   test below therefore does not need to monkey-patch or duplicate an old
 *   implementation inline — constructing the agent with `supervised: false`
 *   (or omitted) exercises the real pre-fix code path directly.
 *
 * (b) THE MEASURED CONTROL-RUN OUTPUT this test's control case must
 *     reproduce (DEEPDIVE-lifecycle-recurrence-2026-09-11.md, section 3B):
 *
 *       Overlapping refresh + explicit stop:
 *         during teardown: stopping=true, isRestartInFlight=false
 *         final: newStarts=1, processStatus=running, stillManaged=false
 *                entryStopped=true, checkerStopped=true
 *       Serial control (finish refresh, then stop):
 *         final: processStatus=stopped, stillManaged=false
 *
 * (c) Deliberately uses the REAL `AgentProcess.start`/`stop`/`sessionRefresh`
 *     and the REAL `AgentManager.stopAgent`/`stillMapped` bodies — only the
 *     low-level PTY spawn boundary and the unrelated
 *     Telegram/CronScheduler/WorkerProcess wiring are faked, mirroring
 *     `tests/integration/lifecycle-manager.test.ts` (Task 2.5) and
 *     `tests/unit/daemon/agent-process-session-refresh.test.ts` (Task 2.4),
 *     whose fake-clock race-construction technique this file reuses directly:
 *     awaiting `sessionRefresh()` (or, for the context-hard-full variant,
 *     `FastChecker.forceContextRestart()`) resolves once the refresh's
 *     durable commit lands — by which point the retire→start operation's
 *     detached continuation has ALREADY run synchronously down to its own
 *     first internal `await` (the graceful-shutdown sleep inside the real
 *     `runStop()`), so the very next `stopAgent(name, true)` call is
 *     guaranteed to land while that retire is still in flight, not before it
 *     started and not after it finished.
 *
 * (d) Task 5.4 addition: a fresh `AgentManager` instance, constructed
 *     against the SAME on-disk `ctxRoot`/`frameworkRoot`, simulating a brand
 *     new daemon process starting up after a stop and running its REAL
 *     `discoverAndStart()` path (the actual production daemon-boot entry
 *     point, `daemon/index.ts`'s own call) — proving the durable `stopped`
 *     state survives more than just a bare `LifecycleStateStore` reload
 *     within the same process. This closed a genuine, previously-
 *     undocumented gap found by writing this exact test: `bootSelfHeal()`
 *     alone had a "don't resurrect a persisted stopped/halted/quarantined
 *     supervised agent" gate (Task 2.5 Step 3), but `discoverAndStart()`'s
 *     own bulk-start loop — which runs FIRST, unconditionally, for every
 *     agent dir not disabled via `config.json`/`enabled-agents.json` — had
 *     no such gate at all, and a supervised explicit stop never flips
 *     either of those disable flags. So the bulk loop would call
 *     `startAgent()` and successfully spawn a fresh generation before
 *     `bootSelfHeal()`'s check ever got a chance to matter (the agent was
 *     no longer "missing" by then). Fixed via a shared
 *     `supervisedResurrectionGate()` helper now consulted by both the bulk
 *     loop and `bootSelfHeal()` — see `agent-manager.ts` for the full
 *     mechanism.
 * ---------------------------------------------------------------------------
 */

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

// Single shared slot: at any moment this points at the MOST RECENTLY spawned
// generation's exit callback. A test that lets a second generation spawn
// (the positive-control "stop after full settlement" ordering) naturally
// gets gen2's callback here once gen2 starts — exactly mirroring
// agent-process-session-refresh.test.ts's own "capturedOnExit now points at
// generation 2's onExit registration" comment.
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;
let ptyInstances: Array<typeof mockPty> = [];

function freshMockPty(): typeof mockPty {
  const idx = ptyInstances.length;
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    // Deliberately NOT auto-firing on kill() (unlike lifecycle-manager.test.ts's
    // real-disposable-child pattern) -- this file drives the exit manually
    // under fake timers so the race window is exact and deterministic rather
    // than dependent on real OS process-death latency.
    kill: vi.fn(),
    write: vi.fn(),
    // Fake, guaranteed-nonexistent pid -- process.kill(pid, 0) inside the real
    // isChildAlive() throws ESRCH for it, so runStop()'s SIGKILL-escalation
    // branch is safely never reached. Same technique as
    // agent-process-session-refresh.test.ts (Task 2.4's own proven test).
    getPid: vi.fn().mockReturnValue(910001 + idx),
    getHostPid: vi.fn().mockReturnValue(920001 + idx),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      capturedOnExit = cb;
    }),
    getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true }),
  };
}

function nextPty(): typeof mockPty {
  mockPty = freshMockPty();
  ptyInstances.push(mockPty);
  return mockPty;
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

// sessionRefresh() (both branches) and AgentManager.startAgent()'s FastChecker/
// TelegramPoller wiring both call resolvePaths() -- real, it would resolve
// under the actual user's ~/.cortextos. Mocked to this test's own tmp ctxRoot,
// mirroring agent-process-session-refresh.test.ts's identical mock.
vi.mock('../../src/utils/paths.js', () => ({ resolvePaths: vi.fn() }));

// Keeps the AgentManager-level `entry.checker` a lightweight, inert stand-in
// (same shape as lifecycle-manager.test.ts's mock, tracking stop()/start()
// call counts) while ALSO exporting the real class under a test-only name so
// the context-hard-full variant can construct one real instance and invoke
// its real, private forceContextRestart() -- the actual trigger this task's
// acceptance criteria names, not a re-implementation of it.
vi.mock('../../src/daemon/fast-checker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/fast-checker.js')>();
  return {
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
    __RealFastChecker: actual.FastChecker,
  };
});
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
const { LifecycleStateStore } = await import('../../src/daemon/lifecycle/state-store.js');
const { canonicalAgentId } = await import('../../src/daemon/lifecycle/types.js');
const { resolvePaths } = await import('../../src/utils/paths.js');
const { __RealFastChecker } = await import('../../src/daemon/fast-checker.js') as unknown as {
  __RealFastChecker: new (
    agent: unknown,
    paths: BusPaths,
    frameworkRoot: string,
    options?: Record<string, unknown>,
  ) => { forceContextRestart(reason: string): void };
};

type MockedProcess = {
  name: string;
  getStatus(): { status: string };
  sessionRefresh(): Promise<{ accepted: boolean; generation: number | null; blockedReason: string | null } | void>;
  getAgentDir(): string;
};
type MockedChecker = { startCount: number; stopCount: number };
type MockedEntry = {
  process: MockedProcess;
  checker: MockedChecker;
  stopped?: boolean;
  supervised?: boolean;
  supervisor?: unknown;
};
type AnyAgentManager = InstanceType<typeof AgentManager> & {
  agents: Map<string, MockedEntry>;
  supervisors: Map<string, unknown>;
  stillMapped(name: string, entry: MockedEntry): boolean;
};

const INSTANCE_ID = 'scenario-b-test';
const ORG = 'acme';
const NAME = 'alice';

function fakeBusPaths(ctxRoot: string, agentName: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(ctxRoot, 'orgs', ORG, 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', ORG, 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', ORG, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', ORG, 'deliverables'),
  };
}

/** Re-reads the durable lifecycle record from a FRESH `LifecycleStateStore`
 * instance -- proves the `stopped` desired state truly persisted to disk
 * rather than merely living in the in-memory supervisor this test already
 * holds a reference to (i.e. what a real daemon restart would observe). */
function reloadDesiredState(ctxRoot: string, name: string): string {
  const agentId = canonicalAgentId({ instanceId: INSTANCE_ID, org: ORG, name });
  const freshStore = new LifecycleStateStore(fakeBusPaths(ctxRoot, name), agentId);
  const loaded = freshStore.load();
  if ('corrupt' in loaded) {
    throw new Error(`reloadDesiredState: store unexpectedly corrupt/not-adopted: ${loaded.reason}`);
  }
  return loaded.desiredState;
}

/**
 * Pre-existing (not this task's to fix) wiring gap confirmed by reading the
 * source: `AgentManager.startAgent()`'s initial spawn — used both for a
 * brand-new agent AND for `bootSelfHeal()`'s recovery-start branch — calls
 * `await agentProcess.start()` DIRECTLY, never through the owner. That
 * leaves the durable store's `currentGeneration` at its `adopt()`-time
 * `null` even though the agent is genuinely running, because only a
 * supervisor-mediated `start`/`restart`/`refresh` commit ever advances it.
 * `sessionRefresh()`'s `refresh` request carries `observedGeneration: this.
 * lifecycleGeneration` (AgentProcess's OWN counter, already 1 after that
 * direct start) and `handleAutonomous()` rejects any non-null
 * `observedGeneration` that does not match a null `currentGeneration` as
 * stale — so a session-refresh submitted immediately after
 * `AgentManager.startAgent()`, with nothing else in between, is rejected
 * every time regardless of any race, which would make this test vacuous.
 *
 * A real long-lived agent does not hit this: over its life at least one
 * supervisor-mediated operation (a restart, a prior refresh, a dashboard
 * action) runs before its 71-hour session timer or a context-hard-full
 * event ever fires, and `restart`'s request (unlike `refresh`'s) carries
 * `observedGeneration: null` (see `restartSupervisedAgent`), so it is never
 * rejected as stale and is exactly what synchronizes `currentGeneration`
 * from `null` to a real integer for the first time. This helper performs
 * that one warm-up restart through the REAL supervised `AgentManager.
 * restartAgent()` path (not a hand-rolled request) so this test's setup is
 * itself real code, not a workaround invented for the test: since the agent
 * is already running, the adapter's `startImplFenced()` hits its own
 * "already running" short-circuit and spawns nothing new, so `ptyInstances.
 * length` is unaffected by calling this.
 */
async function warmUpGenerationSync(am: { restartAgent(name: string): Promise<{ accepted: boolean | null }> }, name: string): Promise<void> {
  const result = await am.restartAgent(name);
  if (!result.accepted) {
    throw new Error('warmUpGenerationSync: supervised restart was not accepted — cannot proceed');
  }
}

let testDir: string;
let ctxRoot: string;
let frameworkRoot: string;
let agentDir: string;

beforeEach(() => {
  ptyInstances = [];
  capturedOnExit = null;
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-scenario-b-test-'));
  ctxRoot = join(testDir, 'instance');
  frameworkRoot = join(testDir, 'framework');
  agentDir = join(frameworkRoot, 'orgs', ORG, 'agents', NAME);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  mkdirSync(join(ctxRoot, 'state', NAME), { recursive: true });
  vi.mocked(resolvePaths).mockImplementation((name: string) => fakeBusPaths(ctxRoot, name));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe('Task 2.10: Scenario B replay — supervised: true (closed)', () => {
  it('stop lands mid-flight (refresh already retiring, start not yet attempted): newStarts === 0, no unmapped running process, entry.stopped, checker stopped, durable stopped after reload', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0 };

    await am.startAgent(NAME, agentDir, config, ORG);
    const entry = am.agents.get(NAME)!;
    expect(entry.supervised).toBe(true);
    expect(entry.process.getStatus().status).toBe('running');
    expect(ptyInstances.length).toBe(1); // generation 1's spawn

    // See warmUpGenerationSync's doc comment: synchronizes the durable
    // store's currentGeneration (null after startAgent's direct-spawn boot)
    // to a real integer, exactly as a real long-lived agent's history would
    // before its first ever session-refresh. Does not spawn anything new.
    await warmUpGenerationSync(am, NAME);
    expect(ptyInstances.length).toBe(1);

    vi.useFakeTimers();
    try {
      // By the time this receipt resolves, the refresh's retire->start
      // operation has already run synchronously down through runStop()'s
      // real teardown body to its own first internal await (the
      // graceful-shutdown sleep) -- see this file's header comment (c).
      const refreshReceipt = await entry.process.sessionRefresh();
      expect(refreshReceipt).toBeDefined();
      expect(refreshReceipt!.accepted).toBe(true);
      expect(refreshReceipt!.generation).toBe(2); // new generation allocated

      // Genuinely mid-flight: calls stopAgent(name, true) -- strongest
      // intended precedence -- while the refresh's retire phase is already
      // in progress, through the REAL AgentManager.stopAgent/stopSupervisedAgent
      // body (not a hand-rolled supervisor.request() call).
      const stopResult = await am.stopAgent(NAME, true);
      expect(stopResult.dispatched).toBe(true);
      expect(stopResult.supervised).toBe(true);
      expect(stopResult.accepted).toBe(true);

      // Let generation 1's real (fake-pid) PTY actually "die" and drain the
      // graceful-shutdown sleeps + the retire->start continuation.
      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }

    // The load-bearing assertions -- the revoked refresh's start-half must
    // never have spawned a successor process.
    expect(ptyInstances.length).toBe(1); // newStarts === 0
    expect(entry.process.getStatus().status).toBe('stopped'); // no running process object anywhere
    expect(am.agents.has(NAME)).toBe(false); // entry retired/unmapped
    expect(am.stillMapped(NAME, entry)).toBe(false); // real stillMapped(), not a re-derived check
    expect(entry.stopped).toBe(true);
    expect(entry.checker.stopCount).toBeGreaterThanOrEqual(1); // checker stopped

    expect(reloadDesiredState(ctxRoot, NAME)).toBe('stopped'); // durable, survives a fresh store instance
  });

  it('positive control — stop lands AFTER the refresh has fully settled (gen2 running): fix does not block start entirely, still ends cleanly stopped', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0 };

    await am.startAgent(NAME, agentDir, config, ORG);
    const entry = am.agents.get(NAME)!;
    expect(ptyInstances.length).toBe(1);

    await warmUpGenerationSync(am, NAME);
    expect(ptyInstances.length).toBe(1);

    vi.useFakeTimers();
    try {
      const refreshReceipt = await entry.process.sessionRefresh();
      expect(refreshReceipt!.generation).toBe(2);

      // Nothing contends this time -- let generation 1 fully retire AND
      // generation 2 fully start.
      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(ptyInstances.length).toBe(2); // gen1 + gen2, both real starts
      expect(entry.process.getStatus().status).toBe('running');

      // Only NOW submit the stop -- well after the refresh has settled.
      const stopResult = await am.stopAgent(NAME, true);
      expect(stopResult.accepted).toBe(true);

      // capturedOnExit now points at generation 2's onExit registration.
      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }

    expect(ptyInstances.length).toBe(2); // no THIRD spawn
    expect(entry.process.getStatus().status).toBe('stopped');
    expect(am.agents.has(NAME)).toBe(false);
    expect(am.stillMapped(NAME, entry)).toBe(false);
    expect(entry.stopped).toBe(true);
    expect(entry.checker.stopCount).toBeGreaterThanOrEqual(1);
    expect(reloadDesiredState(ctxRoot, NAME)).toBe('stopped');
  });

  it('context-hard-full variant: same race triggered via the real FastChecker.forceContextRestart(), not the session timer — same closure', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0 };

    await am.startAgent(NAME, agentDir, config, ORG);
    const entry = am.agents.get(NAME)!;
    expect(ptyInstances.length).toBe(1);

    await warmUpGenerationSync(am, NAME);
    expect(ptyInstances.length).toBe(1);

    // A real, standalone FastChecker instance wired to THIS SAME AgentProcess
    // (never .start()'d -- no poll loop, no heartbeat timer -- only its real,
    // private forceContextRestart() is invoked directly). This is the actual
    // trigger point context exhaustion uses in production
    // (fast-checker.ts's forceContextRestart -> `this.agent.sessionRefresh()`),
    // as opposed to the 71-hour session timer used in the other cases above.
    //
    // Note (honesty about a real, pre-existing limitation): forceContextRestart()
    // calls sessionRefresh() with no arguments, and sessionRefresh() itself
    // hardcodes `cause: 'session-age'` in the LifecycleRequest it submits
    // regardless of caller (confirmed by reading both agent-process.ts and
    // fast-checker.ts's source) -- there is no plumbed-through
    // 'context-hard-full' cause value yet. This variant's discriminating
    // value is therefore exercising the REAL alternate trigger code path
    // (forceContextRestart's circuit-breaker/marker-writing machinery,
    // reached via a genuinely different call site) to prove the fix is not
        // accidentally wired only to the session timer's call path -- not a
    // distinct CAUSE_SEVERITY arbitration branch, which would require a
    // future task to plumb a real cause parameter through sessionRefresh().
    const realChecker = new __RealFastChecker(entry.process, fakeBusPaths(ctxRoot, NAME), frameworkRoot, {});

    vi.useFakeTimers();
    try {
      (realChecker as unknown as { forceContextRestart(reason: string): void }).forceContextRestart('context exhaustion (test)');

      // forceContextRestart() is synchronous and fire-and-forgets
      // sessionRefresh() (`.catch(...)`) -- unlike the other cases above we
      // have no receipt promise to await directly, so we flush the
      // microtask queue instead. The `queueMicrotask` the refresh's
      // owner.request() schedules was enqueued strictly before this
      // continuation's own microtask (it was queued synchronously inside
      // forceContextRestart's call, before this line even runs), so by the
      // time this resolves the refresh's window has already committed and
      // its detached retire has already reached its own first internal
      // await -- the same guarantee the other cases get from awaiting the
      // receipt directly.
      await Promise.resolve();
      await Promise.resolve();

      const stopResult = await am.stopAgent(NAME, true);
      expect(stopResult.accepted).toBe(true);

      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }

    expect(ptyInstances.length).toBe(1); // newStarts === 0, same closure as the timer-triggered case
    expect(entry.process.getStatus().status).toBe('stopped');
    expect(am.agents.has(NAME)).toBe(false);
    expect(am.stillMapped(NAME, entry)).toBe(false);
    expect(entry.stopped).toBe(true);
    expect(entry.checker.stopCount).toBeGreaterThanOrEqual(1);
    expect(reloadDesiredState(ctxRoot, NAME)).toBe('stopped');
  });

  it('Task 5.4: durable stopped state survives a SIMULATED DAEMON RESTART — a fresh AgentManager running the real discoverAndStart() does not resurrect the agent', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0 };

    await am.startAgent(NAME, agentDir, config, ORG);
    expect(ptyInstances.length).toBe(1); // generation 1's spawn

    // A plain explicit stop (no overlapping refresh race needed for this
    // assertion — that race is already covered by the two cases above).
    const stopResult = await am.stopAgent(NAME, true);
    expect(stopResult.accepted).toBe(true);
    expect(am.agents.has(NAME)).toBe(false);
    expect(reloadDesiredState(ctxRoot, NAME)).toBe('stopped');

    // discoverAgents()/loadAgentConfig() reads config.json from DISK — the
    // in-memory `config` object passed to `startAgent()` above is never
    // itself persisted there. A real daemon restart's discoverAndStart()
    // only ever sees `supervised: true` for this agent if config.json on
    // disk actually says so, exactly like a real installation's config file.
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify(config), 'utf-8');

    const ptyCountAfterStop = ptyInstances.length;

    // A FRESH AgentManager — same ctxRoot/frameworkRoot/instanceId, its own
    // empty in-memory `this.agents` map — simulating a brand new daemon
    // process starting up and discovering this agent dir from scratch.
    const am2 = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am2.discoverAndStart();

    // No new process/generation started for the stopped agent.
    expect(ptyInstances.length).toBe(ptyCountAfterStop);
    // The fresh AgentManager's own view: not resurrected into its registry.
    expect(am2.agents.has(NAME)).toBe(false);
    // The fresh AgentManager's view of the agent's durable lifecycle state
    // reports stopped, not running — read through the same public accessor
    // the IPC/dashboard status surface uses (Task 2.8's
    // `getPersistedLifecycleState`), not by re-deriving from the map.
    const persisted = am2.getPersistedLifecycleState(NAME, ORG);
    expect(persisted?.desiredState).toBe('stopped');
  });
});

describe('Task 2.10: Scenario B replay — CONTROL, pre-supervisor path (supervised: false/absent)', () => {
  it('reproduces the deep-dive\'s measured leak: newStarts === 1, processStatus running, stillManaged false', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    // supervised omitted -- exercises the real pre-Task-2.4/2.5 code path
    // quoted verbatim in this file's header, byte-for-byte unchanged.
    const config: AgentConfig = { startup_delay: 0 };

    await am.startAgent(NAME, agentDir, config, ORG);
    const entry = am.agents.get(NAME)!;
    expect(entry.supervised).toBeFalsy();
    expect(ptyInstances.length).toBe(1);

    vi.useFakeTimers();
    try {
      // Legacy sessionRefresh(): `await this.stop(); await this.start();` --
      // calling it (unawaited) runs synchronously through the marker write
      // and into `this.stop()` -> `runStop()`'s real teardown body down to
      // its own first internal await, exactly as in the supervised cases
      // above, but here there is no owner/mailbox indirection at all so no
      // microtask hop is even needed before the next line.
      const refreshPromise = entry.process.sessionRefresh();

      // The legacy AgentManager.stopAgent() body: `await entry.process.stop()`
      // JOINS the SAME in-flight teardown sessionRefresh()'s own stop() call
      // already started (AgentProcess.stop()'s join-in-flight guard) --
      // structurally identical to the deep-dive's replayed race. Neither
      // promise can resolve until the PTY "exits", so we must not await
      // either one until after firing that exit below.
      const stopPromise = am.stopAgent(NAME, true);

      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);

      const [, stopResult] = await Promise.all([refreshPromise, stopPromise]);
      expect(stopResult.dispatched).toBe(true);
      expect(stopResult.supervised).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    // The deep-dive's exact measured numbers (section 3B):
    //   final: newStarts=1, processStatus=running, stillManaged=false
    expect(ptyInstances.length).toBe(2); // newStarts === 1 (gen1 + the leaked successor)
    expect(entry.process.getStatus().status).toBe('running'); // processStatus: running
    expect(am.agents.has(NAME)).toBe(false); // stillManaged: false
    expect(am.stillMapped(NAME, entry)).toBe(false);
  });
});
