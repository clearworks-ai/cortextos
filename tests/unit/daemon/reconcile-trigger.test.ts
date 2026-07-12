import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentStatus, Task, WorkerStatus } from '../../../src/types/index.js';

const logEventMock = vi.fn();

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeTask(overrides: Partial<Task> & { id: string; title: string; assigned_to: string }): Task {
  const now = nowIso();
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? '',
    type: overrides.type ?? 'agent',
    needs_approval: overrides.needs_approval ?? false,
    status: overrides.status ?? 'pending',
    assigned_to: overrides.assigned_to,
    created_by: overrides.created_by ?? 'larry',
    org: overrides.org ?? 'acme',
    priority: overrides.priority ?? 'normal',
    project: overrides.project ?? '',
    kpi_key: overrides.kpi_key ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    completed_at: overrides.completed_at ?? null,
    due_date: overrides.due_date ?? null,
    archived: overrides.archived ?? false,
  };
}

function writeTask(homeDir: string, task: Task): void {
  const dir = join(homeDir, '.cortextos', 'default', 'orgs', task.org, 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task), 'utf-8');
}

function readTask(homeDir: string, org: string, taskId: string): Task {
  return JSON.parse(
    readFileSync(join(homeDir, '.cortextos', 'default', 'orgs', org, 'tasks', `${taskId}.json`), 'utf-8'),
  ) as Task;
}

function declareAgent(frameworkRoot: string, org: string, agentName: string): void {
  const agentDir = join(frameworkRoot, 'orgs', org, 'agents', agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'config.json'), '{}', 'utf-8');
}

function makeManager(statuses: AgentStatus[], workers: WorkerStatus[]) {
  return {
    getAllStatuses: () => statuses,
    listWorkers: () => workers,
    getCronScheduler: () => ({
      getNextFireTimes: () => [],
    }),
  };
}

async function loadReconcileTrigger(options: { reclaimThrows?: string } = {}) {
  vi.resetModules();
  logEventMock.mockReset();

  vi.doMock('../../../src/bus/event.js', () => ({
    logEvent: logEventMock,
  }));

  if (options.reclaimThrows) {
    vi.doMock('../../../src/bus/task.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/bus/task.js')>('../../../src/bus/task.js');
      return {
        ...actual,
        reclaimOrphanTasks: vi.fn(() => {
          throw new Error(options.reclaimThrows);
        }),
      };
    });
  } else {
    vi.doUnmock('../../../src/bus/task.js');
  }

  return import('../../../src/daemon/reconcile-trigger.js');
}

describe('ReconcileTrigger orphan reclaim apply-mode', () => {
  let homeDir: string;
  let frameworkRoot: string;
  const originalHome = process.env.HOME;
  const originalParent = process.env.CTX_PARENT_AGENT;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'reconcile-trigger-home-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'reconcile-trigger-fw-'));
    process.env.HOME = homeDir;
    process.env.CTX_PARENT_AGENT = 'frank2';
  });

  afterEach(() => {
    vi.doUnmock('../../../src/bus/event.js');
    vi.doUnmock('../../../src/bus/task.js');
    vi.restoreAllMocks();

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalParent === undefined) delete process.env.CTX_PARENT_AGENT;
    else process.env.CTX_PARENT_AGENT = originalParent;

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('applies orphan reclaim once per orphan and leaves all human-exempt tasks untouched', async () => {
    declareAgent(frameworkRoot, 'acme', 'frank2');

    writeTask(homeDir, makeTask({
      id: 'task_orphan_non_live',
      title: 'Backfill worker-owned task',
      assigned_to: 'ghost-agent',
      created_by: 'transcript-scanner-1783880818',
    }));
    writeTask(homeDir, makeTask({
      id: 'task_orphan_worker',
      title: 'Ephemeral worker orphan',
      assigned_to: 'transcript-scanner-1783880818',
      created_by: 'transcript-scanner-1783880818',
    }));
    writeTask(homeDir, makeTask({
      id: 'task_human_title',
      title: '[HUMAN] Call customer',
      assigned_to: 'ghost-agent',
      created_by: 'transcript-scanner-1783880818',
    }));
    writeTask(homeDir, makeTask({
      id: 'task_human_assignee',
      title: 'Needs a human approval',
      assigned_to: 'human',
      created_by: 'transcript-scanner-1783880818',
    }));
    writeTask(homeDir, makeTask({
      id: 'task_human_project',
      title: 'Manual bookkeeping',
      assigned_to: 'ghost-agent',
      created_by: 'transcript-scanner-1783880818',
      project: 'human-tasks',
    }));

    const { ReconcileTrigger } = await loadReconcileTrigger();
    const trigger = new ReconcileTrigger(
      makeManager(
        [{ name: 'frank2', status: 'running', pid: 1234, uptime: 60 }],
        [{
          name: 'transcript-scanner-1783880818',
          status: 'running',
          dir: '/tmp/worker',
          parent: 'frank2',
          spawnedAt: nowIso(),
        }],
      ),
      'default',
      frameworkRoot,
      'acme',
    );

    const report = trigger.runOnce();

    expect(report).not.toBeNull();
    expect(readTask(homeDir, 'acme', 'task_orphan_non_live').assigned_to).toBe('frank2');
    expect(readTask(homeDir, 'acme', 'task_orphan_worker').assigned_to).toBe('frank2');
    expect(readTask(homeDir, 'acme', 'task_human_title').assigned_to).toBe('ghost-agent');
    expect(readTask(homeDir, 'acme', 'task_human_assignee').assigned_to).toBe('human');
    expect(readTask(homeDir, 'acme', 'task_human_project').assigned_to).toBe('ghost-agent');

    const reclaimEvents = logEventMock.mock.calls.filter((call) => call[4] === 'task_reclaimed');
    expect(reclaimEvents).toHaveLength(2);
    expect(new Set(reclaimEvents.map((call) => (call[6] as { task_id: string }).task_id))).toEqual(
      new Set(['task_orphan_non_live', 'task_orphan_worker']),
    );
    for (const call of reclaimEvents) {
      expect(call[2]).toBe('acme');
      expect(call[6]).toMatchObject({
        to: 'frank2',
      });
    }
  });

  it('swallows reclaim failures and still returns the reconcile report', async () => {
    declareAgent(frameworkRoot, 'acme', 'frank2');

    const { ReconcileTrigger } = await loadReconcileTrigger({ reclaimThrows: 'boom' });
    const trigger = new ReconcileTrigger(
      makeManager(
        [{ name: 'frank2', status: 'running', pid: 1234, uptime: 60 }],
        [],
      ),
      'default',
      frameworkRoot,
      'acme',
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = trigger.runOnce();

    expect(report).not.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('[reconcile-trigger] orphan reclaim failed: boom');
  });
});
