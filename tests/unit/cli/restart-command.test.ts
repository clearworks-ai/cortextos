/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand.
 *
 * Keeps the original command-shape assertions and adds action-path coverage for
 * issue #fix-restart-silent-start: restart must use the atomic restart IPC,
 * preserve BUG-036's stop marker, and report a truthful error if the agent
 * never confirms as running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus, IPCRequest, IPCResponse } from '../../../src/types/index';

const {
  mockIpcSend,
  mockIpcIsDaemonRunning,
  mockWriteStopMarker,
  mockResolveInstanceId,
} = vi.hoisted(() => ({
  mockIpcSend: vi.fn(),
  mockIpcIsDaemonRunning: vi.fn(),
  mockWriteStopMarker: vi.fn(),
  mockResolveInstanceId: vi.fn(),
}));

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockIpcSend;
    isDaemonRunning = mockIpcIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

vi.mock('../../../src/cli/stop.js', () => ({
  writeStopMarker: mockWriteStopMarker,
}));

vi.mock('../../../src/cli/resolve-instance-id.js', () => ({
  resolveInstanceId: mockResolveInstanceId,
}));

import { RESTART_VERIFY_TIMEOUT_MS, restartCommand } from '../../../src/cli/restart';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

function runningStatus(agent: string, pid: number): AgentStatus {
  return {
    name: agent,
    status: 'running',
    pid,
    uptime: 12,
    model: 'gpt-5.6-sol',
  };
}

function statusResponse(statuses: AgentStatus[]): IPCResponse {
  return { success: true, data: statuses };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockIpcSend.mockReset();
  mockIpcIsDaemonRunning.mockReset();
  mockWriteStopMarker.mockReset();
  mockResolveInstanceId.mockReset();

  mockIpcIsDaemonRunning.mockResolvedValue(true);
  mockResolveInstanceId.mockImplementation((instance?: string) => instance || 'test-instance');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('issue #328: cortextos restart <agent>', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('requires the <agent> positional argument', () => {
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance without hardcoding a default', () => {
    const opts = restartCommand.opts();
    expect(opts.instance).toBeUndefined();
  });

  it('describes itself as a stop+start (not a daemon restart)', () => {
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('stop');
    expect(desc).toContain('start');
    expect(desc).toContain('daemon');
  });
});

describe('issue fix-restart-silent-start: restart liveness verification', () => {
  it('exits non-zero with a recovery hint when restart never confirms as running', async () => {
    const agent = 'frank2';
    let statusChecks = 0;
    const exitSpy = mockExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIpcSend.mockImplementation(async (request: IPCRequest): Promise<IPCResponse> => {
      if (request.type === 'status') {
        statusChecks += 1;
        return statusChecks === 1 ? statusResponse([runningStatus(agent, 111)]) : statusResponse([]);
      }
      if (request.type === 'restart-agent') {
        return { success: true, data: `Restarting ${agent}` };
      }
      return { success: false, error: `Unexpected IPC request: ${request.type}` };
    });

    const commandPromise = restartCommand.parseAsync(['node', 'restart', agent]);
    const commandResult = expect(commandPromise).rejects.toThrow('__PROCESS_EXIT_1__');
    await vi.advanceTimersByTimeAsync(RESTART_VERIFY_TIMEOUT_MS);

    await commandResult;
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(`Restarting agent: ${agent}`);

    const errorOutput = errorSpy.mock.calls.flat().join(' ');
    expect(errorOutput).toContain(`Start did not confirm within ${RESTART_VERIFY_TIMEOUT_MS / 1000}s`);
    expect(errorOutput).toContain(`Recover with: cortextos start ${agent}`);
  });

  it('reports success once the agent confirms as running within the verification window', async () => {
    const agent = 'frank2';
    let statusChecks = 0;
    const exitSpy = mockExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockIpcSend.mockImplementation(async (request: IPCRequest): Promise<IPCResponse> => {
      if (request.type === 'status') {
        statusChecks += 1;
        if (statusChecks === 1) return statusResponse([runningStatus(agent, 111)]);
        if (statusChecks === 2) return statusResponse([]);
        return statusResponse([runningStatus(agent, 222)]);
      }
      if (request.type === 'restart-agent') {
        return { success: true, data: `Restarting ${agent}` };
      }
      return { success: false, error: `Unexpected IPC request: ${request.type}` };
    });

    const commandPromise = restartCommand.parseAsync(['node', 'restart', agent]);
    await vi.runAllTimersAsync();

    await expect(commandPromise).resolves.toBe(restartCommand);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(`Restarting agent: ${agent}`);
    expect(logSpy).toHaveBeenCalledWith(`  ${agent} restarted`);

    const sentTypes = mockIpcSend.mock.calls.map(([request]) => (request as IPCRequest).type);
    expect(sentTypes).toContain('restart-agent');
    expect(sentTypes).not.toContain('stop-agent');
    expect(sentTypes).not.toContain('start-agent');
  });

  it('writes the BUG-036 stop marker before dispatching restart-agent', async () => {
    const agent = 'frank2';
    const events: string[] = [];
    let statusChecks = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockWriteStopMarker.mockImplementation(() => {
      events.push('marker');
    });

    mockIpcSend.mockImplementation(async (request: IPCRequest): Promise<IPCResponse> => {
      events.push(request.type);
      if (request.type === 'status') {
        statusChecks += 1;
        if (statusChecks === 1) return statusResponse([runningStatus(agent, 111)]);
        if (statusChecks === 2) return statusResponse([]);
        return statusResponse([runningStatus(agent, 222)]);
      }
      if (request.type === 'restart-agent') {
        return { success: true, data: `Restarting ${agent}` };
      }
      return { success: false, error: `Unexpected IPC request: ${request.type}` };
    });

    const commandPromise = restartCommand.parseAsync(['node', 'restart', agent]);
    await vi.runAllTimersAsync();
    await expect(commandPromise).resolves.toBe(restartCommand);

    expect(mockWriteStopMarker).toHaveBeenCalledWith(
      'test-instance',
      agent,
      'stopped via cortextos restart',
    );
    expect(events.indexOf('marker')).toBeGreaterThan(-1);
    expect(events.indexOf('restart-agent')).toBeGreaterThan(-1);
    expect(events.indexOf('marker')).toBeLessThan(events.indexOf('restart-agent'));
  });
});
