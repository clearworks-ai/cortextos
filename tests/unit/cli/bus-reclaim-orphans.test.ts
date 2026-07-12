import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask } from '../../../src/bus/task';
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
}));

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async send(request: { type: string }) {
      if (request.type === 'status') {
        return {
          success: true,
          data: [{ name: 'frank2', status: 'running' }],
        };
      }
      if (request.type === 'list-workers') {
        return {
          success: true,
          data: [{ name: 'transcript-scanner-1783880818', parent: 'frank2' }],
        };
      }
      return { success: true, data: [] };
    }
  },
}));

import { busCommand } from '../../../src/cli/bus';

describe('bus reclaim-orphans', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-reclaim-orphans-'));
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'codexer';
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'acme';
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

  it('reports phantom worker ownership and leaves [HUMAN] tasks untouched in dry-run mode', async () => {
    const paths = makePaths('codexer');
    const phantomId = createTask(paths, 'larry', 'acme', 'Investigate transcript gap', {
      assignee: 'transcript-scanner-1783880818',
    });
    const humanId = createTask(paths, 'larry', 'acme', '[HUMAN] Call client back', {
      assignee: 'human',
      project: 'human-tasks',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'reclaim-orphans']);

    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(report.dry_run).toBe(true);
    expect(report.reassigned).toEqual([
      expect.objectContaining({
        id: phantomId,
        from: 'transcript-scanner-1783880818',
        to: 'frank2',
        reason: 'ephemeral_worker',
        parentKnown: true,
      }),
    ]);
    expect(report.skipped_human).toContain(humanId);

    const phantomTask = JSON.parse(readFileSync(join(paths.taskDir, `${phantomId}.json`), 'utf-8'));
    const humanTask = JSON.parse(readFileSync(join(paths.taskDir, `${humanId}.json`), 'utf-8'));
    expect(phantomTask.assigned_to).toBe('transcript-scanner-1783880818');
    expect(humanTask.assigned_to).toBe('human');
  });
});
