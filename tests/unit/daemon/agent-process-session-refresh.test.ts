import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { BusPaths, AgentConfig, CtxEnv } from '../../../src/types/index';
import { canonicalAgentId } from '../../../src/daemon/lifecycle/types';
import { LifecycleStateStore } from '../../../src/daemon/lifecycle/state-store';
import { AgentLifecycleSupervisor } from '../../../src/daemon/lifecycle/supervisor';

/**
 * Task 2.4: Scenario B closure ("I stopped it, but another copy came
 * back") — `sessionRefresh()`'s `supervised: true`/`false` branches.
 *
 * Mirrors `tests/unit/daemon/lifecycle-resources.test.ts`'s infra exactly
 * (same fake-PTY-constructor mocks, same real fs-backed `LifecycleStateStore`
 * in a tmp dir) rather than `agent-process.test.ts`'s infra, because THAT
 * file globally mocks `fs` module-wide — which would break the real,
 * fs-backed `LifecycleStateStore`/store-lock this task's supervised-path
 * tests need to exercise for real. Only the PTY spawn boundary is faked
 * here; the lifecycle store, supervisor, and adapter all run for real.
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

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

function freshMockPty(): typeof mockPty {
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    write: vi.fn(),
    getPid: vi.fn().mockReturnValue(41001),
    getHostPid: vi.fn().mockReturnValue(41000),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      capturedOnExit = cb;
    }),
    getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true }),
  };
}

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function () { return mockPty; } }));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: function () { return mockPty; } }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function () { return mockPty; },
  hermesDbExists: () => false,
}));
vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function () { return mockPty; },
  opencodeSessionExists: () => false,
}));

// sessionRefresh() (both branches) writes the `.session-refresh` marker via
// `resolvePaths(...)`, which for real would resolve under the REAL user's
// `~/.cortextos/<instance>` — never acceptable from a test. Mocked to point
// at this test's own tmp ctxRoot instead, mirroring agent-process.test.ts's
// own mock of this same module.
vi.mock('../../../src/utils/paths.js', () => ({ resolvePaths: vi.fn() }));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const { AgentProcessRuntimeAdapter } = await import('../../../src/daemon/lifecycle/agent-runtime.js');
const { resolvePaths } = await import('../../../src/utils/paths.js');

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

const NAME = 'alice';
const ORG = 'acme';
const INSTANCE_ID = 'session-refresh-test';

let ctxRoot: string;
let agentDir: string;
let env: CtxEnv;
let config: AgentConfig;
let store: LifecycleStateStore;
let agentId: string;

let reqSeq = 0;
function nextReqId(): string {
  reqSeq += 1;
  return `sr-req-${reqSeq}`;
}

beforeEach(() => {
  capturedOnExit = null;
  mockPty = freshMockPty();
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-session-refresh-test-'));
  agentDir = join(ctxRoot, 'agents', NAME);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(ctxRoot, 'state', NAME), { recursive: true });
  env = {
    instanceId: INSTANCE_ID,
    ctxRoot,
    frameworkRoot: ctxRoot,
    agentName: NAME,
    agentDir,
    org: ORG,
    projectRoot: ctxRoot,
  };
  config = {};
  agentId = canonicalAgentId({ instanceId: INSTANCE_ID, org: ORG, name: NAME });
  vi.mocked(resolvePaths).mockReturnValue(fakeBusPaths(ctxRoot, NAME));
  store = new LifecycleStateStore(fakeBusPaths(ctxRoot, NAME), agentId);
  const adopted = store.adopt('stopped');
  if (!adopted.ok) throw new Error(`test setup: adopt failed: ${adopted.message}`);
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

function buildSupervisedProcess(): { ap: InstanceType<typeof AgentProcess>; supervisor: AgentLifecycleSupervisor } {
  const ap = new AgentProcess(NAME, env, config, () => { /* silence */ }, true);
  const adapter = new AgentProcessRuntimeAdapter(ap, store, config.runtime, env);
  const supervisor = new AgentLifecycleSupervisor(agentId, store, adapter);
  ap.setOwner(supervisor);
  return { ap, supervisor };
}

function startReq() {
  return { requestId: nextReqId(), kind: 'start' as const, cause: 'manual-cli' as const, mode: 'continue' as const, observedGeneration: null, userInitiated: true, evidence: {}, requestedAtMs: Date.now() };
}

function stopReq() {
  return { requestId: nextReqId(), kind: 'stop' as const, cause: 'manual-cli' as const, mode: null, observedGeneration: null, userInitiated: true, evidence: {}, requestedAtMs: Date.now() };
}

describe('AgentProcess.sessionRefresh() — supervised: true, Scenario B closure', () => {
  it('overlapping refresh + explicit stop mid-flight: newStarts === 0, ends stopped, durable after reload', async () => {
    const { ap, supervisor } = buildSupervisedProcess();

    vi.useFakeTimers();
    try {
      // Generation 1: real start through the owner.
      const started = await supervisor.request(startReq());
      expect(started.accepted).toBe(true);
      expect(started.generation).toBe(1);
      expect(mockPty.spawn).toHaveBeenCalledTimes(1);

      // Session-age refresh, submitted through the owner (supervised path).
      // By the time this receipt resolves, the retire→start operation's
      // retire phase has ALREADY entered runStop()'s real teardown body
      // (clearSessionTimer + pty capture already ran synchronously, and the
      // graceful-shutdown sequence is now suspended at its first internal
      // sleep) — see this test file's design notes: entry.resolve() for the
      // refresh's own receipt is queued as a microtask BEFORE
      // `void this.runRestart(...)` is invoked, so runRestart's fully
      // synchronous prefix (down through retireGeneration -> runStopFenced
      // -> runStop -> first `await sleep(...)`) always completes before this
      // await below ever resumes.
      const refreshReceipt = await ap.sessionRefresh();
      expect(refreshReceipt).toBeDefined();
      expect(refreshReceipt!.accepted).toBe(true);
      expect(refreshReceipt!.generation).toBe(2); // new generation allocated

      // Genuinely mid-flight: the explicit stop lands while the refresh's
      // retire phase is already in progress, not merely "before the timer
      // fired" — the timer never fired at all here, sessionRefresh() was
      // called directly.
      const stopReceipt = await supervisor.request(stopReq());
      expect(stopReceipt.accepted).toBe(true);
      expect(stopReceipt.desiredState).toBe('stopped');

      // Let the real (generation-1) PTY actually die, then drain the
      // graceful-shutdown sleeps. Bounded advance (not vi.runAllTimersAsync)
      // deliberately avoids ever reaching the ~71h session-age timer scale.
      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }

    // The load-bearing assertion: the revoked refresh's start-half must
    // never have spawned a successor process.
    expect(mockPty.spawn).toHaveBeenCalledTimes(1); // newStarts === 0
    expect(ap.getStatus().status).toBe('stopped');

    const reloaded = store.load();
    expect('corrupt' in reloaded).toBe(false);
    if (!('corrupt' in reloaded)) {
      expect(reloaded.desiredState).toBe('stopped');
    }
  });

  it('serial control: refresh completes (retire gen1, start gen2) before a later stop — still ends stopped', async () => {
    const { ap, supervisor } = buildSupervisedProcess();

    vi.useFakeTimers();
    try {
      const started = await supervisor.request(startReq());
      expect(started.generation).toBe(1);

      const refreshReceipt = await ap.sessionRefresh();
      expect(refreshReceipt!.accepted).toBe(true);
      expect(refreshReceipt!.generation).toBe(2);

      // Let generation 1 fully retire AND generation 2 fully start, with
      // nothing else contending — the positive control proving the fix
      // didn't just make refresh always lose.
      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(ap.getStatus().status).toBe('running');
      expect(mockPty.spawn).toHaveBeenCalledTimes(2); // gen1 + gen2, both real starts

      // Only NOW submit the stop — well after the refresh has settled.
      const stopReceipt = await supervisor.request(stopReq());
      expect(stopReceipt.accepted).toBe(true);
      expect(stopReceipt.desiredState).toBe('stopped');

      // capturedOnExit now points at generation 2's onExit registration.
      capturedOnExit?.(0, 0);
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }

    expect(ap.getStatus().status).toBe('stopped');
    const reloaded = store.load();
    expect('corrupt' in reloaded).toBe(false);
    if (!('corrupt' in reloaded)) {
      expect(reloaded.desiredState).toBe('stopped');
    }
  });

  it('a refresh whose observedGeneration is stale returns accepted:false with a revocation reason', async () => {
    const { ap, supervisor } = buildSupervisedProcess();

    const started = await supervisor.request(startReq());
    expect(started.generation).toBe(1);

    // Force desync between this AgentProcess instance's own generation
    // counter and the supervisor's real currentGeneration, simulating the
    // observedGeneration this call submits being stale by the time the
    // owner actually evaluates it.
    (ap as unknown as { lifecycleGeneration: number }).lifecycleGeneration = 999;

    const receipt = await ap.sessionRefresh();
    expect(receipt).toBeDefined();
    expect(receipt!.accepted).toBe(false);
    expect(receipt!.blockedReason).toMatch(/revoked/);
  });
});

describe('AgentProcess.sessionRefresh() — supervised: false/absent (default): unchanged legacy behavior', () => {
  it('performs the plain stop()/start() pair exactly as today, with no LifecycleRequest ever constructed', async () => {
    // supervised defaults to false — constructed WITHOUT passing `true`.
    const ap = new AgentProcess(NAME, env, config, () => { /* silence */ });

    const ownerRequestSpy = vi.fn();
    // Wire an owner anyway (setOwner is a no-op-safe call) to prove that
    // merely having an owner available does not activate the supervised
    // branch — only the constructor's `supervised` flag gates it.
    ap.setOwner({ request: ownerRequestSpy });

    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    const result = await ap.sessionRefresh();

    expect(result).toBeUndefined();
    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);

    // The load-bearing assertion for this branch: the owner is NEVER
    // consulted when supervised is false/absent.
    expect(ownerRequestSpy).not.toHaveBeenCalled();
  });
});
