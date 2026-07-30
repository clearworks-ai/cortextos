import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTask } from '../../../../src/bus/task.js';
import { hashMappedFields, taskToIssuePayload } from '../../../../src/bus/multica/mapping.js';
import { runOutboundPush } from '../../../../src/bus/multica/push.js';
import { createSyncStateStore } from '../../../../src/bus/multica/sync-state.js';
import type { MulticaClient, MulticaConfig, MulticaIssue, MulticaPushPayload } from '../../../../src/bus/multica/types.js';
import type { BusPaths, Task } from '../../../../src/types/index.js';

const config: MulticaConfig = {
  baseUrl: 'https://multica.example.com',
  readApiToken: 'read-token',
  workspaceId: 'workspace-123',
  memberIdJosh: 'member-josh',
};

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
    heartbeatDir: join(root, 'heartbeats'),
  };
}

function makeTimestamp(index: number): string {
  return new Date(Date.UTC(2026, 6, 29, 7, 0, index)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readTask(paths: BusPaths, taskId: string): Task {
  return JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task;
}

function writeTask(paths: BusPaths, task: Task): void {
  writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
}

function createOrderedTask(
  paths: BusPaths,
  index: number,
  title: string,
  overrides: Partial<Task> = {},
): Task {
  const taskId = createTask(paths, 'paul', 'clearworksai', title, {
    assignee: 'human',
    description: `${title} description`,
  });
  const task = readTask(paths, taskId);
  const timestamp = makeTimestamp(index);
  const nextTask: Task = {
    ...task,
    ...overrides,
    created_at: timestamp,
    updated_at: timestamp,
  };
  writeTask(paths, nextTask);
  return nextTask;
}

function makeIssueResponse(payload: MulticaPushPayload, issueId: string): MulticaIssue {
  return {
    id: issueId,
    identifier: `CLE-${issueId}`,
    workspace_id: payload.issue.workspace_id,
    project_id: payload.issue.project_id,
    title: payload.issue.title,
    description: payload.issue.description,
    status: payload.issue.status,
    priority: payload.issue.priority,
    assignee_type: payload.issue.assignee_type,
    assignee_id: payload.issue.assignee_id,
    context_refs: [],
    due_date: payload.issue.due_date,
    created_at: '2026-07-29T07:00:00Z',
    updated_at: '2026-07-29T07:00:00Z',
  };
}

function createRecordingClient() {
  const createdTaskIds: string[] = [];
  const updatedCalls: Array<{ issueId: string; busTaskId: string }> = [];
  const client: MulticaClient = {
    async createIssue(payload) {
      createdTaskIds.push(payload.bus_task_id);
      return makeIssueResponse(payload, `created-${payload.bus_task_id}`);
    },
    async updateIssue(issueId, payload) {
      updatedCalls.push({ issueId, busTaskId: payload.bus_task_id });
      return makeIssueResponse(payload, issueId);
    },
    async listIssues() {
      return [];
    },
    async getTaskRuns() {
      return [];
    },
  };

  return { client, createdTaskIds, updatedCalls };
}

describe('multica outbound push', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'multica-push-test-'));
    paths = buildPaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('caps outbound pushes at the provided limit without counting skipped tasks', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    const skippedTask = createOrderedTask(paths, 0, 'Already synced task');
    const skippedHash = hashMappedFields(taskToIssuePayload(skippedTask, config));
    store.upsertLink(skippedTask.id, {
      multica_issue_id: 'issue-skip',
      last_pushed_hash: skippedHash,
      last_pushed_status: skippedTask.status,
      idempotency_key: 'skip-key',
    });

    for (let index = 1; index <= 10; index += 1) {
      createOrderedTask(paths, index, `Create task ${index}`);
    }

    for (let index = 11; index <= 22; index += 1) {
      const task = createOrderedTask(paths, index, `Update task ${index}`);
      store.upsertLink(task.id, {
        multica_issue_id: `issue-${index}`,
        last_pushed_hash: `stale-hash-${index}`,
        last_pushed_status: task.status,
        idempotency_key: `old-key-${index}`,
      });
    }

    const result = await runOutboundPush(paths, client, store, config, { limit: 20 });

    expect(result.pushed_creates).toBe(10);
    expect(result.pushed_updates).toBe(10);
    expect(result.pushed_creates + result.pushed_updates).toBe(20);
    expect(result.skipped).toBe(1);
    expect(createdTaskIds).toHaveLength(10);
    expect(updatedCalls).toHaveLength(10);
    expect(result.plan.filter((entry) => entry.outcome === 'pushed')).toHaveLength(20);
    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: skippedTask.id,
      action: 'skip',
      reason: 'hash_unchanged',
      outcome: 'skipped',
    }));
  });

  it('pushes every pushable task when no limit is provided', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    createOrderedTask(paths, 0, 'Create task 1');
    createOrderedTask(paths, 1, 'Create task 2');
    const updateTask = createOrderedTask(paths, 2, 'Update task 1');
    store.upsertLink(updateTask.id, {
      multica_issue_id: 'issue-1',
      last_pushed_hash: 'stale-hash',
      last_pushed_status: updateTask.status,
      idempotency_key: 'old-key-1',
    });

    const result = await runOutboundPush(paths, client, store, config);

    expect(result.pushed_creates).toBe(2);
    expect(result.pushed_updates).toBe(1);
    expect(result.pushed_creates + result.pushed_updates).toBe(3);
    expect(result.skipped).toBe(0);
    expect(createdTaskIds).toHaveLength(2);
    expect(updatedCalls).toHaveLength(1);
  });

  it('pushes nothing when the limit is zero', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    createOrderedTask(paths, 0, 'Create task 1');
    createOrderedTask(paths, 1, 'Create task 2');

    const result = await runOutboundPush(paths, client, store, config, { limit: 0 });

    expect(result.pushed_creates).toBe(0);
    expect(result.pushed_updates).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.plan).toEqual([]);
    expect(createdTaskIds).toHaveLength(0);
    expect(updatedCalls).toHaveLength(0);
  });

  it('self-heals stale null-id links by creating a real issue', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const task = createOrderedTask(paths, 0, 'Webhook-era stale task');
    const currentHash = hashMappedFields(taskToIssuePayload(task, config));
    store.upsertLink(task.id, {
      multica_issue_id: null,
      last_pushed_hash: currentHash,
      last_pushed_status: task.status,
      idempotency_key: 'stale-key',
    });

    const result = await runOutboundPush(paths, client, store, config);
    const link = store.linkFor(task.id);

    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: task.id,
      action: 'create',
      reason: 'new_task',
      outcome: 'pushed',
    }));
    expect(createdTaskIds).toEqual([task.id]);
    expect(updatedCalls).toEqual([]);
    expect(link?.multica_issue_id).toBe(`created-${task.id}`);
  });

  it('persists the created issue id into the sync link', async () => {
    const { client } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const task = createOrderedTask(paths, 0, 'Fresh create task');

    const result = await runOutboundPush(paths, client, store, config);
    const link = store.linkFor(task.id);

    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: task.id,
      action: 'create',
      outcome: 'pushed',
    }));
    expect(link?.multica_issue_id).toBe(`created-${task.id}`);
    expect(link?.last_pushed_hash).toBe(hashMappedFields(taskToIssuePayload(task, config)));
    expect(link?.last_pushed_status).toBe(task.status);
    expect(link?.idempotency_key).toBeTruthy();
  });

  it('updates using the stored issue id and re-persists it', async () => {
    const { client, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const task = createOrderedTask(paths, 0, 'Stored id update task');
    store.upsertLink(task.id, {
      multica_issue_id: 'issue-77',
      last_pushed_hash: 'stale-hash',
      last_pushed_status: task.status,
      idempotency_key: 'old-key',
    });

    const result = await runOutboundPush(paths, client, store, config);
    const link = store.linkFor(task.id);

    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: task.id,
      action: 'update',
      outcome: 'pushed',
    }));
    expect(updatedCalls).toEqual([{ issueId: 'issue-77', busTaskId: task.id }]);
    expect(link?.multica_issue_id).toBe('issue-77');
    expect(link?.last_pushed_hash).toBe(hashMappedFields(taskToIssuePayload(task, config, 'bus', 'update')));
  });

  it('retains genuine hash-based skips only when a real issue id exists', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const task = createOrderedTask(paths, 0, 'Already current task');
    const currentHash = hashMappedFields(taskToIssuePayload(task, config, 'bus', 'update'));
    store.upsertLink(task.id, {
      multica_issue_id: 'issue-88',
      last_pushed_hash: currentHash,
      last_pushed_status: task.status,
      idempotency_key: 'same-key',
    });

    const result = await runOutboundPush(paths, client, store, config);

    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: task.id,
      action: 'skip',
      reason: 'hash_unchanged',
      outcome: 'skipped',
    }));
    expect(createdTaskIds).toEqual([]);
    expect(updatedCalls).toEqual([]);
  });
});
