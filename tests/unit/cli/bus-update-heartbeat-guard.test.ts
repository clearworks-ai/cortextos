import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types/index';

let tempCtxRoot = '';

function makePaths(agentName: string): BusPaths {
  return {
    ctxRoot: tempCtxRoot,
    inbox: join(tempCtxRoot, 'inbox', agentName),
    inflight: join(tempCtxRoot, 'inflight', agentName),
    processed: join(tempCtxRoot, 'processed', agentName),
    logDir: join(tempCtxRoot, 'logs', agentName),
    stateDir: join(tempCtxRoot, 'state', agentName),
    taskDir: join(tempCtxRoot, 'tasks'),
    approvalDir: join(tempCtxRoot, 'approvals'),
    analyticsDir: join(tempCtxRoot, 'analytics'),
    deliverablesDir: join(tempCtxRoot, 'deliverables'),
    heartbeatDir: join(tempCtxRoot, 'heartbeats'),
  };
}

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: (agentName: string) => makePaths(agentName),
}));

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async send() {
      return { success: true, data: [] };
    }
  },
}));

import { busCommand } from '../../../src/cli/bus';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

describe('bus update-heartbeat sandbox guard handling', () => {
  const envKeys = [
    'CTX_ROOT',
    'CTX_AGENT_NAME',
    'CTX_INSTANCE_ID',
    'CTX_ORG',
    'CTX_FRAMEWORK_ROOT',
    'CTX_PROJECT_ROOT',
    'CTX_AGENT_DIR',
    'CTX_TIMEZONE',
    'CTX_ORCHESTRATOR',
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-update-heartbeat-'));
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'sage';
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'acme';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tempCtxRoot, { recursive: true, force: true });
  });

  it('prints one clean line and exits 1 when CTX_AGENT_DIR is outside CTX_FRAMEWORK_ROOT', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'heartbeat-fw-'));
    const liveRoot = mkdtempSync(join(tmpdir(), 'heartbeat-live-'));
    const liveAgentDir = join(liveRoot, 'orgs', 'acme', 'agents', 'sage');
    mkdirSync(liveAgentDir, { recursive: true });
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    process.env.CTX_AGENT_DIR = liveAgentDir;

    const exitSpy = mockExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      busCommand.parseAsync(['node', 'bus', 'update-heartbeat', 'active']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/^update-heartbeat failed: .*not under CTX_FRAMEWORK_ROOT/);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\n    at ');

    rmSync(frameworkRoot, { recursive: true, force: true });
    rmSync(liveRoot, { recursive: true, force: true });
  });

  it('prints one clean line and exits 1 when CTX_PROJECT_ROOT diverges from CTX_FRAMEWORK_ROOT', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'heartbeat-fw-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'heartbeat-project-'));
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'sage');
    mkdirSync(agentDir, { recursive: true });
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    process.env.CTX_PROJECT_ROOT = projectRoot;
    process.env.CTX_AGENT_DIR = agentDir;

    const exitSpy = mockExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      busCommand.parseAsync(['node', 'bus', 'update-heartbeat', 'active']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/^update-heartbeat failed: .*must equal CTX_FRAMEWORK_ROOT/);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\n    at ');

    rmSync(frameworkRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('keeps the happy path unchanged for a subordinate agent dir', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'heartbeat-happy-'));
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'sage');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Sage\n', 'utf-8');
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    process.env.CTX_PROJECT_ROOT = frameworkRoot;
    process.env.CTX_AGENT_DIR = agentDir;

    const exitSpy = mockExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await busCommand.parseAsync(['node', 'bus', 'update-heartbeat', 'active', '--task', 't']);

    const heartbeatPath = join(tempCtxRoot, 'state', 'sage', 'heartbeat.json');
    expect(existsSync(heartbeatPath)).toBe(true);
    const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf-8')) as {
      current_task?: string;
      status?: string;
    };
    expect(heartbeat.current_task).toBe('t');
    expect(heartbeat.status).toBe('active');
    expect(logSpy).toHaveBeenCalledWith('Heartbeat updated: sage');
    expect(exitSpy).not.toHaveBeenCalled();

    rmSync(frameworkRoot, { recursive: true, force: true });
  });
});
