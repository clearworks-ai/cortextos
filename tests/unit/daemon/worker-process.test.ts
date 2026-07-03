import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture PTY exit handler so tests can simulate worker exit
let capturedOnExit: ((code: number) => void) | null = null;
let capturedPtyConfig: unknown = null;
let agentPtyCtorCalls = 0;
const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};

// Separate mock for the opencode runtime path (WS8) — mirrors
// tests/unit/daemon/agent-process-opencode.test.ts
let capturedOpencodeArgs: { env: unknown; config: unknown; logPath: unknown } | null = null;
const mockOpencodePty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(13579),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY(_env: unknown, config: unknown) {
    agentPtyCtorCalls++;
    capturedPtyConfig = config;
    return mockPty;
  },
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY(env: unknown, config: unknown, logPath: unknown) {
    capturedOpencodeArgs = { env, config, logPath };
    return mockOpencodePty;
  },
}));

// Mock the opencode-binary which-check so no real binary is needed
const mockSpawnSync = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: vi.fn() };
});

const { WorkerProcess } = await import('../../../src/daemon/worker-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'test-worker',
  agentDir: '/tmp/project',
  org: 'testorg',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  capturedPtyConfig = null;
  capturedOpencodeArgs = null;
  agentPtyCtorCalls = 0;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockOpencodePty.spawn.mockClear();
  mockOpencodePty.kill.mockClear();
  mockOpencodePty.write.mockClear();
  mockInjectMessage.mockClear();
  mockSpawnSync.mockReset().mockReturnValue({ status: 0 });
});

describe('WorkerProcess', () => {
  describe('construction', () => {
    it('sets name, dir, parent', () => {
      const w = new WorkerProcess('w1', '/tmp/proj', 'parent-agent');
      expect(w.name).toBe('w1');
      expect(w.dir).toBe('/tmp/proj');
      expect(w.parent).toBe('parent-agent');
    });

    it('parent is optional', () => {
      const w = new WorkerProcess('w2', '/tmp/proj', undefined);
      expect(w.parent).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('returns starting status before spawn', () => {
      const w = new WorkerProcess('w3', '/tmp/proj', 'parent');
      const s = w.getStatus();
      expect(s.status).toBe('starting');
      expect(s.name).toBe('w3');
      expect(s.dir).toBe('/tmp/proj');
      expect(s.parent).toBe('parent');
      expect(s.spawnedAt).toBeTruthy();
      expect(s.pid).toBeUndefined();
    });

    it('returns running after spawn', async () => {
      const w = new WorkerProcess('w4', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'do the task');
      expect(w.getStatus().status).toBe('running');
      expect(w.getStatus().pid).toBe(12345);
    });
  });

  describe('isFinished', () => {
    it('is false before spawn', () => {
      const w = new WorkerProcess('w5', '/tmp/proj', undefined);
      expect(w.isFinished()).toBe(false);
    });

    it('is false while running', async () => {
      const w = new WorkerProcess('w6', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.isFinished()).toBe(false);
    });

    it('is true after successful exit', async () => {
      const w = new WorkerProcess('w7', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(w.isFinished()).toBe(true);
    });
  });

  describe('inject', () => {
    it('returns false before spawn', () => {
      const w = new WorkerProcess('w8', '/tmp/proj', undefined);
      expect(w.inject('nudge')).toBe(false);
      expect(mockInjectMessage).not.toHaveBeenCalled();
    });

    it('injects text when running', async () => {
      const w = new WorkerProcess('w9', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(w.inject('continue with phase 3')).toBe(true);
      expect(mockInjectMessage).toHaveBeenCalled();
    });

    it('returns false after exit', async () => {
      const w = new WorkerProcess('w10', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(w.inject('too late')).toBe(false);
    });
  });

  describe('onDone callback', () => {
    it('fires with exit code 0 and marks completed', async () => {
      const w = new WorkerProcess('w11', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      expect(doneSpy).toHaveBeenCalledWith('w11', 0);
      expect(w.getStatus().status).toBe('completed');
      expect(w.getStatus().exitCode).toBe(0);
    });

    it('marks status as failed on non-zero exit', async () => {
      const w = new WorkerProcess('w12', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(1);
      expect(w.getStatus().status).toBe('failed');
      expect(w.getStatus().exitCode).toBe(1);
    });
  });

  describe('model config (#283)', () => {
    it('passes empty config to AgentPTY when no model arg is supplied', async () => {
      const w = new WorkerProcess('w-model-default', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(capturedPtyConfig).toEqual({});
    });

    it('threads model into AgentPTY config when supplied', async () => {
      const w = new WorkerProcess('w-model-explicit', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task', { model: 'claude-opus-4-7' });
      expect(capturedPtyConfig).toEqual({ model: 'claude-opus-4-7' });
    });
  });

  describe('runtime config (WS8)', () => {
    const originalOpenrouterKey = process.env.OPENROUTER_API_KEY;

    afterEach(() => {
      if (originalOpenrouterKey !== undefined) {
        process.env.OPENROUTER_API_KEY = originalOpenrouterKey;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    });

    it('default spawn constructs AgentPTY with the same args as before (no OpencodePTY, no which-check)', async () => {
      const w = new WorkerProcess('w-rt-default', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      expect(agentPtyCtorCalls).toBe(1);
      expect(capturedPtyConfig).toEqual({});
      expect(capturedOpencodeArgs).toBeNull();
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(mockPty.spawn).toHaveBeenCalledWith('fresh', 'task');
    });

    it("runtime:'claude' behaves identically to the default AgentPTY path", async () => {
      const w = new WorkerProcess('w-rt-claude', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task', { model: 'claude-opus-4-7', runtime: 'claude' });
      expect(agentPtyCtorCalls).toBe(1);
      expect(capturedPtyConfig).toEqual({ model: 'claude-opus-4-7' });
      expect(capturedOpencodeArgs).toBeNull();
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("runtime:'opencode' constructs OpencodePTY (not AgentPTY) with env/config/logPath threaded through", async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      const w = new WorkerProcess('w-rt-opencode', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task', { model: 'openrouter/qwen/qwen3-coder', runtime: 'opencode' });

      expect(agentPtyCtorCalls).toBe(0);
      expect(capturedOpencodeArgs).not.toBeNull();
      expect(capturedOpencodeArgs!.env).toBe(mockEnv);
      expect(capturedOpencodeArgs!.config).toEqual({ model: 'openrouter/qwen/qwen3-coder', runtime: 'opencode' });
      expect(capturedOpencodeArgs!.logPath).toBe('/tmp/test-ctx/logs/w-rt-opencode/stdout.log');
      expect(mockOpencodePty.spawn).toHaveBeenCalledWith('fresh', 'task');
      expect(w.getStatus().status).toBe('running');
      expect(w.getStatus().pid).toBe(13579);
    });

    it("runtime:'opencode' passes {model, runtime} config through intact without a model too", async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      const w = new WorkerProcess('w-rt-nomodel', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task', { runtime: 'opencode' });
      expect(capturedOpencodeArgs!.config).toEqual({ runtime: 'opencode' });
    });

    it("rejects with a clear error when the opencode binary is not on PATH", async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      mockSpawnSync.mockReturnValue({ status: 1 });
      const w = new WorkerProcess('w-rt-nobinary', '/tmp/proj', undefined);
      await expect(w.spawn(mockEnv, 'task', { runtime: 'opencode' }))
        .rejects.toThrow(/'opencode' binary is not on PATH/);
      expect(capturedOpencodeArgs).toBeNull();
      expect(agentPtyCtorCalls).toBe(0);
    });

    it('warns (does not fail) when OPENROUTER_API_KEY is missing', async () => {
      delete process.env.OPENROUTER_API_KEY;
      const logSpy = vi.fn();
      const w = new WorkerProcess('w-rt-nokey', '/tmp/proj', undefined, logSpy);
      await w.spawn(mockEnv, 'task', { runtime: 'opencode' });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('OPENROUTER_API_KEY is not set'));
      expect(capturedOpencodeArgs).not.toBeNull();
    });

    it('does not warn about OPENROUTER_API_KEY when it is set', async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      const logSpy = vi.fn();
      const w = new WorkerProcess('w-rt-key', '/tmp/proj', undefined, logSpy);
      await w.spawn(mockEnv, 'task', { runtime: 'opencode' });
      const warnings = logSpy.mock.calls.filter((c) => String(c[0]).includes('OPENROUTER_API_KEY'));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('terminate', () => {
    it('kills the PTY and marks completed', async () => {
      const w = new WorkerProcess('w13', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      await w.terminate();
      expect(mockPty.kill).toHaveBeenCalled();
      expect(w.getStatus().status).toBe('completed');
    });

    it('is a no-op if not running', async () => {
      const w = new WorkerProcess('w14', '/tmp/proj', undefined);
      await w.terminate(); // should not throw
      expect(mockPty.kill).not.toHaveBeenCalled();
    });
  });
});
