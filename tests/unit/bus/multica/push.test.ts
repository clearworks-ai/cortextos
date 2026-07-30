import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTask } from '../../../../src/bus/task.js';
import { hashMappedFields, taskToIssuePayload } from '../../../../src/bus/multica/mapping.js';
import { runOutboundPush } from '../../../../src/bus/multica/push.js';
import { createSyncStateStore } from '../../../../src/bus/multica/sync-state.js';
import type { MulticaClient, MulticaConfig } from '../../../../src/bus/multica/types.js';
import type { BusPaths, Task } from '../../../../src/types/index.js';

const config: MulticaConfig = {
  baseUrl: 'https://multica.example.com',
  webhookToken: 'webhook-token',
  webhookSecret: 'webhook-secret',
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

function createRecordingClient() {
  const pushedTaskIds: string[] = [];
  const client: MulticaClient = {
    async pushIssue(payload) {
      pushedTaskIds.push(payload.bus_task_id);
      return { status: 200 };
    },
    async listIssues() {
      return [];
    },
    async getTaskRuns() {
      return [];
    },
  };

  return { client, pushedTaskIds };
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
    const { client, pushedTaskIds } = createRecordingClient();
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
    expect(pushedTaskIds).toHaveLength(20);
    expect(result.plan.filter((entry) => entry.outcome === 'pushed')).toHaveLength(20);
    expect(result.plan).toContainEqual(expect.objectContaining({
      bus_task_id: skippedTask.id,
      action: 'skip',
      reason: 'hash_unchanged',
      outcome: 'skipped',
    }));
  });

  it('pushes every pushable task when no limit is provided', async () => {
    const { client, pushedTaskIds } = createRecordingClient();
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
    expect(pushedTaskIds).toHaveLength(3);
  });

  it('pushes nothing when the limit is zero', async () => {
    const { client, pushedTaskIds } = createRecordingClient();
    const store = createSyncStateStore(join(testDir, 'sync-state.json'));

    createOrderedTask(paths, 0, 'Create task 1');
    createOrderedTask(paths, 1, 'Create task 2');

    const result = await runOutboundPush(paths, client, store, config, { limit: 0 });

    expect(result.pushed_creates).toBe(0);
    expect(result.pushed_updates).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.plan).toEqual([]);
    expect(pushedTaskIds).toHaveLength(0);
  });
});
