import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EffectToken, LifecycleObservation, LifecycleRequest, RequestReceipt } from '../../../src/daemon/lifecycle/types.js';

/**
 * Task 3.8 Step 3: `AgentProcess.injectMessageDetailed()`'s honest
 * "no completion seam available" fallback for Claude/Hermes/OpenCode —
 * dispatched work reaches `needs-review` after the documented window
 * instead of sitting unresolved forever, and CodexAppServerPTY (which has a
 * real `turn/completed` seam, Task 3.4) never gets this fallback scheduled
 * at all.
 *
 * Mirrors `agent-process-inject-dispatch.test.ts`'s mocking harness. Two
 * separate PTY mocks are registered on purpose: `mockAgentPty` exposes
 * `injectMessage` (the real shape of `AgentPTY`/`OpencodePTY`/`HermesPTY`);
 * `mockCodexPty` deliberately does NOT (the real shape of
 * `CodexAppServerPTY`, which models stdin writes itself via `write()`) — so
 * this test proves the runtime-branch guard on real PTY shape, not just on
 * the `config.runtime` string.
 */

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockAgentPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  injectMessage: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

const mockCodexPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(54321),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  setTelegramHandle: vi.fn(),
  onWorkCorrelation: vi.fn(),
  setIntentRevocationCheck: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mockAgentPty; },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/bus/enabled-agents-io.js', () => ({
  readEnabledAgentsMap: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

function effect(overrides: Partial<EffectToken> = {}): EffectToken {
  return { agentId: 'alice', supervisorEpoch: 1, generation: 1, intentRevision: 0, effectId: 'effect-1', ...overrides };
}

function fakeOwner(observe: (event: LifecycleObservation) => void) {
  return {
    request: vi.fn(async (_req: LifecycleRequest): Promise<RequestReceipt> => {
      throw new Error('request() should not be called by these tests');
    }),
    isEffectLive: () => true,
    dispatchedWorkIds: () => [],
    beginDispatch: () => ({ ok: true as const }),
    observe,
  };
}

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockAgentPty, mockCodexPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockClear().mockReturnValue(true);
    pty.onExit.mockClear();
  }
  mockAgentPty.injectMessage.mockClear();
  mockCodexPty.onWorkCorrelation.mockClear();
  mockCodexPty.setIntentRevocationCheck.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentProcess Task 3.8 Step 3 — no-completion-seam needs-review fallback', () => {
  it('Claude (default runtime): dispatched work reaches needs-review after the documented window', async () => {
    vi.useFakeTimers();
    const observed: LifecycleObservation[] = [];
    const ap = new AgentProcess('alice', mockEnv, {}, undefined, true);
    await ap.start();
    ap.setOwner(fakeOwner((e) => observed.push(e)));

    const result = await ap.injectMessageDetailed('hello', effect(), ['work-1']);
    expect(result.ok).toBe(true);
    expect(observed).toHaveLength(0); // not yet — nothing invented immediately

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(observed).toHaveLength(1);
    expect(observed[0].kind).toBe('work-needs-review');
    expect(observed[0].evidence.workIds).toBe(JSON.stringify(['work-1']));
    expect(String(observed[0].evidence.reason)).toContain('no-completion-seam-available');
    expect(String(observed[0].evidence.reason)).toContain('claude');
  });

  it('OpenCode: same honest needs-review fallback, reason names the runtime', async () => {
    vi.useFakeTimers();
    const observed: LifecycleObservation[] = [];
    const ap = new AgentProcess('alice', mockEnv, { runtime: 'opencode' }, undefined, true);
    await ap.start();
    ap.setOwner(fakeOwner((e) => observed.push(e)));

    await ap.injectMessageDetailed('hello', effect(), ['work-oc-1']);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(observed).toHaveLength(1);
    expect(observed[0].kind).toBe('work-needs-review');
    expect(String(observed[0].evidence.reason)).toContain('opencode');
  });

  it('Hermes: same honest needs-review fallback, reason names the runtime', async () => {
    vi.useFakeTimers();
    const observed: LifecycleObservation[] = [];
    const ap = new AgentProcess('alice', mockEnv, { runtime: 'hermes' }, undefined, true);
    await ap.start();
    ap.setOwner(fakeOwner((e) => observed.push(e)));

    await ap.injectMessageDetailed('hello', effect(), ['work-hm-1']);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(observed).toHaveLength(1);
    expect(observed[0].kind).toBe('work-needs-review');
    expect(String(observed[0].evidence.reason)).toContain('hermes');
  });

  it('never invents needs-review before the window elapses', async () => {
    vi.useFakeTimers();
    const observed: LifecycleObservation[] = [];
    const ap = new AgentProcess('alice', mockEnv, {}, undefined, true);
    await ap.start();
    ap.setOwner(fakeOwner((e) => observed.push(e)));

    await ap.injectMessageDetailed('hello', effect(), ['work-1']);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1000);
    expect(observed).toHaveLength(0);
  });

  it('Codex app-server: no fallback is ever scheduled — it has a real completion seam (Task 3.4)', async () => {
    vi.useFakeTimers();
    const observed: LifecycleObservation[] = [];
    const ap = new AgentProcess('alice', mockEnv, { runtime: 'codex-app-server' }, undefined, true);
    await ap.start();
    ap.setOwner(fakeOwner((e) => observed.push(e)));

    // CodexAppServerPTY has no injectMessage() — the real production class
    // doesn't either; AgentProcess falls through to injectMessageIntoPty()
    // writing to `write()` directly, which never schedules the fallback.
    const result = await ap.injectMessageDetailed('hello', effect(), ['work-codex-1']);
    expect(result.ok).toBe(true);
    expect(mockCodexPty.write).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(observed).toHaveLength(0);
  });

  it('a workId that legitimately resolves before the window elapses is left untouched (no owner mutation asserted here — see supervisor.test.ts for the illegal-transition guard); the timer still only fires the documented event shape', async () => {
    vi.useFakeTimers();
    const observed: LifecycleObservation[] = [];
    const ap = new AgentProcess('alice', mockEnv, {}, undefined, true);
    await ap.start();
    ap.setOwner(fakeOwner((e) => observed.push(e)));

    await ap.injectMessageDetailed('hello', effect(), ['work-1']);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(observed[0]).toMatchObject({
      kind: 'work-needs-review',
      evidence: expect.objectContaining({
        workIds: JSON.stringify(['work-1']),
        turnId: null,
      }),
    });
  });
});
