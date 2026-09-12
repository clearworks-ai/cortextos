import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import type { AgentConfig } from '../../src/types/index';

/**
 * Task 2.5: `AgentManager` becomes the supervisor registry, gated by a
 * per-agent `supervised` flag.
 *
 * Deliberately uses the REAL `AgentProcess`, `AgentLifecycleSupervisor`,
 * `AgentProcessRuntimeAdapter`, and `LifecycleStateStore` — only the PTY
 * spawn boundary (agent-pty.js et al) and the unrelated
 * Telegram/FastChecker/CronScheduler/WorkerProcess wiring are faked, mirroring
 * the pattern `tests/unit/daemon/lifecycle-resources.test.ts` (Task 2.1) and
 * `tests/unit/daemon/agent-manager-eviction-race-round4.test.ts` already use.
 * This is what actually proves the supervised wiring end-to-end rather than
 * asserting against a mock that can't disagree with the implementation.
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

// Captured per-agent (index-keyed) onExit handlers so a test can simulate a
// real crash for one agent without affecting the other — same pattern as
// lifecycle-resources.test.ts, generalized to more than one live PTY.
let onExitHandlers: Array<(exitCode: number, signal?: number) => void> = [];

// AgentProcess.runStop()'s REAL teardown body (not mocked here) does its own
// liveness check on the "child pid" via `isChildAlive()` AFTER the graceful
// exit window, and escalates to a REAL `process.kill(childPid, 'SIGKILL')`
// if that check still reports alive. Using this TEST WORKER's own `process.pid`
// as the mocked PTY's pid (a tempting way to get a "genuinely alive" pid past
// `classifyRegistryPid`) is therefore catastrophic: once the mock's `kill()`
// fires the exit callback, the real code still sees the (unrelated, always-
// alive) worker pid as "still alive" and SIGKILLs the test worker itself,
// crashing the whole run with no further output. Spawning one real, cheap,
// disposable child process per PTY instance gives a pid that is genuinely
// alive (satisfies liveness checks) AND safe to kill (it is not the process
// running the tests).
let dummyChildren: ChildProcess[] = [];

function freshMockPty(): typeof mockPty {
  const idx = onExitHandlers.length;
  onExitHandlers.push(() => {});
  const child = spawn('sleep', ['60']);
  dummyChildren.push(child);
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    // Simulate a real PTY: kill() asynchronously triggers the process's own
    // exit, invoking whatever handler AgentProcess registered via onExit()
    // (exactly like a real child process eventually would). Without this,
    // AgentProcess.stop()'s real `Promise.race([exitPromise, sleep(...)])`
    // never sees the exit fire and blocks for the full timeout.
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

let ptyInstances: Array<ReturnType<typeof freshMockPty>> = [];
function nextPty(): typeof mockPty {
  const p = freshMockPty();
  ptyInstances.push(p);
  return p;
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
const { AgentLifecycleSupervisor } = await import('../../src/daemon/lifecycle/supervisor.js');

type AnyAgentManager = InstanceType<typeof AgentManager> & {
  agents: Map<string, { process: { getStatus(): { status: string } }; checker: unknown; supervised?: boolean; supervisor?: unknown }>;
  supervisors: Map<string, unknown>;
};

const INSTANCE_ID = 'lifecycle-manager-test';
const ORG = 'acme';

function supervisorRecordPath(ctxRoot: string, name: string): string {
  return join(ctxRoot, 'state', name, 'lifecycle', 'supervisor.json');
}

describe('Task 2.5: AgentManager supervisor registry, gated by per-agent supervised', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDirA: string;
  let agentDirB: string;

  beforeEach(() => {
    onExitHandlers = [];
    ptyInstances = [];
    dummyChildren = [];
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-manager-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    agentDirA = join(frameworkRoot, 'orgs', ORG, 'agents', 'alice');
    agentDirB = join(frameworkRoot, 'orgs', ORG, 'agents', 'bob');
    mkdirSync(agentDirA, { recursive: true });
    mkdirSync(agentDirB, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const child of dummyChildren) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('stop → supervisor retained, entry retired, desired state durable (supervised: true)', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

    await am.startAgent('alice', agentDirA, config, ORG);
    expect(am.agents.has('alice')).toBe(true);
    expect(am.agents.get('alice')!.supervised).toBe(true);

    await am.stopAgent('alice');

    // Entry retired — no longer mapped.
    expect(am.agents.has('alice')).toBe(false);
    // Supervisor NOT deleted — the in-memory registry (and, more importantly,
    // the durable on-disk record) survives.
    expect(am.supervisors.has('alice')).toBe(true);

    const recordPath = supervisorRecordPath(ctxRoot, 'alice');
    expect(existsSync(recordPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(snapshot.desiredState).toBe('stopped');
  });

  it('boot self-heal against a persisted stopped agent → no start (supervised: true)', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

    await am.startAgent('alice', agentDirA, config, ORG);
    await am.stopAgent('alice');
    expect(am.agents.has('alice')).toBe(false);

    // Simulate a fresh daemon incarnation against the SAME ctxRoot — the
    // durable store from the previous instance is what bootSelfHeal must
    // consult.
    const am2 = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am2.bootSelfHeal(
      [{ name: 'alice', dir: agentDirA, org: ORG, config }],
      {},
    );

    expect(am2.agents.has('alice')).toBe(false);
  });

  it('stale-entry eviction path → owner reconciliation, not manual kill-tree eviction (supervised: true)', async () => {
    let cleanupAm: InstanceType<typeof AgentManager> | undefined;
    vi.useFakeTimers();
    try {
      const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
      const config: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

      await am.startAgent('alice', agentDirA, config, ORG);
      const entryBefore = am.agents.get('alice')!;
      expect(entryBefore.process.getStatus().status).toBe('running');

      const reconcileSpy = vi.spyOn(am as unknown as { reconcileSupervisedRestart: (...a: unknown[]) => unknown }, 'reconcileSupervisedRestart');

      // Simulate a real crash: fire the mocked PTY's captured onExit handler.
      // AgentProcess is REAL here, so this runs the real handleExit()/
      // classifyExit() path and sets status to 'crashed' synchronously,
      // scheduling a real (fake-timer-frozen) backoff restart we never let
      // fire in this test.
      onExitHandlers[0](1);
      expect(entryBefore.process.getStatus().status).not.toBe('running');

      // Re-entering startAgent() for the same name now hits the "in registry
      // but not actually alive" branch. For a supervised agent this must
      // route through owner reconciliation, not the legacy eviction's
      // manual kill-tree/unmap/reconstruct path.
      await am.startAgent('alice', agentDirA, config, ORG);

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      // Same AgentEntry AND same AgentProcess instance reused — proof no
      // manager-local stop/unmap/reconstruct path bypassed verified
      // retirement (a legacy eviction would have deleted-and-reconstructed
      // both).
      const entryAfter = am.agents.get('alice')!;
      expect(entryAfter).toBe(entryBefore);
      expect(entryAfter.process).toBe(entryBefore.process);
      expect(entryAfter.process.getStatus().status).toBe('running');

      // Clean teardown, deferred to after real timers are restored (below) —
      // leaving a live AgentProcess (session timer, etc.) running past the
      // end of this test risks it firing after `afterEach` deletes the temp
      // ctxRoot.
      cleanupAm = am;
    } finally {
      vi.useRealTimers();
    }
    await cleanupAm!.stopAgent('alice');
  });

  it("a supervised:false agent's startAgent/stopAgent/restartAgent/bootSelfHeal is byte-for-byte unchanged (mixed-fleet safety net)", async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const config: AgentConfig = { startup_delay: 0, runtime: 'codex-app-server' }; // supervised absent

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    await am.startAgent('alice', agentDirA, config, ORG);
    const entry = am.agents.get('alice')!;
    expect(entry.supervised).toBeFalsy();
    // A durable record is still created for later cutover (Task 1.4 lazy
    // adoption) — but no supervisor request is ever issued for it.
    expect(am.supervisors.has('alice')).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();

    await am.restartAgent('alice');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(am.agents.has('alice')).toBe(true);

    await am.stopAgent('alice');
    expect(requestSpy).not.toHaveBeenCalled();
    // Legacy end-state: entry fully unmapped, exactly as before this task.
    expect(am.agents.has('alice')).toBe(false);

    const am2 = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am2.bootSelfHeal(
      [{ name: 'alice', dir: agentDirA, org: ORG, config }],
      {},
    );
    // Legacy bootSelfHeal never consults persisted desired state — it always
    // retries a "missing" enabled agent, so alice comes back.
    expect(am2.agents.has('alice')).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();

    // Clean teardown — avoid leaking a live AgentProcess past this test.
    await am2.stopAgent('alice');
  });

  it('one supervised:true agent and one supervised:false agent running simultaneously — no cross-contamination', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    const supervisedConfig: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };
    const legacyConfig: AgentConfig = { startup_delay: 0, runtime: 'codex-app-server' };

    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    await am.startAgent('bob', agentDirB, legacyConfig, ORG);

    const aliceEntry = am.agents.get('alice')!;
    const bobEntry = am.agents.get('bob')!;
    expect(aliceEntry.supervised).toBe(true);
    expect(bobEntry.supervised).toBeFalsy();
    expect(aliceEntry.supervisor).not.toBe(bobEntry.supervisor);

    const aliceRequestSpy = vi.spyOn(aliceEntry.supervisor as InstanceType<typeof AgentLifecycleSupervisor>, 'request');
    const bobRequestSpy = vi.spyOn(bobEntry.supervisor as InstanceType<typeof AgentLifecycleSupervisor>, 'request');

    // Stop alice (supervised) — bob must be completely untouched.
    await am.stopAgent('alice');
    expect(am.agents.has('alice')).toBe(false);
    expect(am.agents.has('bob')).toBe(true);
    expect(bobEntry.process.getStatus().status).toBe('running');
    expect(aliceRequestSpy).toHaveBeenCalledTimes(1);
    expect(bobRequestSpy).not.toHaveBeenCalled();

    // Restart bob (legacy) — alice's supervisor must never be touched again.
    await am.restartAgent('bob');
    expect(am.agents.has('bob')).toBe(true);
    expect(aliceRequestSpy).toHaveBeenCalledTimes(1);
    expect(bobRequestSpy).not.toHaveBeenCalled();

    // Clean teardown — avoid leaking a live AgentProcess past this test.
    await am.stopAgent('bob');
  });
});
