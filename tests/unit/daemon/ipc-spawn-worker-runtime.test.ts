/**
 * tests/unit/daemon/ipc-spawn-worker-runtime.test.ts — WS8
 *
 * Unit tests for the `runtime` field on the spawn-worker IPC command:
 *   - 'opencode' and 'claude' are accepted and forwarded to
 *     AgentManager.spawnWorker as the sixth argument
 *   - omitting runtime forwards undefined (legacy behavior)
 *   - any other value is rejected with success:false and a clear error,
 *     without invoking AgentManager.spawnWorker
 *
 * Drives IPCServer.handleRequest directly with a fake socket (no real
 * unix socket, no real daemon) and a stubbed AgentManager.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Socket } from 'net';
import { IPCServer } from '../../../src/daemon/ipc-server.js';
import type { AgentManager } from '../../../src/daemon/agent-manager.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mockSpawnWorker = vi.fn().mockResolvedValue(undefined);

const fakeAgentManager = {
  spawnWorker: mockSpawnWorker,
} as unknown as AgentManager;

function makeFakeSocket(): { socket: Socket; getResponse: () => { success: boolean; error?: string; data?: unknown } } {
  const write = vi.fn();
  const socket = { write, end: vi.fn() } as unknown as Socket;
  return {
    socket,
    getResponse: () => JSON.parse(String(write.mock.calls[0]?.[0] ?? '{}')),
  };
}

function sendSpawnWorker(data: Record<string, unknown>): { success: boolean; error?: string; data?: unknown } {
  const server = new IPCServer(fakeAgentManager, 'test-instance');
  const { socket, getResponse } = makeFakeSocket();
  (server as unknown as { handleRequest: (req: unknown, s: Socket) => void }).handleRequest(
    { type: 'spawn-worker', source: 'test', data },
    socket,
  );
  return getResponse();
}

// Worker dir must resolve under CTX_ROOT or the daemon cwd; cwd always passes.
const validDir = process.cwd();

beforeEach(() => {
  mockSpawnWorker.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawn-worker IPC runtime field (WS8)', () => {
  it("forwards runtime:'opencode' to AgentManager.spawnWorker", () => {
    const res = sendSpawnWorker({
      name: 'ws8-worker',
      dir: validDir,
      prompt: 'do the task',
      parent: 'larry',
      model: 'openrouter/qwen/qwen3-coder',
      runtime: 'opencode',
    });

    expect(res.success).toBe(true);
    expect(mockSpawnWorker).toHaveBeenCalledWith(
      'ws8-worker', validDir, 'do the task', 'larry', 'openrouter/qwen/qwen3-coder', 'opencode',
    );
  });

  it("accepts runtime:'claude' explicitly", () => {
    const res = sendSpawnWorker({
      name: 'ws8-claude',
      dir: validDir,
      prompt: 'do the task',
      runtime: 'claude',
    });

    expect(res.success).toBe(true);
    expect(mockSpawnWorker).toHaveBeenCalledWith(
      'ws8-claude', validDir, 'do the task', undefined, undefined, 'claude',
    );
  });

  it('forwards undefined runtime when omitted (legacy behavior)', () => {
    const res = sendSpawnWorker({
      name: 'ws8-legacy',
      dir: validDir,
      prompt: 'do the task',
    });

    expect(res.success).toBe(true);
    expect(mockSpawnWorker).toHaveBeenCalledWith(
      'ws8-legacy', validDir, 'do the task', undefined, undefined, undefined,
    );
  });

  it('rejects an invalid runtime with a clear error and does not spawn', () => {
    const res = sendSpawnWorker({
      name: 'ws8-bad',
      dir: validDir,
      prompt: 'do the task',
      runtime: 'gpt-5',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid worker runtime "gpt-5"');
    expect(res.error).toContain("'claude' or 'opencode'");
    expect(mockSpawnWorker).not.toHaveBeenCalled();
  });

  it('still validates name/dir/prompt before runtime', () => {
    const res = sendSpawnWorker({ name: 'ws8-missing', runtime: 'opencode' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('spawn-worker requires: name, dir, prompt');
    expect(mockSpawnWorker).not.toHaveBeenCalled();
  });
});
