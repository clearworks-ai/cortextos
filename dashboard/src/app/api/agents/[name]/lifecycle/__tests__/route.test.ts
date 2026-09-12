import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Task 2.9: `dashboard/src/app/api/agents/[name]/lifecycle/route.ts` must
 * stop racing an independent `enabled-agents.json` registry write against
 * the IPC result, and its DELETE handler must gate destructive work on a
 * VERIFIED `retired` outcome rather than a best-effort, fire-and-forget
 * stop. These tests exercise the handler directly (no browser — this is a
 * plain Next.js API route with no UI change, per PHASES.md's Tools
 * Reference table) against a fully mocked IPC client and filesystem.
 */

const send = vi.fn();

vi.mock('@/lib/ipc-client', () => ({
  // Task 2.9: `IPCClient` is instantiated with `new` in route.ts — an arrow
  // function cannot serve as a constructor (vitest's mock machinery invokes
  // `Reflect.construct` under `new`), so this MUST be a plain function
  // expression, not `() => ({ send })`.
  IPCClient: vi.fn().mockImplementation(function IPCClientMock() {
    return { send };
  }),
}));

const readFile = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn();
const rm = vi.fn();

vi.mock('fs/promises', () => ({
  default: { readFile, writeFile, mkdir, rm },
  readFile,
  writeFile,
  mkdir,
  rm,
}));

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => '/framework',
  getCTXRoot: () => '/ctx-root',
}));

let POST: typeof import('../route').POST;
let DELETE: typeof import('../route').DELETE;

beforeEach(async () => {
  vi.resetModules();
  send.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  mkdir.mockReset();
  rm.mockReset();
  mkdir.mockResolvedValue(undefined);
  writeFile.mockResolvedValue(undefined);
  rm.mockResolvedValue(undefined);
  readFile.mockRejectedValue(new Error('ENOENT'));

  const route = await import('../route');
  POST = route.POST;
  DELETE = route.DELETE;
});

function postRequest(agent: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/agents/${agent}/lifecycle`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function deleteRequest(agent: string, query = '') {
  return new NextRequest(`http://localhost/api/agents/${agent}/lifecycle${query}`, {
    method: 'DELETE',
  });
}

describe('POST /api/agents/[name]/lifecycle — enable', () => {
  it('does NOT write the registry when start-agent is rejected (REQUIRES_RESUME)', async () => {
    send.mockResolvedValue({
      success: false,
      accepted: false,
      error: 'refusing plain start: "abe" was explicitly stopped',
      code: 'REQUIRES_RESUME',
      blockedReason: 'explicitly stopped',
    });

    const response = await POST(postRequest('abe', { action: 'enable' }), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).not.toBe(200);
    expect(writeFile).not.toHaveBeenCalled();
    // Confirms enable sends an explicit resume intent, mirroring `cortextos
    // start --resume` — never an unqualified plain start.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start-agent', agent: 'abe', data: { resume: true } }),
    );
  });

  it('writes the registry only AFTER a confirmed-accepted start-agent response', async () => {
    send.mockResolvedValue({ success: true, accepted: true, operationId: 'op-1', phase: 'starting' });

    const response = await POST(postRequest('abe', { action: 'enable' }), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).toBe(200);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, contents] = writeFile.mock.calls[0];
    expect(JSON.parse(contents as string)).toEqual({ abe: { enabled: true } });
  });

  it('still writes the registry (soft success) when the daemon is not running', async () => {
    send.mockResolvedValue({
      success: false,
      error: 'Daemon is not running. Start it with: cortextos start',
    });

    const response = await POST(postRequest('abe', { action: 'enable' }), {
      params: Promise.resolve({ name: 'abe' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.output).toContain('daemon not running');
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/agents/[name]/lifecycle — disable', () => {
  it('does NOT write the registry when stop-agent is rejected', async () => {
    send.mockResolvedValue({ success: true, accepted: false, blockedReason: 'blocked retirement pending' });

    const response = await POST(postRequest('abe', { action: 'disable' }), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).not.toBe(200);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes the registry only AFTER a confirmed-accepted stop-agent response', async () => {
    readFile.mockResolvedValue(JSON.stringify({ abe: { enabled: true, org: 'acme' } }));
    send.mockResolvedValue({ success: true, accepted: true, operationId: 'op-2', phase: 'retiring' });

    const response = await POST(postRequest('abe', { action: 'disable' }), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).toBe(200);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, contents] = writeFile.mock.calls[0];
    expect(JSON.parse(contents as string)).toEqual({ abe: { enabled: false, org: 'acme' } });
  });
});

describe('POST /api/agents/[name]/lifecycle — restart mode nesting (confirmed bug fix)', () => {
  it('sends restart mode nested under `data`, never as a bare top-level field', async () => {
    send.mockResolvedValue({ success: true, accepted: true, operationId: 'op-3', phase: 'starting' });

    const response = await POST(postRequest('abe', { action: 'restart_fresh' }), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).toBe(200);
    const call = send.mock.calls[0][0];
    expect(call).toEqual({ type: 'restart-agent', agent: 'abe', data: { mode: 'fresh' } });
    // The pre-2.9 bug shape — confirm it is NOT what gets sent.
    expect(call).not.toHaveProperty('mode');
  });

  it('sends no data field for a plain restart (no mode requested)', async () => {
    send.mockResolvedValue({ success: true, accepted: true, operationId: 'op-4', phase: 'starting' });

    await POST(postRequest('abe', { action: 'restart' }), {
      params: Promise.resolve({ name: 'abe' }),
    });

    const call = send.mock.calls[0][0];
    expect(call).toEqual({ type: 'restart-agent', agent: 'abe' });
  });
});

describe('DELETE /api/agents/[name]/lifecycle', () => {
  it('rejects when the daemon is unavailable and deleteFiles=true — nothing removed', async () => {
    send.mockResolvedValue({
      success: false,
      error: 'Daemon is not running. Start it with: cortextos start',
    });

    const response = await DELETE(deleteRequest('abe', '?deleteFiles=true'), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).toBe(503);
    expect(writeFile).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('rejects when teardown is blocked — nothing removed', async () => {
    readFile.mockResolvedValue(JSON.stringify({ abe: { enabled: true, org: 'acme' } }));
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'stop-agent') {
        return { success: true, accepted: true, operationId: 'op-5', phase: 'retiring' };
      }
      if (req.type === 'lifecycle-operation-status') {
        return { success: true, phase: 'blocked', blockedReason: 'descendant process would not die' };
      }
      throw new Error(`unexpected request type ${req.type}`);
    });

    const response = await DELETE(deleteRequest('abe', '?deleteFiles=true'), {
      params: Promise.resolve({ name: 'abe' }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.blockedReason).toBe('descendant process would not die');
    expect(writeFile).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('rejects when the stop request itself is durably rejected — nothing removed', async () => {
    readFile.mockResolvedValue(JSON.stringify({ abe: { enabled: true, org: 'acme' } }));
    send.mockResolvedValue({ success: true, accepted: false, blockedReason: 'already blocked' });

    const response = await DELETE(deleteRequest('abe'), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).toBe(409);
    expect(writeFile).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('proceeds to remove config + files once teardown is verified retired (phase absent)', async () => {
    readFile.mockResolvedValue(JSON.stringify({ abe: { enabled: true, org: 'acme' } }));
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'stop-agent') {
        return { success: true, accepted: true, operationId: 'op-6', phase: 'retiring' };
      }
      if (req.type === 'lifecycle-operation-status') {
        return { success: true, phase: 'absent', blockedReason: null };
      }
      throw new Error(`unexpected request type ${req.type}`);
    });

    const response = await DELETE(deleteRequest('abe', '?deleteFiles=true'), {
      params: Promise.resolve({ name: 'abe' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith('/framework/orgs/acme/agents/abe', { recursive: true, force: true });
  });

  it('proceeds using the coarse status-poll fallback for a legacy/unsupervised agent (no operationId)', async () => {
    readFile.mockResolvedValue(JSON.stringify({ abe: { enabled: true, org: 'acme' } }));
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'stop-agent') {
        return { success: true, accepted: true }; // no operationId — legacy path
      }
      if (req.type === 'status') {
        return { success: true, data: [{ name: 'abe', status: 'stopped' }] };
      }
      throw new Error(`unexpected request type ${req.type}`);
    });

    const response = await DELETE(deleteRequest('abe'), {
      params: Promise.resolve({ name: 'abe' }),
    });

    expect(response.status).toBe(200);
    expect(writeFile).toHaveBeenCalledTimes(1);
    // deleteFiles was not requested — no directory removal.
    expect(rm).not.toHaveBeenCalled();
  });

  it('does not settle (and is not verified retired) when the operation never leaves `retiring`', async () => {
    vi.useFakeTimers();
    try {
      readFile.mockResolvedValue(JSON.stringify({ abe: { enabled: true, org: 'acme' } }));
      send.mockImplementation(async (req: { type: string }) => {
        if (req.type === 'stop-agent') {
          return { success: true, accepted: true, operationId: 'op-7', phase: 'retiring' };
        }
        if (req.type === 'lifecycle-operation-status') {
          return { success: true, phase: 'retiring', blockedReason: null };
        }
        throw new Error(`unexpected request type ${req.type}`);
      });

      const promise = DELETE(deleteRequest('abe', '?deleteFiles=true'), {
        params: Promise.resolve({ name: 'abe' }),
      });
      await vi.runAllTimersAsync();
      const response = await promise;

      expect(response.status).toBe(409);
      expect(writeFile).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
