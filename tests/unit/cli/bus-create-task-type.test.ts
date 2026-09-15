// tests/unit/cli/bus-create-task-type.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { BusPaths, Task } from '../../../src/types/index';
import { createTask } from '../../../src/bus/task';

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
  };
}

function readTask(taskId: string): Task {
  return JSON.parse(readFileSync(join(tempCtxRoot, 'tasks', `${taskId}.json`), 'utf-8')) as Task;
}

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: (agentName: string) => makePaths(agentName),
  getIpcPath: (_instanceId?: string) => join(tempCtxRoot || homedir(), 'daemon.sock'),
}));

import { busCommand } from '../../../src/cli/bus';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

describe('bus create-task --type (G-BUS-1)', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-create-task-type-'));
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'paul';
    process.env.CTX_INSTANCE_ID = 'default';
    delete process.env.CTX_ORG;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;

    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;

    if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstanceId;

    if (originalOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = originalOrg;

    rmSync(tempCtxRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates a task file with type "human" when --type human is passed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Decide pricing', '--type', 'human']);

    const taskId = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(taskId).toMatch(/^task_\d+_\d{8}$/);
    expect(readTask(taskId).type).toBe('human');
  });

  it('defaults to type "agent" when --type is omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Untyped']);

    const taskId = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(readTask(taskId).type).toBe('agent');
  });

  it('rejects an invalid --type value with exit 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'create-task', 'Bad type', '--type', 'robot']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith("ERROR: --type must be 'agent' or 'human' (got 'robot')");
  });
});

describe('bus claim-task --force-claim (G-BUS-2)', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-claim-force-'));
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'paul';
    process.env.CTX_INSTANCE_ID = 'default';
    delete process.env.CTX_ORG;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;

    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;

    if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstanceId;

    if (originalOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = originalOrg;

    rmSync(tempCtxRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('refuses a human-exempt task without --force-claim', async () => {
    const paths = makePaths('paul');
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'claim-task', taskId, '--agent', 'boris']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(
      `Task ${taskId} is human-exempt (type=human, assigned_to=human); pass --force-claim to promote it deliberately`,
    );
    expect(readTask(taskId).status).toBe('pending');
  });

  it('promotes a human-exempt task with --force-claim', async () => {
    const paths = makePaths('paul');
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'claim-task', taskId, '--agent', 'boris', '--force-claim']);

    expect(readTask(taskId).status).toBe('in_progress');
    expect(readTask(taskId).assigned_to).toBe('boris');
  });

  it('claims an ordinary agent task exactly as before (regression)', async () => {
    const paths = makePaths('paul');
    const taskId = createTask(paths, 'paul', 'acme', 'Ordinary task');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'claim-task', taskId, '--agent', 'boris']);

    expect(readTask(taskId).status).toBe('in_progress');
    expect(readTask(taskId).assigned_to).toBe('boris');
  });
});
