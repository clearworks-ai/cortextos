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
  const createdPayloads: MulticaPushPayload[] = [];
  const updatedCalls: Array<{ issueId: string; busTaskId: string }> = [];
  const remoteIssues: MulticaIssue[] = [];
  const client: MulticaClient = {
    async createIssue(payload) {
      createdTaskIds.push(payload.bus_task_id);
      createdPayloads.push(payload);
      const issueId = `created-${payload.bus_task_id}`;
      const issue = makeIssueResponse(payload, issueId);
      remoteIssues.push(issue);
      return issue;
    },
    async updateIssue(issueId, payload) {
      updatedCalls.push({ issueId, busTaskId: payload.bus_task_id });
      return makeIssueResponse(payload, issueId);
    },
    async listIssues() {
      return remoteIssues;
    },
    async getTaskRuns() {
      return [];
    },
  };

  return { client, createdTaskIds, createdPayloads, updatedCalls, remoteIssues };
}

function createFlakyStore(
  inner: SyncStateStore,
  shouldFail: (patch: import('../../../../src/bus/multica/types.js').SyncLink) => boolean,
): SyncStateStore {
  return {
    load: () => inner.load(),
    loadWithStatus: () => inner.loadWithStatus(),
    save: (state) => inner.save(state),
    linkFor: (taskId) => inner.linkFor(taskId),
    upsertLink(taskId, patch) {
      if (shouldFail(patch as import('../../../../src/bus/multica/types.js').SyncLink)) {
        throw new Error('simulated ledger write failure');
      }
      inner.upsertLink(taskId, patch);
    },
  };
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

  it('skips system-class tasks (crons, audit bookkeeping) without consuming limit budget', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    const cronTask = createOrderedTask(paths, 0, 'Cron: fleet-health-check');
    const auditTask = createOrderedTask(paths, 1, '[AUDIT] Close pipeline bypass: some-slug (build)');
    const realTask1 = createOrderedTask(paths, 2, 'Real work item 1');
    const realTask2 = createOrderedTask(paths, 3, 'Real work item 2');

    // limit=2 with 2 system + 2 real tasks (system tasks are oldest, so they
    // are visited first): both real tasks must still be pushed — proving the
    // system skips consumed zero limit budget.
    const result = await runOutboundPush(paths, client, store, config, { limit: 2 });

    expect(result.pushed_creates).toBe(2);
    expect(result.pushed_updates).toBe(0);
    expect(result.skipped).toBe(2);
    expect(createdTaskIds).toEqual([realTask1.id, realTask2.id]);
    expect(updatedCalls).toEqual([]);

    for (const systemTask of [cronTask, auditTask]) {
      expect(result.plan).toContainEqual(expect.objectContaining({
        bus_task_id: systemTask.id,
        action: 'skip',
        reason: 'not_pushable',
        outcome: 'skipped',
      }));
      expect(result.plan).not.toContainEqual(expect.objectContaining({
        bus_task_id: systemTask.id,
        action: 'create',
      }));
      expect(store.linkFor(systemTask.id)).toBeUndefined();
    }
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

  it('onlyTaskIds scopes the push to the named task and passes over the rest without counting skips', async () => {
    const { client, createdTaskIds } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    const target = createOrderedTask(paths, 0, 'Mirror me');
    createOrderedTask(paths, 1, 'Leave me alone 1');
    createOrderedTask(paths, 2, 'Leave me alone 2');

    const result = await runOutboundPush(paths, client, store, config, {
      onlyTaskIds: new Set([target.id]),
    });

    expect(result.pushed_creates).toBe(1);
    expect(result.pushed_updates).toBe(0);
    // The two non-targeted tasks are passed over silently, not counted as skips.
    expect(result.skipped).toBe(0);
    expect(createdTaskIds).toEqual([target.id]);
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]).toMatchObject({ bus_task_id: target.id, outcome: 'pushed' });
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

  it('does not create a duplicate issue when the ledger write fails after a successful create', async () => {
    const { client, createdTaskIds, updatedCalls, remoteIssues } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const flakyStore = createFlakyStore(store, (patch) => patch.multica_issue_id !== undefined && patch.multica_issue_id !== null);
    const task = createOrderedTask(paths, 0, 'Orphan test task');

    // Run 1: flaky store fails post-create, leaves pending marker
    const result1 = await runOutboundPush(paths, client, flakyStore, config);
    expect(result1.errors).toBe(1);
    expect(createdTaskIds).toHaveLength(1);
    expect(store.linkFor(task.id)?.multica_issue_id).toBeNull();
    const pendingMarker = store.linkFor(task.id)?.pending_create;
    expect(pendingMarker).toBeTruthy();
    expect(pendingMarker?.title).toBe(task.title);
    expect(remoteIssues).toHaveLength(1);
    const orphanId = remoteIssues[0].id;

    // Run 2: real store recovers orphan, no second create
    const result2 = await runOutboundPush(paths, client, store, config);
    expect(createdTaskIds).toHaveLength(1); // Still 1 — no second create call
    expect(updatedCalls).toContainEqual({ issueId: orphanId, busTaskId: task.id });
    expect(result2.plan).toContainEqual(expect.objectContaining({
      bus_task_id: task.id,
      action: 'update',
      reason: 'recovered_orphan',
      outcome: 'pushed',
    }));
    const finalLink = store.linkFor(task.id);
    expect(finalLink?.multica_issue_id).toBe(orphanId);
    expect(finalLink?.pending_create).toBeNull();
  });

  it('aborts the create when the write-ahead marker cannot be persisted', async () => {
    const { client, createdTaskIds } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const flakyStore = createFlakyStore(store, (patch) => patch.pending_create !== undefined);
    const task = createOrderedTask(paths, 0, 'Marker failure test');

    const result = await runOutboundPush(paths, client, flakyStore, config);
    expect(createdTaskIds).toEqual([]);
    expect(result.errors).toBe(1);
    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: task.id,
      action: 'create',
      reason: 'push_failed',
      outcome: 'error',
    }));
  });

  it('re-creates when a pending marker exists but no orphan is found remotely', async () => {
    const { client, createdTaskIds } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const task = createOrderedTask(paths, 0, 'No orphan test task');
    store.upsertLink(task.id, {
      pending_create: {
        idempotency_key: 'stale-key',
        title: task.title,
        field_hash: 'old-hash',
        attempted_at: '2026-08-01T00:00:00Z',
      },
    });

    const result = await runOutboundPush(paths, client, store, config);
    expect(createdTaskIds).toHaveLength(1);
    expect(result.errors).toBe(0);
    const link = store.linkFor(task.id);
    expect(link?.multica_issue_id).toBeTruthy();
    expect(link?.pending_create).toBeNull();
  });

  it('does not adopt an issue already linked to another task', async () => {
    const { client, createdTaskIds, remoteIssues } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const taskA = createOrderedTask(paths, 0, 'Shared title task A');
    const taskB = createOrderedTask(paths, 1, 'Shared title task B');
    const issueAId = 'issue-a';

    // Task A is linked to issue-a
    store.upsertLink(taskA.id, {
      multica_issue_id: issueAId,
      last_pushed_hash: 'hash-a',
      last_pushed_status: taskA.status,
      idempotency_key: 'key-a',
    });
    remoteIssues.push({
      id: issueAId,
      identifier: `CLE-${issueAId}`,
      workspace_id: config.workspaceId,
      project_id: null,
      title: 'Shared title task', // Same title as taskB
      description: 'existing issue',
      status: 'todo',
      priority: 'medium',
      assignee_type: null,
      assignee_id: null,
      context_refs: [],
      due_date: null,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    });

    // Task B has pending marker with same title, should NOT adopt issue-a
    store.upsertLink(taskB.id, {
      pending_create: {
        idempotency_key: 'key-b',
        title: 'Shared title task',
        field_hash: 'hash-b',
        attempted_at: '2026-08-01T00:00:00Z',
      },
    });

    const result = await runOutboundPush(paths, client, store, config);
    expect(result.errors).toBe(0);
    expect(createdTaskIds).toHaveLength(1); // Task B creates fresh issue
    expect(createdTaskIds[0]).toBe(taskB.id); // Only taskB's create
    const linkB = store.linkFor(taskB.id);
    expect(linkB?.multica_issue_id).not.toBe(issueAId);
    expect(linkB?.pending_create).toBeNull();
  });

  it('clears a stray pending marker on an already-linked task', async () => {
    const { client, createdTaskIds, updatedCalls } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));
    const task = createOrderedTask(paths, 0, 'Stray marker test');
    const currentHash = hashMappedFields(taskToIssuePayload(task, config, 'bus', 'update'));

    // Link with real issue and stray pending marker
    store.upsertLink(task.id, {
      multica_issue_id: 'issue-99',
      last_pushed_hash: currentHash,
      last_pushed_status: task.status,
      idempotency_key: 'key-99',
      pending_create: {
        idempotency_key: 'stale-key',
        title: task.title,
        field_hash: 'old-hash',
        attempted_at: '2026-08-01T00:00:00Z',
      },
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
    const finalLink = store.linkFor(task.id);
    expect(finalLink?.pending_create).toBeNull();
    expect(finalLink?.multica_issue_id).toBe('issue-99');
  });

  it('defaults provenance to meeting-pipeline for project=meeting-pipeline tasks and bus otherwise', async () => {
    const { client, createdPayloads } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    const pipelineTask = createOrderedTask(paths, 0, 'Pipeline-sourced task', {
      project: 'meeting-pipeline',
    });
    const plainTask = createOrderedTask(paths, 1, 'Plain bus task');

    // No provenanceFor option passed — the defaultProvenanceFor fallback must route.
    const result = await runOutboundPush(paths, client, store, config);

    expect(result.pushed_creates).toBe(2);
    expect(result.errors).toBe(0);

    const pipelinePayload = createdPayloads.find((p) => p.bus_task_id === pipelineTask.id);
    const plainPayload = createdPayloads.find((p) => p.bus_task_id === plainTask.id);
    expect(pipelinePayload?.provenance).toBe('meeting-pipeline');
    expect(plainPayload?.provenance).toBe('bus');
  });
});
