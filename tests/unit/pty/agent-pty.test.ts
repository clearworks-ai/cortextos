import { beforeEach, describe, it, expect, vi } from 'vitest';

// --- node-pty is native; stub it so constructing/spawning AgentPTY never touches it.
let onDataHandler: ((data: string) => void) | null = null;
let onExitHandler: ((e: { exitCode: number; signal?: number }) => void) | null = null;
let onDataDisposable = { dispose: vi.fn() };
let onExitDisposable = { dispose: vi.fn() };

const mockInnerPty = {
  pid: 42,
  write: vi.fn(),
  onData: vi.fn().mockImplementation((cb: (data: string) => void) => {
    onDataHandler = cb;
    return onDataDisposable;
  }),
  onExit: vi.fn().mockImplementation((cb: (e: { exitCode: number; signal?: number }) => void) => {
    onExitHandler = cb;
    return onExitDisposable;
  }),
  kill: vi.fn(),
  resize: vi.fn(),
};

const spawnMock = vi.fn().mockReturnValue(mockInnerPty);

vi.mock('node-pty', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

const env = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'auditmaster',
  agentDir: '/tmp/fw/orgs/clearworksai/agents/auditmaster',
  org: 'clearworksai',
};

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

beforeEach(() => {
  onDataHandler = null;
  onExitHandler = null;
  onDataDisposable = { dispose: vi.fn() };
  onExitDisposable = { dispose: vi.fn() };
  spawnMock.mockClear();
  mockInnerPty.write.mockClear();
  mockInnerPty.onData.mockClear();
  mockInnerPty.onExit.mockClear();
  mockInnerPty.kill.mockClear();
});

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AgentPTY session isolation', () => {
  it('fresh mode passes NO session flag (Claude mints a new session id)', () => {
    const pty = new AgentPTY(env, {});
    const args = (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');

    // Upstream-aligned (reverted fork-only #20): a fresh start must NOT pin a fixed
    // --session-id — that collides with the existing .jsonl on every force-fresh
    // handoff ("Session ID already in use"). No session flag = brand-new session.
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
  });

  it('continue mode uses --continue (cwd-scoped resume, no fixed id)', () => {
    const pty = new AgentPTY(env, {});
    const args = (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
      .buildClaudeArgs('continue', 'hello');

    expect(args).toContain('--continue');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
  });

  it('fast-fails when a Settings Warning modal appears', async () => {
    vi.useFakeTimers();
    try {
      const pty = new AgentPTY(env, {});
      (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;
      await pty.spawn('fresh', 'boot');
      expect(onDataHandler).not.toBeNull();

      onDataHandler!('Settings Warning\n/Users/joshweiss/code/auditos/.claude/settings.json');
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockInnerPty.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports CTX_PARENT_AGENT when the worker env includes a parent agent', async () => {
    const workerEnv = {
      ...env,
      projectRoot: '/tmp/fw',
      parentAgent: 'frank2',
      worker: true,
    };
    const pty = new AgentPTY(workerEnv as any, {});
    (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;

    await pty.spawn('fresh', 'boot');

    const options = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
    expect(options?.env?.CTX_PARENT_AGENT).toBe('frank2');
  });
});

describe('AgentPTY listener disposal', () => {
  async function spawnPty(): Promise<InstanceType<typeof AgentPTY>> {
    const pty = new AgentPTY(env, {});
    (pty as unknown as { spawnFn: typeof spawnMock }).spawnFn = spawnMock;
    await pty.spawn('fresh', 'boot');
    return pty;
  }

  it('captures the node-pty listener disposables on spawn', async () => {
    const pty = await spawnPty();
    const internals = pty as unknown as {
      onDataDisposable: typeof onDataDisposable | null;
      onExitDisposable: typeof onExitDisposable | null;
    };

    expect(internals.onDataDisposable).toBe(onDataDisposable);
    expect(internals.onExitDisposable).toBe(onExitDisposable);
  });

  it('disposes both listeners exactly once on kill()', async () => {
    const pty = await spawnPty();

    pty.kill();
    pty.kill();

    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(mockInnerPty.kill).toHaveBeenCalledTimes(1);
  });

  it('disposes both listeners on natural exit and does not double-dispose on later kill()', async () => {
    const pty = await spawnPty();

    onExitHandler!({ exitCode: 0 });

    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(() => pty.kill()).not.toThrow();
    expect(onDataDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(onExitDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(mockInnerPty.kill).not.toHaveBeenCalled();
  });
});
