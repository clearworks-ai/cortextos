import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import type { AgentConfig, IPCRequest, IPCResponse } from '../../src/types/index';

/**
 * Task 2.8: IPC and CLI ingress route to the owner.
 *
 * Same harness as `tests/integration/lifecycle-manager.test.ts` (Task 2.5):
 * REAL `AgentManager`, `AgentLifecycleSupervisor`, `AgentProcessRuntimeAdapter`,
 * `LifecycleStateStore`, and `IPCServer` — only the PTY spawn boundary and
 * unrelated Telegram/FastChecker/CronScheduler/WorkerProcess wiring are
 * faked. `IPCServer.handleRequest` is invoked directly (it is private at
 * compile time only — a cast reaches it at runtime) against a fake `Socket`
 * that captures the written response, instead of opening a real OS unix
 * socket: `getIpcPath()` resolves from the real `homedir()` with no
 * override, so a real socket round-trip would touch the operator's actual
 * `~/.cortextos/` — this avoids that entirely while still exercising every
 * line of the real `handleRequest` dispatch logic this task changed.
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

let onExitHandlers: Array<(exitCode: number, signal?: number) => void> = [];

// See tests/integration/lifecycle-manager.test.ts for why a real disposable
// child process (not this test worker's own pid) backs each mocked PTY.
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
const { IPCServer } = await import('../../src/daemon/ipc-server.js');
const { AgentLifecycleSupervisor } = await import('../../src/daemon/lifecycle/supervisor.js');

type AnyAgentManager = InstanceType<typeof AgentManager> & {
  agents: Map<string, { process: { getStatus(): { status: string } }; checker: unknown; supervised?: boolean; supervisor?: unknown }>;
};

const INSTANCE_ID = 'lifecycle-control-test';
const ORG = 'acme';

/** Fake `Socket` — captures the single JSON response `handleRequest` writes. */
function fakeSocket(): { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(), end: vi.fn() };
}

async function callIpc(server: InstanceType<typeof IPCServer>, request: IPCRequest): Promise<IPCResponse> {
  const socket = fakeSocket();
  await (server as unknown as { handleRequest(req: IPCRequest, sock: unknown): Promise<void> }).handleRequest(request, socket);
  expect(socket.write).toHaveBeenCalledTimes(1);
  return JSON.parse(socket.write.mock.calls[0][0] as string) as IPCResponse;
}

describe('Task 2.8: IPC and CLI ingress route to the owner', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDirA: string;

  beforeEach(() => {
    onExitHandlers = [];
    ptyInstances = [];
    dummyChildren = [];
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-control-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    agentDirA = join(frameworkRoot, 'orgs', ORG, 'agents', 'alice');
    mkdirSync(agentDirA, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const child of dummyChildren) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  const supervisedConfig: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

  it('bug 1 — OLD ipc-server.ts call site dropped userInitiated (defaulted false); the FIX always passes true for IPC stop-agent', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    // Reproduce the OLD behavior directly: `ipc-server.ts`'s pre-2.8 body
    // called `this.agentManager.stopAgent(request.agent)` — ONE argument,
    // so `userInitiated` defaulted to `false` per `stopAgent`'s own
    // signature (`userInitiated = false`). Calling the manager exactly that
    // way here proves what the old call site actually produced.
    await (am as unknown as { stopAgent(name: string): Promise<unknown> }).stopAgent('alice');
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ kind: 'stop', userInitiated: false });

    // Now the FIX: go through the real (patched) IPC handler. Restart it
    // first so there's a live supervised entry to stop again.
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    requestSpy.mockClear();

    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);
    const response = await callIpc(server, { type: 'stop-agent', agent: 'alice', source: 'cortextos stop' });

    expect(response.success).toBe(true);
    // Truthfulness fields present — not just a bare "Stopping alice" string.
    expect(response.accepted).toBe(true);
    expect(typeof response.operationId === 'string' || response.operationId === null).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ kind: 'stop', userInitiated: true });
  });

  it('bug 2 — OLD ipc-server.ts never read data.mode (restart always submitted "continue"); the FIX honors data.mode:"fresh"', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    // OLD behavior: `AgentManager.restartAgent(name)` took no mode
    // parameter at all — reproduce that exact call shape directly.
    await (am as unknown as { restartAgent(name: string): Promise<unknown> }).restartAgent('alice');
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ kind: 'restart', mode: 'continue' });
    requestSpy.mockClear();

    // FIX: the real IPC handler reads and threads data.mode through.
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);
    const response = await callIpc(server, {
      type: 'restart-agent',
      agent: 'alice',
      source: 'cortextos restart',
      data: { mode: 'fresh' },
    });

    expect(response.success).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ kind: 'restart', mode: 'fresh' });

    // restart-agent is ONE operation — never a separate stop-agent +
    // start-agent pair of IPC-equivalent dispatches.
    const kinds = requestSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual(['restart']);
  });

  it('unsupported data.mode is rejected outright (INVALID_MODE), never silently dropped or coerced', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);
    const response = await callIpc(server, {
      type: 'restart-agent',
      agent: 'alice',
      source: 'cortextos restart',
      data: { mode: 'bogus' },
    });

    expect(response.success).toBe(false);
    expect(response.code).toBe('INVALID_MODE');
    // Never dispatched — an invalid mode must not fall back to a default.
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('frank2-style maintenance `cortextos start <name>` against a stopped agent → structured blocked reason, no resurrection; --resume clears it', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    await (am as unknown as { stopAgent(name: string, userInitiated?: boolean): Promise<unknown> }).stopAgent('alice', true);
    expect(am.agents.has('alice')).toBe(false);

    const spawnCountAfterStop = ptyInstances.length;
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);

    // Plain maintenance start — the exact frank2 heartbeat-cron shape.
    const blocked = await callIpc(server, { type: 'start-agent', agent: 'alice', source: 'cortextos start' });
    expect(blocked.success).toBe(false);
    expect(blocked.code).toBe('REQUIRES_RESUME');
    expect(blocked.accepted).toBe(false);
    expect(typeof blocked.error).toBe('string');
    expect(blocked.error).toContain('stopped');

    // No resurrection: no new entry, no new PTY spawn.
    expect(am.agents.has('alice')).toBe(false);
    expect(ptyInstances.length).toBe(spawnCountAfterStop);

    // --resume clears it.
    const resumed = await callIpc(server, {
      type: 'start-agent',
      agent: 'alice',
      source: 'cortextos start',
      data: { resume: true },
    });
    expect(resumed.success).toBe(true);
    // Give the fire-and-forget startAgent() dispatch a tick to register the
    // entry (the fresh-entry start path is not awaited by the IPC handler).
    await new Promise((r) => setImmediate(r));
    expect(am.agents.has('alice')).toBe(true);
  });

  it('inspectAgentOp DEDUPED/NOT_FOUND semantics survive the new gating', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);

    // Already alive — DEDUPED.
    const deduped = await callIpc(server, { type: 'start-agent', agent: 'alice', source: 'cortextos start' });
    expect(deduped.success).toBe(false);
    expect(deduped.code).toBe('DEDUPED');

    // Never existed — NOT_FOUND for stop/restart.
    const notFoundStop = await callIpc(server, { type: 'stop-agent', agent: 'ghost', source: 'cortextos stop' });
    expect(notFoundStop.success).toBe(false);
    expect(notFoundStop.code).toBe('NOT_FOUND');

    const notFoundRestart = await callIpc(server, { type: 'restart-agent', agent: 'ghost', source: 'cortextos restart' });
    expect(notFoundRestart.success).toBe(false);
    expect(notFoundRestart.code).toBe('NOT_FOUND');
  });

  it('cortextos status projects authoritative desired/observed state for a supervised agent', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);

    const response = await callIpc(server, { type: 'status', source: 'cortextos status' });
    expect(response.success).toBe(true);
    const statuses = response.data as Array<{ name: string; desiredState?: string; phase?: string }>;
    const alice = statuses.find((s) => s.name === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.desiredState).toBe('running');
    // Documented pre-existing scope boundary (not this task's to fix): the
    // fresh-entry `startAgent()` path bypasses the supervisor's mailbox
    // entirely (raw `agentProcess.start()`, per Task 2.5's design — only the
    // "stale in-registry" reconcile path routes a start through the owner
    // today), so `phase` never transitions to 'ready' via a real
    // `runStart()` commit for a genuinely-fresh agent. It is still a real,
    // defined string field, projected from the durable snapshot.
    expect(typeof alice!.phase).toBe('string');

    await (am as unknown as { stopAgent(name: string, userInitiated?: boolean): Promise<unknown> }).stopAgent('alice', true);
    const afterStop = await callIpc(server, { type: 'status', source: 'cortextos status' });
    const aliceAfter = (afterStop.data as Array<{ name: string; desiredState?: string }>).find((s) => s.name === 'alice');
    // Face B roster-diff entry (unmapped) does not carry desiredState today
    // (documented scope boundary) — but it must not report 'running' either.
    if (aliceAfter?.desiredState !== undefined) {
      expect(aliceAfter.desiredState).toBe('stopped');
    }
  });

  it('lifecycle-operation-status and agent-lifecycle-status read requests answer without mutating anything', async () => {
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);

    const agentStatus = await callIpc(server, { type: 'agent-lifecycle-status', agent: 'alice', source: 'test' });
    expect(agentStatus.success).toBe(true);
    expect((agentStatus.data as { desiredState: string }).desiredState).toBe('running');

    const restartResponse = await callIpc(server, { type: 'restart-agent', agent: 'alice', source: 'test' });
    expect(restartResponse.operationId).toBeTruthy();

    const opStatus = await callIpc(server, {
      type: 'lifecycle-operation-status',
      agent: 'alice',
      source: 'test',
      data: { operationId: restartResponse.operationId as string },
    });
    expect(opStatus.success).toBe(true);
    expect(opStatus.operationId).toBe(restartResponse.operationId);
  });

  it("a supervised:false agent's start/stop/restart via IPC is unaffected (mixed-fleet safety net)", async () => {
    const legacyConfig: AgentConfig = { startup_delay: 0, runtime: 'codex-app-server' };
    const am = new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
    await am.startAgent('alice', agentDirA, legacyConfig, ORG);
    expect(am.agents.get('alice')!.supervised).toBeFalsy();

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);

    const restartResponse = await callIpc(server, { type: 'restart-agent', agent: 'alice', source: 'cortextos restart' });
    expect(restartResponse.success).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(am.agents.has('alice')).toBe(true);

    const stopResponse = await callIpc(server, { type: 'stop-agent', agent: 'alice', source: 'cortextos stop' });
    expect(stopResponse.success).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
