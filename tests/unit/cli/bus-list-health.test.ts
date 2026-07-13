import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, completeTask, listTasks } from '../../../src/bus/task';
import type { BusPaths, Task } from '../../../src/types/index';

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
    heartbeatDir: join(tempCtxRoot, 'heartbeats'),
  };
}

function readTask(taskId: string): Task {
  return JSON.parse(readFileSync(join(tempCtxRoot, 'tasks', `${taskId}.json`), 'utf-8')) as Task;
}

function patchTask(taskId: string, patch: Partial<Task>): Task {
  const nextTask = { ...readTask(taskId), ...patch };
  writeFileSync(join(tempCtxRoot, 'tasks', `${taskId}.json`), JSON.stringify(nextTask));
  return nextTask;
}

function seedLiveAgent(agentName: string): void {
  mkdirSync(join(tempCtxRoot, 'orgs', 'acme', 'agents', agentName), { recursive: true });
  writeFileSync(join(tempCtxRoot, 'orgs', 'acme', 'agents', agentName, 'IDENTITY.md'), '# Agent\n');
  mkdirSync(join(tempCtxRoot, 'state', agentName), { recursive: true });
  writeFileSync(join(tempCtxRoot, 'state', agentName, 'heartbeat.json'), JSON.stringify({
    last_heartbeat: new Date().toISOString(),
    current_task: '',
    mode: 'active',
  }));
}

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: (agentName: string) => makePaths(agentName),
}));

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async send() {
      return { success: true, data: [] };
    }
  },
}));

import { busCommand } from '../../../src/cli/bus';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

describe('bus list-tasks + task-health', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const originalProjectRoot = process.env.CTX_PROJECT_ROOT;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-list-health-'));
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'codexer';
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'acme';
    process.env.CTX_FRAMEWORK_ROOT = tempCtxRoot;
    process.env.CTX_PROJECT_ROOT = tempCtxRoot;
    seedLiveAgent('frank2');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;
    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;
    if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstanceId;
    if (originalOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = originalOrg;
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    if (originalProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    rmSync(tempCtxRoot, { recursive: true, force: true });
  });

  it('list-tasks --limit 2 --format json returns at most 2 tasks', async () => {
    const paths = makePaths('codexer');
    createTask(paths, 'paul', 'acme', 'Task 1');
    createTask(paths, 'paul', 'acme', 'Task 2');
    createTask(paths, 'paul', 'acme', 'Task 3');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--limit', '2', '--format', 'json']);

    const rows = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '[]')) as Task[];
    expect(rows).toHaveLength(2);
  });

  it('list-tasks --limit abc exits 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'list-tasks', '--limit', 'abc']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith('Invalid --limit value: must be a positive integer');
  });

  it('list-tasks --limit 0 and --limit -3 exit 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    for (const value of ['0', '-3']) {
      await expect(
        busCommand.parseAsync(['node', 'bus', 'list-tasks', '--limit', value]),
      ).rejects.toThrow('__PROCESS_EXIT_1__');
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it('list-tasks --limit 500 is clamped, not rejected', async () => {
    const paths = makePaths('codexer');
    createTask(paths, 'paul', 'acme', 'Task 1');
    createTask(paths, 'paul', 'acme', 'Task 2');
    createTask(paths, 'paul', 'acme', 'Task 3');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--limit', '500', '--format', 'json']);

    const rows = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '[]')) as Task[];
    expect(rows).toHaveLength(3);
  });

  it('list-tasks --open defaults to build class and 50 cap, excluding completed and [HUMAN] tasks', async () => {
    const paths = makePaths('codexer');
    const openBuildId = createTask(paths, 'paul', 'acme', 'Open build');
    const completedId = createTask(paths, 'paul', 'acme', 'Completed build');
    completeTask(paths, completedId, 'done');
    createTask(paths, 'paul', 'acme', '[HUMAN] approve invoice');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--open', '--format', 'json']);

    const rows = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '[]')) as Array<Task & { class: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(openBuildId);
  });

  it('bare list-tasks is unchanged', async () => {
    const paths = makePaths('codexer');
    createTask(paths, 'paul', 'acme', 'Pending');
    const completedId = createTask(paths, 'paul', 'acme', 'Completed');
    completeTask(paths, completedId, 'done');
    createTask(paths, 'paul', 'acme', '[HUMAN] review');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-tasks', '--format', 'json']);

    const rows = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '[]')) as Array<Task & { class: string }>;
    expect(rows.map(row => row.id)).toEqual(listTasks(paths, {}).map(task => task.id));
  });

  it('task-health prints one clean line and exits 0 when there are no exceptions', async () => {
    const paths = makePaths('codexer');
    createTask(paths, 'paul', 'acme', 'Fresh task', { assignee: 'frank2' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'task-health']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? '')).toMatch(/^Fleet task health: clean —/);
  });

  it('task-health renders totals plus only non-empty exception sections', async () => {
    const paths = makePaths('codexer');
    // Keep fixture dates relative so the overdue/not-overdue split stays deterministic against the wall clock.
    const nowMs = Date.now();
    const overdueId = createTask(paths, 'paul', 'acme', 'Overdue task', { assignee: 'frank2' });
    patchTask(overdueId, {
      due_date: new Date(nowMs - 2 * 86400_000).toISOString(),
      updated_at: new Date(nowMs - 60_000).toISOString(),
    });
    const orphanId = createTask(paths, 'paul', 'acme', 'Ephemeral orphan', {
      assignee: 'transcript-scanner-1783880818',
    });
    patchTask(orphanId, {
      due_date: new Date(nowMs + 86400_000).toISOString(),
      updated_at: new Date(nowMs - 60_000).toISOString(),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'task-health']);

    const output = logSpy.mock.calls.map(call => String(call[0] ?? '')).join('\n');
    expect(output).toContain('Agent × status totals');
    expect(output).toContain('Overdue (1)');
    expect(output).toContain('Orphaned (1)');
    expect(output).not.toContain('Stalled (');
  });

  it('task-health --json emits a parseable single-line FleetTaskHealthReport', async () => {
    const paths = makePaths('codexer');
    createTask(paths, 'paul', 'acme', 'Fresh build', { assignee: 'frank2' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'task-health', '--json']);

    const raw = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(raw.includes('\n')).toBe(false);
    const report = JSON.parse(raw) as {
      class_scope: string;
      totals: unknown[];
      overdue: unknown[];
      stalled: unknown[];
      orphaned: unknown[];
    };
    expect(report.class_scope).toBe('build');
    expect(Array.isArray(report.totals)).toBe(true);
    expect(Array.isArray(report.overdue)).toBe(true);
    expect(Array.isArray(report.stalled)).toBe(true);
    expect(Array.isArray(report.orphaned)).toBe(true);
  });

  it('task-health --class bogus exits 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'task-health', '--class', 'bogus']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith("Invalid class 'bogus'. Must be one of: system, human, build");
  });

  it('task-health --class human surfaces human tasks and excludes build', async () => {
    const paths = makePaths('codexer');
    const humanId = createTask(paths, 'paul', 'acme', '[HUMAN] chase invoice', { assignee: 'human' });
    patchTask(humanId, {
      due_date: '2026-07-10T10:00:00Z',
      updated_at: '2026-07-12T10:00:00Z',
    });
    createTask(paths, 'paul', 'acme', 'Build task', { assignee: 'frank2' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'task-health', '--class', 'human', '--json']);

    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}')) as {
      overdue: Array<{ id: string }>;
    };
    expect(report.overdue.map(row => row.id)).toEqual([humanId]);
  });
});
