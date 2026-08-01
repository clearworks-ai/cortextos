import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BusPaths } from '../../../../src/types/index.js';
import {
  createTask,
  listTasks,
  cancelTask,
  claimTask,
  completeTask,
  updateTask,
  findTaskFile,
} from '../../../../src/bus/task.js';
import { createSyncStateStore } from '../../../../src/bus/multica/sync-state.js';
import { runInboundPoll } from '../../../../src/bus/multica/poll.js';
import type { MulticaClient, MulticaIssue } from '../../../../src/bus/multica/types.js';

function buildPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'paul'),
    inflight: join(root, 'inflight', 'paul'),
    processed: join(root, 'processed', 'paul'),
    logDir: join(root, 'logs', 'paul'),
    stateDir: join(root, 'state', 'paul'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'orgs', 'clearworksai', 'deliverables'),
  };
}

const config = {
  memberIdJosh: 'member-josh',
  apiKey: 'test-key',
  baseUrl: 'https://api.multica.com',
};

function makeIssue(overrides: Partial<MulticaIssue> & { id: string }): MulticaIssue {
  return {
    workspace_id: 'workspace-123',
    project_id: null,
    title: `Issue ${overrides.id}`,
    description: 'created directly in Multica',
    status: 'todo',
    priority: 'medium',
    assignee_type: null,
    assignee_id: null,
    context_refs: [],
    due_date: null,
    created_at: '2026-08-01T07:00:00Z',
    updated_at: '2026-08-01T07:00:00Z',
    ...overrides,
  };
}

function makeClient(issues: MulticaIssue[]): MulticaClient {
  return {
    async createIssue() { throw new Error('not used'); },
    async updateIssue() { throw new Error('not used'); },
    async listIssues() { return issues; },
    async getTaskRuns() { return []; },
  };
}

const identity = { agentName: 'paul', org: 'clearworksai' };

describe('runInboundPoll - reverse import', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'multica-poll-test-'));
    paths = buildPaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('imports an unlinked Multica issue exactly once', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issue = makeIssue({ id: 'issue-orphan' });
    const client = makeClient([issue]);

    // First poll
    const result1 = await runInboundPoll(paths, config, client, store, { importIdentity: identity });
    expect(result1.imported).toBe(1);
    expect(result1.errors).toBe(0);

    const tasks1 = listTasks(paths);
    expect(tasks1).toHaveLength(1);
    expect(tasks1[0].title).toBe(issue.title);
    expect(tasks1[0].status).toBe('pending');
    expect(tasks1[0].description).toContain('[multica-import:issue-orphan]');

    const link1 = store.load().links[tasks1[0].id];
    expect(link1?.multica_issue_id).toBe('issue-orphan');
    expect(link1?.last_seen_multica_status).toBe('todo');

    expect(result1.actions).toContainEqual(
      expect.objectContaining({ kind: 'import', multica_issue_id: 'issue-orphan' }),
    );

    // Second poll
    const result2 = await runInboundPoll(paths, config, client, store, { importIdentity: identity });
    expect(result2.imported).toBe(0);
    expect(result2.wrote_back).toBe(0);

    const tasks2 = listTasks(paths);
    expect(tasks2).toHaveLength(1);

    const links2 = Object.values(store.load().links);
    expect(links2).toHaveLength(1);
  });

  it('dry run imports nothing but reports the plan', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issue = makeIssue({ id: 'issue-orphan' });
    const client = makeClient([issue]);

    const result = await runInboundPoll(paths, config, client, store, {
      dryRun: true,
      importIdentity: identity,
    });

    expect(result.imported).toBe(0);
    expect(listTasks(paths)).toHaveLength(0);
    expect(Object.values(store.load().links)).toHaveLength(0);

    expect(result.actions).toContainEqual({
      kind: 'import',
      bus_task_id: '',
      multica_issue_id: 'issue-orphan',
      to: 'pending',
    });
  });

  it('does not re-import issues that already have a link', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    // Create a bus task and link it
    const linkedTaskId = createTask(paths, 'paul', 'clearworksai', 'Linked task', {
      description: 'existing task',
    });
    store.upsertLink(linkedTaskId, {
      multica_issue_id: 'issue-linked',
      last_seen_multica_status: 'todo',
      last_seen_multica_assignee_id: null,
    });

    const client = makeClient([
      makeIssue({ id: 'issue-linked' }),
      makeIssue({ id: 'issue-new' }),
    ]);

    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    expect(result.imported).toBe(1);

    const tasks = listTasks(paths);
    const newTask = tasks.find((t) => t.id !== linkedTaskId);
    expect(newTask).toBeDefined();
    expect(newTask?.description).toContain('[multica-import:issue-new]');
  });

  it('skips terminal Multica issues', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const client = makeClient([
      makeIssue({ id: 'issue-done', status: 'done' }),
      makeIssue({ id: 'issue-cancelled', status: 'cancelled' }),
    ]);

    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    expect(result.imported).toBe(0);
    expect(listTasks(paths)).toHaveLength(0);
    expect(Object.values(store.load().links)).toHaveLength(0);
  });

  it('maps Josh-assigned in_progress issue to a claimed human task', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issue = makeIssue({
      id: 'issue-josh',
      status: 'in_progress',
      assignee_type: 'member',
      assignee_id: 'member-josh',
      priority: 'urgent',
    });
    const client = makeClient([issue]);

    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    expect(result.imported).toBe(1);

    const tasks = listTasks(paths);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_to).toBe('human');
    expect(tasks[0].status).toBe('in_progress');
    expect(tasks[0].priority).toBe('urgent');

    const link = store.load().links[tasks[0].id];
    expect(link?.last_pushed_status).toBe('in_progress');

    // Second poll
    const result2 = await runInboundPoll(paths, config, client, store, { importIdentity: identity });
    expect(result2.imported).toBe(0);
    expect(result2.wrote_back).toBe(0);
  });

  it('skips reverse import without identity', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issue = makeIssue({ id: 'issue-orphan' });
    const client = makeClient([issue]);

    const result = await runInboundPoll(paths, config, client, store, {});

    expect(result.imported).toBe(0);
    expect(listTasks(paths)).toHaveLength(0);
    expect(result.errors).toBe(0);
  });
});