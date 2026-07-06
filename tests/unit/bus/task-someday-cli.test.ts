import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { createTask, listTasks } from '../../../src/bus/task';
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
  };
}

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: (agentName: string) => makePaths(agentName),
  getIpcPath: (_instanceId?: string) => join(tempCtxRoot || homedir(), 'daemon.sock'),
}));

import { busCommand } from '../../../src/cli/bus';

describe('bus someday task CLI', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-someday-cli-'));
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

  it('create-task --someday creates backlog work that default and real-build views hide unless requested', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Backlog row', '--project', 'roadmap', '--someday']);

    const tasks = listTasks(makePaths('paul'), { status: 'someday' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Backlog row');

    logSpy.mockClear();
    await busCommand.parseAsync(['node', 'bus', 'list-tasks']);
    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Backlog row'))).toBe(false);

    logSpy.mockClear();
    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--real-build']);
    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Backlog row'))).toBe(false);

    logSpy.mockClear();
    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--someday']);
    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Backlog row'))).toBe(true);

    logSpy.mockClear();
    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--real-build', '--someday']);
    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Backlog row'))).toBe(true);
  });

  it('list-tasks --by-project excludes someday rows from grouped counts by default', async () => {
    const paths = makePaths('paul');
    createTask(paths, 'paul', 'acme', 'Active row', { project: 'roadmap' });
    createTask(paths, 'paul', 'acme', 'Backlog row', {
      project: 'roadmap',
      someday: true,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--by-project']);

    expect(
      logSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('▸ roadmap (1)'),
      ),
    ).toBe(true);
    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Active row'))).toBe(true);
    expect(logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Backlog row'))).toBe(false);
  });
});
