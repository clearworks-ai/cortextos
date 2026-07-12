import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask } from '../../../src/bus/task';
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

function readInbox(agentName: string): Array<{ text: string }> {
  const inboxDir = join(tempCtxRoot, 'inbox', agentName);
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir)
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(inboxDir, file), 'utf-8')) as { text: string });
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

describe('bus sweep-due-tasks + create-task --due', () => {
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;

  beforeEach(() => {
    tempCtxRoot = mkdtempSync(join(tmpdir(), 'bus-sweep-due-'));
    process.env.CTX_ROOT = tempCtxRoot;
    process.env.CTX_AGENT_NAME = 'codexer';
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'acme';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;
    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;
    if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstanceId;
    if (originalOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = originalOrg;
    rmSync(tempCtxRoot, { recursive: true, force: true });
  });

  it('prints a dry-run report by default without stamping or messaging', async () => {
    const paths = makePaths('codexer');
    const overdueId = createTask(paths, 'larry', 'acme', 'Overdue task', {
      assignee: 'frank2',
      dueDate: '2026-07-10T10:00:00Z',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'sweep-due-tasks']);

    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(report.dry_run).toBe(true);
    expect(report.actions).toEqual([
      expect.objectContaining({ id: overdueId, reasons: ['overdue'] }),
    ]);
    expect(readTask(overdueId).resurfaced_at).toBeUndefined();
    expect(readInbox('frank2')).toEqual([]);
  });

  it('apply mode stamps the task, delivers a message, and reports delivery', async () => {
    const paths = makePaths('codexer');
    const overdueId = createTask(paths, 'larry', 'acme', 'Apply overdue task', {
      assignee: 'frank2',
      dueDate: '2026-07-10T10:00:00Z',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'sweep-due-tasks', '--apply']);

    const report = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(report.dry_run).toBe(false);
    expect(report.actions).toEqual([
      expect.objectContaining({ id: overdueId, reasons: ['overdue'] }),
    ]);
    expect(report.delivery).toEqual({
      delivered: 1,
      failed: [],
    });
    expect(readTask(overdueId).resurfaced_at).toBeTruthy();
    expect(readInbox('frank2')).toHaveLength(1);
    expect(readInbox('frank2')[0].text).toContain('Task overdue: [normal] Apply overdue task');
  });

  it('rejects --dry-run and --apply together', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'sweep-due-tasks', '--dry-run', '--apply']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith('Choose either --dry-run or --apply, not both');
  });

  it('parses ISO, date-only, and relative --due values while keeping stdout to task id only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T10:00:00Z'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'ISO due', '--due', '2026-07-12T11:22:33Z']);
    const isoId = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(isoId).toMatch(/^task_\d+_\d{8}$/);
    expect(readTask(isoId).due_date).toBe('2026-07-12T11:22:33Z');

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Date due', '--due', '2026-07-15']);
    const dateId = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(readTask(dateId).due_date).toBe('2026-07-15T23:59:59Z');

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Plus days', '--due', '+2d']);
    const plusDaysId = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(readTask(plusDaysId).due_date).toBe('2026-07-14T10:00:00Z');

    await busCommand.parseAsync(['node', 'bus', 'create-task', 'Plus hours', '--due', '+3h']);
    const plusHoursId = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(readTask(plusHoursId).due_date).toBe('2026-07-12T13:00:00Z');
  });

  it('rejects invalid --due values with exit 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'create-task', 'Bad due', '--due', 'tomorrow-ish']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(
      "Invalid --due value 'tomorrow-ish': use ISO datetime, YYYY-MM-DD, +<n>d, or +<n>h",
    );
  });
});
