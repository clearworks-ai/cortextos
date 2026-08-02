import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { createApproval, listPendingApprovals } from '../../../../src/bus/approval.js';
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

describe('runInboundPoll - approval resolution', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'multica-approval-test-'));
    paths = buildPaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('linked close resolves the approval', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issueId = 'issue-linked';

    // Create an approval which also creates a companion task
    const approvalId = await createApproval(
      paths,
      'paul',
      'clearworksai',
      'Test approval',
      'other',
      'test context',
    );

    // Get the task that was created by createApproval
    const tasksBefore = listTasks(paths);
    expect(tasksBefore).toHaveLength(1);
    const linkedTaskId = tasksBefore[0].id;

    // Verify the approval is linked to the correct task
    const pendingApprovalsBefore = listPendingApprovals(paths);
    const createdApproval = pendingApprovalsBefore.find((a) => a.id === approvalId);
    expect(createdApproval).toBeDefined();
    expect(createdApproval?.linked_task_id).toBe(linkedTaskId);

    // Create the link in the store
    const link = store.load();
    link.links[linkedTaskId] = {
      multica_issue_id: issueId,
      last_seen_multica_status: 'in_progress',
      last_seen_multica_assignee_id: null,
    };
    store.save(link);

    // Create a Multica issue that transitions to 'done' (mapped to 'completed')
    const issue = makeIssue({ 
      id: issueId, 
      status: 'done',
      title: 'Issue transitioning to done',
    });
    const client = makeClient([issue]);

    // Run poll
    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    // Approval should be resolved
    const pendingApprovals = listPendingApprovals(paths);
    expect(pendingApprovals).toHaveLength(0);

    // Should have recorded the approval-resolution action
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        bus_task_id: linkedTaskId,
        multica_issue_id: issueId,
        kind: 'approval-resolution',
        approval_id: approvalId,
      }),
    );

    // Verify the resolved approval has the correct status and note
    const resolvedPath = join(paths.approvalDir, 'resolved', `${approvalId}.json`);
    const resolvedApproval = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
    expect(resolvedApproval.status).toBe('approved');
    expect(resolvedApproval.resolved_by).toBe('resolved via Multica inbound sync (completed)');
  });

  it('null / unlinked untouched', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    // Create a task with no approval link
    const unlinkedTaskId = createTask(paths, 'paul', 'clearworksai', 'Unlinked task', {
      description: 'task without approval',
    });
    const issueId = 'issue-unlinked';

    // Create the link in the store
    const link = store.load();
    link.links[unlinkedTaskId] = {
      multica_issue_id: issueId,
      last_seen_multica_status: 'in_progress',
      last_seen_multica_assignee_id: null,
    };
    store.save(link);

    // Create an approval with null linked_task_id by manually creating it
    // (createApproval always creates a linked task, so we do this manually for the test)
    const approvalId = `approval_${Math.floor(Date.now() / 1000)}_manual`;
    const approvalDir = join(paths.approvalDir, 'pending');
    mkdirSync(approvalDir, { recursive: true });
    const approvalPath = join(approvalDir, `${approvalId}.json`);
    const approvalData = {
      id: approvalId,
      title: 'Unlinked approval',
      requesting_agent: 'paul',
      org: 'clearworksai',
      category: 'other',
      linked_task_id: null,
      context: 'unlinked test context',
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    writeFileSync(approvalPath, JSON.stringify(approvalData, null, 2));

    // Create a Multica issue that transitions to 'done'
    const issue = makeIssue({ 
      id: issueId, 
      status: 'done',
      title: 'Issue transitioning to done',
    });
    const client = makeClient([issue]);

    // Run poll
    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    // Unlinked approval should still be pending
    const pendingApprovals = listPendingApprovals(paths);
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0].linked_task_id).toBeNull();

    // Should NOT have recorded an approval-resolution action
    expect(result.actions).not.toContainEqual(
      expect.objectContaining({ kind: 'approval-resolution' }),
    );
  });

  it('simultaneous-close convergence', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issueId = 'issue-simultaneous';

    // Create an approval which also creates a companion task
    const approvalId = await createApproval(
      paths,
      'paul',
      'clearworksai',
      'Simultaneous approval',
      'other',
      'simultaneous test context',
    );

    // Get the task that was created by createApproval
    const tasksBefore = listTasks(paths);
    expect(tasksBefore).toHaveLength(1);
    const linkedTaskId = tasksBefore[0].id;

    // Create the link in the store
    const link = store.load();
    link.links[linkedTaskId] = {
      multica_issue_id: issueId,
      last_seen_multica_status: 'in_progress',
      last_seen_multica_assignee_id: null,
    };
    store.save(link);

    // First, approve via card (updateApproval)
    const { updateApproval: cardUpdateApproval } = await import('../../../../src/bus/approval.js');
    cardUpdateApproval(paths, approvalId, 'approved', 'approved via card');

    // Then close the issue via the fixture client
    const issue = makeIssue({ 
      id: issueId, 
      status: 'done',
      title: 'Issue transitioning to done',
    });
    const client = makeClient([issue]);

    // Run poll - should handle simultaneous close gracefully
    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    // Approval should be resolved (exactly once, no double-processing)
    const pendingApprovals = listPendingApprovals(paths);
    expect(pendingApprovals).toHaveLength(0);

    // No errors should have occurred
    expect(result.errors).toBe(0);
  });

  it('cancelled task resolves approval as rejected', async () => {
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const issueId = 'issue-cancelled';

    // Create an approval which also creates a companion task
    const approvalId = await createApproval(
      paths,
      'paul',
      'clearworksai',
      'Cancelled approval',
      'other',
      'cancellation test context',
    );

    // Get the task that was created by createApproval
    const tasksBefore = listTasks(paths);
    expect(tasksBefore).toHaveLength(1);
    const linkedTaskId = tasksBefore[0].id;

    // Create the link in the store
    const link = store.load();
    link.links[linkedTaskId] = {
      multica_issue_id: issueId,
      last_seen_multica_status: 'in_progress',
      last_seen_multica_assignee_id: null,
    };
    store.save(link);

    // Create a Multica issue that transitions to 'cancelled' (mapped to 'cancelled')
    const issue = makeIssue({ 
      id: issueId, 
      status: 'cancelled',
      title: 'Issue transitioning to cancelled',
    });
    const client = makeClient([issue]);

    // Run poll
    const result = await runInboundPoll(paths, config, client, store, { importIdentity: identity });

    // Approval should be resolved
    const pendingApprovals = listPendingApprovals(paths);
    expect(pendingApprovals).toHaveLength(0);

    // Task should be cancelled
    const task = findTaskFile(paths, linkedTaskId);
    expect(task?.status).toBe('cancelled');

    // Should have recorded the approval-resolution action
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        bus_task_id: linkedTaskId,
        multica_issue_id: issueId,
        kind: 'approval-resolution',
        approval_id: approvalId,
      }),
    );

    // Verify the resolved approval has the correct status and note
    const resolvedPath = join(paths.approvalDir, 'resolved', `${approvalId}.json`);
    const resolvedApproval = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
    expect(resolvedApproval.status).toBe('rejected');
    expect(resolvedApproval.resolved_by).toBe('resolved via Multica inbound sync (cancelled)');
  });
});