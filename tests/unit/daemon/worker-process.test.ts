import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture PTY exit handler so tests can simulate worker exit
let capturedOnExit: ((code: number) => void) | null = null;
let capturedPtyConfig: unknown = null;
const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  onExit: vi.fn().mockImplementation((cb: (code: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY(_env: unknown, config: unknown) {
    capturedPtyConfig = config;
    return mockPty;
  },
}));

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
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockInjectMessage.mockClear();
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

  describe('terminate', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('escalates to kill and marks completed when the session ignores Ctrl-C', async () => {
      vi.useFakeTimers();
      const w = new WorkerProcess('w13', '/tmp/proj', undefined);
      await w.spawn(mockEnv, 'task');
      const done = w.terminate();
      await vi.advanceTimersByTimeAsync(3_000); // graceful window elapses
      await done;
      expect(mockPty.write).toHaveBeenCalledWith('\x03');
      expect(mockPty.kill).toHaveBeenCalled();
      expect(w.getStatus().status).toBe('completed');
    });

    it('skips kill when the session exits gracefully after Ctrl-C', async () => {
      vi.useFakeTimers();
      const w = new WorkerProcess('w13g', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      const done = w.terminate();
      capturedOnExit!(0); // graceful exit inside the wait window
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      expect(mockPty.kill).not.toHaveBeenCalled();
      expect(w.getStatus().status).toBe('completed');
      expect(doneSpy).toHaveBeenCalledTimes(1);
      expect(doneSpy).toHaveBeenCalledWith('w13g', 0);
    });

    it('fires onDone exactly once when escalation strips the exit listener (RW-10)', async () => {
      vi.useFakeTimers();
      const w = new WorkerProcess('w13e', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      const done = w.terminate();
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      // Real AgentPTY.kill() disposes exit listeners before killing, so
      // onExit never fires after escalation — terminate() itself must
      // finalize status and fire onDone, or the AgentManager auto-remove is
      // never scheduled and the workers Map entry becomes immortal.
      expect(doneSpy).toHaveBeenCalledTimes(1);
      expect(doneSpy).toHaveBeenCalledWith('w13e', 0);
      expect(w.isFinished()).toBe(true);
    });

    it('is a no-op if not running', async () => {
      const w = new WorkerProcess('w14', '/tmp/proj', undefined);
      await w.terminate(); // should not throw
      expect(mockPty.kill).not.toHaveBeenCalled();
    });
  });

  describe('max-lifetime self-reap (RW-10)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reaps a hung worker with distinct reaped status and fires onDone', async () => {
      vi.useFakeTimers();
      const w = new WorkerProcess('w-reap', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      await vi.advanceTimersByTimeAsync(10 * 60_000); // reaper timer fires
      await vi.advanceTimersByTimeAsync(3_000); // graceful window elapses → escalate
      expect(mockPty.kill).toHaveBeenCalled();
      expect(w.getStatus().status).toBe('reaped'); // never laundered as 'completed'
      expect(w.isFinished()).toBe(true); // so AgentManager auto-remove clears the Map entry
      expect(doneSpy).toHaveBeenCalledTimes(1);
      expect(doneSpy).toHaveBeenCalledWith('w-reap', 1);
    });

    it('does not reap a worker that already exited', async () => {
      vi.useFakeTimers();
      const w = new WorkerProcess('w-noreap', '/tmp/proj', undefined);
      const doneSpy = vi.fn();
      w.onDone(doneSpy);
      await w.spawn(mockEnv, 'task');
      capturedOnExit!(0);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(mockPty.write).not.toHaveBeenCalled();
      expect(mockPty.kill).not.toHaveBeenCalled();
      expect(w.getStatus().status).toBe('completed');
      expect(doneSpy).toHaveBeenCalledTimes(1);
    });
  });
});
