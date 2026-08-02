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
  workspaceId: 'workspace-123',
  readApiToken: 'test-token',
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

  it('re-links crash-window orphan instead of duplicating', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const identity = { agentName: 'test-agent', org: 'test-org' };
    const issueId = 'issue-crash-orphan';
    const issue = makeIssue({ 
      id: issueId, 
      workspace_id: 'workspace-123',
      status: 'todo' 
    });
    const client = makeClient([issue]);

    // Pre-seed a bus task with the [multica-import:<id>] marker but no link
    // This simulates crash window: task created, link write never landed
    const taskId = createTask(paths, 'test-agent', 'test-org', 'Orphan test task', {
      assignee: 'human',
      description: `[multica-import:${issueId}] This task was created but link write failed`,
    });

    // Run reverse import - should re-link, not duplicate-create
    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    // Should resolve the orphan, not import
    expect(result.imported).toBe(0);
    expect(result.resolved_ids).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      bus_task_id: taskId,
      multica_issue_id: issueId,
      kind: 'resolve_id',
    });

    // Link should now exist with correct issue ID and all required fields
    const link = store.load().links[taskId];
    expect(link).toBeTruthy();
    expect(link?.multica_issue_id).toBe(issueId);
    expect(link?.last_seen_multica_status).toBe('todo');
    expect(link?.last_seen_multica_assignee_id).toBeNull();
    // Should have outbound fields seeded from the orphaned task
    expect(link?.last_pushed_status).toBeTruthy();
    expect(link?.last_pushed_hash).toBeTruthy();
    expect(link?.idempotency_key).toBeTruthy();

    // Only one task should exist (no duplicate)
    const tasks = listTasks(paths);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(taskId);
  });
});