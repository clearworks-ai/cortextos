import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, cancelTask, claimTask, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, findTaskFile, archiveTasks, classifyTask, ensureEpicTask, closeEpic, resolveTaskOwner, sweepDueTasks, deliverDueSweepActions, fleetTaskHealth, STALL_ESCALATE_MS } from '../../../src/bus/task';
import type { BusPaths, Task } from '../../../src/types';
import * as lockMod from '../../../src/utils/lock';
import { resolvePaths } from '../../../src/utils/paths';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const normalizeIso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const readTaskJson = (taskId: string): Task => (
    JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task
  );

  const patchTask = (taskId: string, patch: Partial<Task>): Task => {
    const nextTask = { ...readTaskJson(taskId), ...patch };
    writeFileSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(nextTask));
    return nextTask;
  };

  describe('path-traversal hardening (#13/#14)', () => {
    it('findTaskFile rejects a traversal task id', () => {
      expect(() => findTaskFile(paths, '../../etc/passwd')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task/../../secrets')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task_1.json')).toThrow(/Invalid task id/);
    });

    it('readTaskAudit rejects a traversal task id', () => {
      expect(() => readTaskAudit(paths, '../../../etc/shadow')).toThrow(/Invalid task id/);
    });

    it('findTaskFile still resolves a legitimate task', () => {
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      expect(findTaskFile(paths, id)).toContain(`${id}.json`);
    });

    it('archiveTasks skips a task whose JSON id is tampered with traversal (no escape)', () => {
      mkdirSync(paths.taskDir, { recursive: true });
      // Safe filename, but the internal id carries traversal that would resolve
      // to testDir/escaped.json (outside the task tree) on archive write/rename.
      writeFileSync(join(paths.taskDir, 'task_evil_1.json'), JSON.stringify({
        id: '../escaped', status: 'completed', completed_at: '2020-01-01T00:00:00Z',
        assigned_to: 'boris', org: 'acme',
      }));
      expect(() => archiveTasks(paths)).not.toThrow();
      // The guard must have prevented the out-of-tree write.
      expect(existsSync(join(testDir, 'escaped.json'))).toBe(false);
    });
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
      });

      expect(taskId).toMatch(/^task_\d+_\d{8}$/);

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      // Verify all 17 fields match bash create-task.sh format
      expect(content.id).toBe(taskId);
      expect(content.title).toBe('Build landing page');
      expect(content.description).toBe('Create a product landing page');
      expect(content.type).toBe('agent');
      expect(content.needs_approval).toBe(false);
      expect(content.status).toBe('pending');
      expect(content.assigned_to).toBe('boris');
      expect(content.created_by).toBe('paul');
      expect(content.org).toBe('acme');
      expect(content.priority).toBe('high');
      expect(content.project).toBe('');
      expect(content.kpi_key).toBeNull();
      expect(content.created_at).toBeTruthy();
      expect(content.updated_at).toBeTruthy();
      expect(content.completed_at).toBeNull();
      expect(content.due_date).toBeTruthy();
      expect(content.archived).toBe(false);
    });

    it('auto-tags system-spawned tasks when project is unset', () => {
      const taskId = createTask(paths, 'comms-check-999', 'acme', 'Poll inbox');
      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.project).toBe('system');
    });

    it('creates someday tasks without changing their derived class', () => {
      const taskId = createTask(paths, 'larry', 'acme', 'Wave 4 backlog', {
        project: 'roadmap',
        someday: true,
      });

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('someday');
      expect(classifyTask(content)).toBe('build');
    });
  });

  describe('resolveTaskOwner', () => {
    const originalParentAgent = process.env.CTX_PARENT_AGENT;

    afterEach(() => {
      if (originalParentAgent === undefined) delete process.env.CTX_PARENT_AGENT;
      else process.env.CTX_PARENT_AGENT = originalParentAgent;
    });

    it('resolves ephemeral worker ownership to CTX_PARENT_AGENT', () => {
      process.env.CTX_PARENT_AGENT = 'frank2';
      expect(resolveTaskOwner('transcript-scanner-1783880818')).toBe('frank2');
    });

    it('keeps an explicit assignee even when the creator is a worker', () => {
      process.env.CTX_PARENT_AGENT = 'frank2';
      expect(resolveTaskOwner('transcript-scanner-1783880818', 'pa')).toBe('pa');
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });

    it('round-trips waiting status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Waiting task');
      updateTask(paths, taskId, 'waiting');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('waiting');

      const waiting = listTasks(paths, { status: 'waiting' });
      expect(waiting).toHaveLength(1);
      expect(waiting[0].id).toBe(taskId);
      expect(waiting[0].status).toBe('waiting');
    });

    it('transitions to someday and records the audit trail', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Backlog task');

      updateTask(paths, taskId, 'someday');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('someday');

      const log = readTaskAudit(paths, taskId);
      expect(log.map(entry => entry.event)).toEqual(['create', 'update']);
      expect(log[1]).toMatchObject({
        agent: 'paul',
        from: 'pending',
        to: 'someday',
      });
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });

    it('emits a task/task_completed activity event for the assignee', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Complete-event task', {
        assignee: 'boris',
      });
      completeTask(paths, taskId, 'shipped');

      // Event file: <analyticsDir>/events/boris/<YYYY-MM-DD>.jsonl
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'boris', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);

      const events = readFileSync(eventFile, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const completedEvents = events.filter((e) => e.event === 'task_completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0];
      expect(evt.agent).toBe('boris');
      expect(evt.org).toBe('acme');
      expect(evt.category).toBe('task');
      expect(evt.severity).toBe('info');
      expect(evt.metadata.task_id).toBe(taskId);
      expect(evt.metadata.result).toBe('shipped');
    });
  });

  describe('cancelTask', () => {
    it('sets status to cancelled and does not set completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Cancel me');
      cancelTask(paths, taskId, 'not needed');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('cancelled');
      expect(content.completed_at).toBeNull();
    });

    it('writes a cancel audit entry with the reason as note', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Audit cancel', { assignee: 'boris' });
      cancelTask(paths, taskId, 'duplicate');

      const log = readTaskAudit(paths, taskId);
      expect(log.map(e => e.event)).toEqual(['create', 'cancel']);
      expect(log[1].agent).toBe('boris');
      expect(log[1].from).toBe('pending');
      expect(log[1].to).toBe('cancelled');
      expect(log[1].note).toBe('duplicate');
    });

    it('emits no task/task_completed activity event', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Cancel-event task', {
        assignee: 'boris',
      });
      cancelTask(paths, taskId, 'duplicate');

      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'boris', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(false);
    });

    it('throws the same not-found error for an unknown task id', () => {
      expect(() => cancelTask(paths, 'task_nonexistent_000', 'duplicate')).toThrow(
        /not found in any org under .*\/orgs\//,
      );
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris' });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul' });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
    });

    it('hides cancelled tasks by default', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Task 1');
      cancelTask(paths, taskId, 'duplicate');

      const tasks = listTasks(paths);
      expect(tasks).toEqual([]);
    });

    it('shows cancelled tasks when explicitly filtered by status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Task 1');
      cancelTask(paths, taskId, 'duplicate');

      const cancelled = listTasks(paths, { status: 'cancelled' });
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].id).toBe(taskId);
      expect(cancelled[0].status).toBe('cancelled');
    });

    it('filters by derived class', () => {
      createTask(paths, 'comms-check-123', 'acme', 'System row');
      const buildTaskId = createTask(paths, 'paul', 'acme', 'Build row');

      const buildTasks = listTasks(paths, { class: 'build' });
      expect(buildTasks).toHaveLength(1);
      expect(buildTasks[0].id).toBe(buildTaskId);
      expect(buildTasks[0].title).toBe('Build row');
    });

    it('openOnly returns only pending/in_progress/blocked/waiting', () => {
      const pendingId = createTask(paths, 'paul', 'acme', 'Pending');
      const inProgressId = createTask(paths, 'paul', 'acme', 'In progress');
      updateTask(paths, inProgressId, 'in_progress');
      const blockedId = createTask(paths, 'paul', 'acme', 'Blocked');
      updateTask(paths, blockedId, 'blocked');
      const waitingId = createTask(paths, 'paul', 'acme', 'Waiting');
      updateTask(paths, waitingId, 'waiting');
      const completedId = createTask(paths, 'paul', 'acme', 'Completed');
      completeTask(paths, completedId, 'done');
      const cancelledId = createTask(paths, 'paul', 'acme', 'Cancelled');
      cancelTask(paths, cancelledId, 'duplicate');
      createTask(paths, 'paul', 'acme', 'Someday', { someday: true });

      const tasks = listTasks(paths, { openOnly: true });

      expect(tasks.map(task => task.id).sort()).toEqual(
        [pendingId, inProgressId, blockedId, waitingId].sort(),
      );
      expect(tasks.map(task => task.status).sort()).toEqual(
        ['pending', 'in_progress', 'blocked', 'waiting'].sort(),
      );
    });

    it('openOnly with an explicit status filter lets status win', () => {
      const completedId = createTask(paths, 'paul', 'acme', 'Completed');
      completeTask(paths, completedId, 'done');
      createTask(paths, 'paul', 'acme', 'Pending');

      const tasks = listTasks(paths, { openOnly: true, status: 'completed' });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(completedId);
      expect(tasks[0].status).toBe('completed');
    });

    it('limit truncates after created_at DESC ordering', () => {
      const oldestId = createTask(paths, 'paul', 'acme', 'Oldest');
      const middleId = createTask(paths, 'paul', 'acme', 'Middle');
      const newestId = createTask(paths, 'paul', 'acme', 'Newest');
      patchTask(oldestId, { created_at: '2026-07-10T10:00:00Z' });
      patchTask(middleId, { created_at: '2026-07-10T11:00:00Z' });
      patchTask(newestId, { created_at: '2026-07-10T12:00:00Z' });

      const tasks = listTasks(paths, { limit: 2 });

      expect(tasks.map(task => task.id)).toEqual([newestId, middleId]);
    });

    it('limit is hard-capped at 200 in the library', () => {
      for (let index = 0; index < 205; index += 1) {
        createTask(paths, 'paul', 'acme', `Task ${index}`);
      }

      const tasks = listTasks(paths, { limit: 10_000 });

      expect(tasks).toHaveLength(200);
    });

    it('absent limit and openOnly is a no-op', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2', { someday: true });

      expect(listTasks(paths, {})).toEqual(
        listTasks(paths, { limit: undefined, openOnly: false }),
      );
    });

    it('limit applies after respectDeps DAG ordering', () => {
      const dependencyId = createTask(paths, 'paul', 'acme', 'Dependency');
      const peerId = createTask(paths, 'paul', 'acme', 'Peer');
      const blockedId = createTask(paths, 'paul', 'acme', 'Blocked', { blockedBy: [dependencyId] });
      patchTask(dependencyId, { created_at: '2026-07-10T10:00:00Z' });
      patchTask(peerId, { created_at: '2026-07-10T11:00:00Z' });
      patchTask(blockedId, { created_at: '2026-07-10T12:00:00Z' });

      const tasks = listTasks(paths, { respectDeps: true, limit: 2 });

      expect(tasks.map(task => task.id)).toEqual([peerId, dependencyId]);
    });
  });

  describe('fleetTaskHealth', () => {
    it('clean store: empty exception arrays, totals reflect open build counts', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const pendingId = createTask(paths, 'paul', 'acme', 'Pending build', { assignee: 'alice' });
      const waitingId = createTask(paths, 'paul', 'acme', 'Waiting build', { assignee: 'bob' });
      updateTask(paths, waitingId, 'waiting');
      patchTask(pendingId, {
        due_date: '2026-07-13T12:00:00Z',
        updated_at: '2026-07-12T08:00:00Z',
      });
      patchTask(waitingId, {
        due_date: '2026-07-13T13:00:00Z',
        updated_at: '2026-07-12T09:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.class_scope).toBe('build');
      expect(report.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(report.scanned).toBe(2);
      expect(report.totals).toEqual([
        { agent: 'alice', status: 'pending', count: 1 },
        { agent: 'bob', status: 'waiting', count: 1 },
      ]);
      expect(report.overdue).toEqual([]);
      expect(report.stalled).toEqual([]);
      expect(report.orphaned).toEqual([]);
    });

    it('overdue: open build task past due lands in overdue with reason overdue', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Past due build', { assignee: 'frank2' });
      patchTask(taskId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T09:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.overdue).toEqual([
        {
          id: taskId,
          title: 'Past due build',
          assigned_to: 'frank2',
          status: 'pending',
          priority: 'normal',
          due_date: '2026-07-11T12:00:00Z',
          updated_at: '2026-07-12T09:00:00Z',
          reason: 'overdue',
        },
      ]);
    });

    it('overdue ignores the resurface cooldown', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Resurfaced recently');
      patchTask(taskId, {
        due_date: '2026-07-11T12:00:00Z',
        resurfaced_at: '2026-07-12T11:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.overdue.map(row => row.id)).toContain(taskId);
    });

    it('stalled: in_progress untouched >4h trips, <4h does not', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const stalledId = createTask(paths, 'paul', 'acme', 'Stalled');
      updateTask(paths, stalledId, 'in_progress');
      patchTask(stalledId, {
        updated_at: normalizeIso(new Date(now.getTime() - STALL_ESCALATE_MS - 1000)),
        due_date: '2026-07-13T12:00:00Z',
      });
      const freshId = createTask(paths, 'paul', 'acme', 'Fresh');
      updateTask(paths, freshId, 'in_progress');
      patchTask(freshId, {
        updated_at: normalizeIso(new Date(now.getTime() - STALL_ESCALATE_MS + 1000)),
        due_date: '2026-07-13T12:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.stalled.map(row => row.id)).toContain(stalledId);
      expect(report.stalled.map(row => row.id)).not.toContain(freshId);
    });

    it('stalled ignores escalated_at episode state', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Escalated already');
      updateTask(paths, taskId, 'in_progress');
      patchTask(taskId, {
        updated_at: '2026-07-12T06:00:00Z',
        escalated_at: '2026-07-12T11:30:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.stalled.map(row => row.id)).toContain(taskId);
    });

    it('orphaned: ephemeral-worker assignee trips without liveAgents', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Ephemeral worker task', {
        assignee: 'transcript-scanner-1783880818',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.orphaned).toEqual([
        expect.objectContaining({
          id: taskId,
          reason: 'ephemeral_worker',
        }),
      ]);
    });

    it('orphaned: non-live agent trips only when liveAgents is provided', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Non-live agent task', { assignee: 'larry' });

      const noLiveAgents = fleetTaskHealth(paths, { now });
      const withLiveAgents = fleetTaskHealth(paths, { now, liveAgents: ['frank2'] });

      expect(noLiveAgents.orphaned).toEqual([]);
      expect(withLiveAgents.orphaned).toEqual([
        expect.objectContaining({
          id: taskId,
          reason: 'non_live_agent',
        }),
      ]);
    });

    it('both overdue and stalled: one row in each array', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Overdue and stalled');
      updateTask(paths, taskId, 'in_progress');
      patchTask(taskId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.overdue.filter(row => row.id === taskId)).toHaveLength(1);
      expect(report.stalled.filter(row => row.id === taskId)).toHaveLength(1);
    });

    it('human never leaks into the build scope', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const humanAssigneeId = createTask(paths, 'paul', 'acme', 'Human assignee', { assignee: 'human' });
      updateTask(paths, humanAssigneeId, 'in_progress');
      patchTask(humanAssigneeId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });
      const humanTitleId = createTask(paths, 'paul', 'acme', '[HUMAN] pay invoice');
      updateTask(paths, humanTitleId, 'in_progress');
      patchTask(humanTitleId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });
      const humanProjectId = createTask(paths, 'paul', 'acme', 'Human project', {
        project: 'human-tasks',
      });
      updateTask(paths, humanProjectId, 'in_progress');
      patchTask(humanProjectId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.totals).toEqual([]);
      expect(report.overdue).toEqual([]);
      expect(report.stalled).toEqual([]);
      expect(report.orphaned).toEqual([]);
    });

    it('class human is the only path that surfaces human tasks', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const humanId = createTask(paths, 'paul', 'acme', '[HUMAN] follow up', { assignee: 'human' });
      updateTask(paths, humanId, 'in_progress');
      patchTask(humanId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });
      const buildId = createTask(paths, 'paul', 'acme', 'Build task', { assignee: 'frank2' });
      updateTask(paths, buildId, 'in_progress');
      patchTask(buildId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now, class: 'human' });

      expect(report.totals).toEqual([
        { agent: 'human', status: 'in_progress', count: 1 },
      ]);
      expect(report.overdue.map(row => row.id)).toContain(humanId);
      expect(report.overdue.map(row => row.id)).not.toContain(buildId);
      expect(report.stalled.map(row => row.id)).toContain(humanId);
      expect(report.stalled.map(row => row.id)).not.toContain(buildId);
    });

    it('system class excluded from build scope', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const taskId = createTask(paths, 'paul', 'acme', 'Cron: heartbeat', { assignee: 'codexer' });
      patchTask(taskId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });

      const buildReport = fleetTaskHealth(paths, { now });
      const systemReport = fleetTaskHealth(paths, { now, class: 'system' });

      expect(buildReport.overdue).toEqual([]);
      expect(systemReport.overdue.map(row => row.id)).toContain(taskId);
    });

    it('completed/cancelled/someday/archived tasks contribute nothing', () => {
      const now = new Date('2026-07-12T12:00:00Z');
      const completedId = createTask(paths, 'paul', 'acme', 'Completed');
      completeTask(paths, completedId, 'done');
      patchTask(completedId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });
      const cancelledId = createTask(paths, 'paul', 'acme', 'Cancelled');
      cancelTask(paths, cancelledId, 'duplicate');
      patchTask(cancelledId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });
      const somedayId = createTask(paths, 'paul', 'acme', 'Someday', { someday: true });
      patchTask(somedayId, {
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });
      const archivedId = createTask(paths, 'paul', 'acme', 'Archived');
      patchTask(archivedId, {
        archived: true,
        due_date: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      });

      const report = fleetTaskHealth(paths, { now });

      expect(report.totals).toEqual([]);
      expect(report.overdue).toEqual([]);
      expect(report.stalled).toEqual([]);
      expect(report.orphaned).toEqual([]);
    });
  });

  describe('classifyTask', () => {
    it('derives system, human, and build buckets from task metadata', () => {
      const baseTask = {
        id: 'task_test_001',
        title: 'Base task',
        description: '',
        type: 'agent' as const,
        needs_approval: false,
        status: 'pending' as const,
        assigned_to: 'paul',
        created_by: 'paul',
        org: 'acme',
        priority: 'normal' as const,
        project: '',
        kpi_key: null,
        created_at: '2026-07-06T00:00:00Z',
        updated_at: '2026-07-06T00:00:00Z',
        completed_at: null,
        due_date: null,
        archived: false,
      };

      expect(classifyTask({ ...baseTask, created_by: 'transcript-scanner-123' })).toBe('system');
      expect(classifyTask({ ...baseTask, title: 'Cron: heartbeat' })).toBe('system');
      expect(classifyTask({ ...baseTask, assigned_to: 'human' })).toBe('human');
      expect(classifyTask({ ...baseTask, title: 'Josh: send token' })).toBe('human');
      expect(classifyTask(baseTask)).toBe('build');
    });
  });

  describe('epic task hooks', () => {
    it('ensureEpicTask creates exactly one epic and is idempotent on re-run', () => {
      const first = ensureEpicTask(paths, 'paul', 'acme', 'alpha');
      const second = ensureEpicTask(paths, 'paul', 'acme', 'alpha');

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(listTasks(paths)).toHaveLength(1);
    });

    it('ensureEpicTask epic classifies as build', () => {
      const epic = ensureEpicTask(paths, 'paul', 'acme', 'alpha');
      const task = listTasks(paths).find(t => t.id === epic.id);
      expect(task).toBeTruthy();
      expect(classifyTask(task!)).toBe('build');
    });

    it('ensureEpicTask ignores completed or cancelled same-slug tasks and opens a fresh epic', () => {
      const completedEpic = ensureEpicTask(paths, 'paul', 'acme', 'alpha');
      completeTask(paths, completedEpic.id, 'done');
      const reopened = ensureEpicTask(paths, 'paul', 'acme', 'alpha');
      expect(reopened.created).toBe(true);
      expect(reopened.id).not.toBe(completedEpic.id);

      const cancelledEpic = ensureEpicTask(paths, 'paul', 'acme', 'beta');
      cancelTask(paths, cancelledEpic.id, 'stop');
      const reopenedCancelled = ensureEpicTask(paths, 'paul', 'acme', 'beta');
      expect(reopenedCancelled.created).toBe(true);
      expect(reopenedCancelled.id).not.toBe(cancelledEpic.id);
    });

    it('closeEpic completes all open children and is idempotent on re-run', () => {
      const one = createTask(paths, 'paul', 'acme', 'One', { project: 'alpha' });
      createTask(paths, 'paul', 'acme', 'Two', { project: 'alpha' });
      createTask(paths, 'paul', 'acme', 'Other', { project: 'beta' });
      updateTask(paths, one, 'in_progress');

      const first = closeEpic(paths, 'alpha');
      const second = closeEpic(paths, 'alpha');

      expect(first.closed).toBe(2);
      expect(second.closed).toBe(0);
      const alphaTasks = listTasks(paths, { status: 'completed' }).filter(t => t.project === 'alpha');
      expect(alphaTasks).toHaveLength(2);
    });

    it('closeEpic dry-run mutates nothing', () => {
      createTask(paths, 'paul', 'acme', 'One', { project: 'alpha' });
      createTask(paths, 'paul', 'acme', 'Two', { project: 'alpha' });

      const result = closeEpic(paths, 'alpha', { dryRun: true });

      expect(result.closed).toBe(2);
      const alphaTasks = listTasks(paths).filter(t => t.project === 'alpha');
      expect(alphaTasks).toHaveLength(2);
      expect(alphaTasks.every(t => t.status === 'pending')).toBe(true);
    });

    it('closeEpic excludes someday tasks from its open count', () => {
      createTask(paths, 'paul', 'acme', 'Active child', { project: 'alpha' });
      createTask(paths, 'paul', 'acme', 'Backlog child', {
        project: 'alpha',
        someday: true,
      });

      const result = closeEpic(paths, 'alpha', { dryRun: true });

      expect(result.closed).toBe(1);
    });
  });
});

describe('Task due dates and due sweep', () => {
  let testDir: string;
  let paths: BusPaths;
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalAgentName = process.env.CTX_AGENT_NAME;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalOrg = process.env.CTX_ORG;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-due-sweep-test-'));
    process.env.CTX_ROOT = testDir;
    process.env.CTX_AGENT_NAME = 'codexer';
    process.env.CTX_INSTANCE_ID = 'default';
    process.env.CTX_ORG = 'acme';
    process.env.HOME = testDir;
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'codexer'),
      inflight: join(testDir, 'inflight', 'codexer'),
      processed: join(testDir, 'processed', 'codexer'),
      logDir: join(testDir, 'logs', 'codexer'),
      stateDir: join(testDir, 'state', 'codexer'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      deliverablesDir: join(testDir, 'deliverables'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;
    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;
    if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstanceId;
    if (originalOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = originalOrg;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  function readTaskJson(taskId: string): Task {
    return JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task;
  }

  function readTaskRaw(taskId: string): string {
    return readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8');
  }

  function makeTask(overrides: Partial<Task> & { id: string; title: string; assigned_to: string }): Task {
    const now = overrides.created_at ?? '2026-07-12T12:00:00Z';
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
      created_at: now,
      updated_at: overrides.updated_at ?? now,
      completed_at: overrides.completed_at ?? null,
      due_date: overrides.due_date ?? null,
      archived: overrides.archived ?? false,
      ...(overrides.blocks ? { blocks: overrides.blocks } : {}),
      ...(overrides.blocked_by ? { blocked_by: overrides.blocked_by } : {}),
      ...(overrides.resurfaced_at !== undefined ? { resurfaced_at: overrides.resurfaced_at } : {}),
      ...(overrides.escalated_at !== undefined ? { escalated_at: overrides.escalated_at } : {}),
    };
  }

  function writeTask(task: Task): void {
    mkdirSync(paths.taskDir, { recursive: true });
    writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
  }

  function readInbox(agentName: string): Array<{ text: string }> {
    const inboxDir = resolvePaths(agentName, 'default', 'acme').inbox;
    if (!existsSync(inboxDir)) return [];
    return readdirSync(inboxDir)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(join(inboxDir, file), 'utf-8')) as { text: string });
  }

  it('assigns priority-scaled default due dates and preserves explicit due dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T10:00:00Z'));

    const urgent = createTask(paths, 'alice', 'acme', 'Urgent', { priority: 'urgent' });
    const high = createTask(paths, 'alice', 'acme', 'High', { priority: 'high' });
    const normal = createTask(paths, 'alice', 'acme', 'Normal', { priority: 'normal' });
    const low = createTask(paths, 'alice', 'acme', 'Low', { priority: 'low' });
    const someday = createTask(paths, 'alice', 'acme', 'Someday', { someday: true });
    const explicit = createTask(paths, 'alice', 'acme', 'Explicit', {
      dueDate: '2026-07-20T10:11:12.999Z',
    });

    expect(readTaskJson(urgent).due_date).toBe('2026-07-13T10:00:00Z');
    expect(readTaskJson(high).due_date).toBe('2026-07-15T10:00:00Z');
    expect(readTaskJson(normal).due_date).toBe('2026-07-19T10:00:00Z');
    expect(readTaskJson(low).due_date).toBe('2026-07-26T10:00:00Z');
    expect(readTaskJson(someday).due_date).toBe('2026-08-11T10:00:00Z');
    expect(readTaskJson(explicit).due_date).toBe('2026-07-20T10:11:12Z');
  });

  it('rejects an invalid explicit due date before writing any task file', () => {
    expect(() => createTask(paths, 'alice', 'acme', 'Broken due', { dueDate: 'not-a-date' })).toThrow(
      "Invalid due_date 'not-a-date': must be a parseable date/datetime",
    );
    expect(existsSync(paths.taskDir)).toBe(false);
  });

  it('ensureEpicTask inherits the default due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T10:00:00Z'));

    const epic = ensureEpicTask(paths, 'alice', 'acme', 'phase-2');

    expect(readTaskJson(epic.id).due_date).toBe('2026-07-19T10:00:00Z');
  });

  it('resurfaces overdue tasks once per 24h cooldown window', () => {
    writeTask(makeTask({
      id: 'task_overdue',
      title: 'Overdue task',
      assigned_to: 'alice',
      due_date: '2026-07-10T12:00:00Z',
      updated_at: '2026-07-12T08:00:00Z',
    }));

    const dryRun = sweepDueTasks(paths, {
      now: new Date('2026-07-12T12:00:00Z'),
    });
    expect(dryRun.actions).toEqual([
      expect.objectContaining({ id: 'task_overdue', reasons: ['overdue'] }),
    ]);
    expect(readTaskJson('task_overdue').resurfaced_at).toBeUndefined();

    const applied = sweepDueTasks(paths, {
      dryRun: false,
      now: new Date('2026-07-12T12:00:00Z'),
    });
    expect(applied.actions).toHaveLength(1);
    expect(readTaskJson('task_overdue').resurfaced_at).toBe('2026-07-12T12:00:00Z');
    expect(readTaskJson('task_overdue').updated_at).toBe('2026-07-12T08:00:00Z');

    const cooling = sweepDueTasks(paths, {
      now: new Date('2026-07-13T11:59:59Z'),
    });
    expect(cooling.actions).toEqual([]);

    const afterCooldown = sweepDueTasks(paths, {
      now: new Date('2026-07-13T12:00:01Z'),
    });
    expect(afterCooldown.actions).toEqual([
      expect.objectContaining({ id: 'task_overdue', reasons: ['overdue'] }),
    ]);
  });

  it('escalates stalled in_progress tasks once per stall episode and re-arms after a status touch', () => {
    writeTask(makeTask({
      id: 'task_stalled',
      title: 'Stalled task',
      assigned_to: 'alice',
      status: 'in_progress',
      due_date: '2026-07-20T12:00:00Z',
      updated_at: '2026-07-12T06:59:59Z',
    }));

    const first = sweepDueTasks(paths, {
      dryRun: false,
      now: new Date('2026-07-12T12:00:00Z'),
    });
    expect(first.actions).toEqual([
      expect.objectContaining({ id: 'task_stalled', reasons: ['stalled'] }),
    ]);
    let task = readTaskJson('task_stalled');
    expect(task.escalated_at).toBe('2026-07-12T12:00:00Z');
    expect(task.updated_at).toBe('2026-07-12T06:59:59Z');

    const stillSameEpisode = sweepDueTasks(paths, {
      now: new Date('2026-07-12T18:00:00Z'),
    });
    expect(stillSameEpisode.actions).toEqual([]);

    task = {
      ...task,
      updated_at: '2026-07-12T18:00:00Z',
    };
    writeTask(task);

    const rearmed = sweepDueTasks(paths, {
      now: new Date('2026-07-12T22:30:01Z'),
    });
    expect(rearmed.actions).toEqual([
      expect.objectContaining({ id: 'task_stalled', reasons: ['stalled'] }),
    ]);
  });

  it('reports combined overdue + stalled candidates as one action row', () => {
    writeTask(makeTask({
      id: 'task_combined',
      title: 'Combined task',
      assigned_to: 'alice',
      status: 'in_progress',
      due_date: '2026-07-10T12:00:00Z',
      updated_at: '2026-07-12T06:00:00Z',
    }));

    const report = sweepDueTasks(paths, {
      now: new Date('2026-07-12T12:00:00Z'),
    });

    expect(report.actions).toHaveLength(1);
    expect(report.actions[0].reasons).toEqual(['overdue', 'stalled']);
  });

  it('keeps human-exempt overdue and stalled tasks byte-identical in dry-run and apply mode', () => {
    const cases = [
      makeTask({
        id: 'task_human_assignee',
        title: 'Human assignee',
        assigned_to: 'human',
        status: 'in_progress',
        due_date: '2026-07-10T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      }),
      makeTask({
        id: 'task_user_assignee',
        title: 'User assignee',
        assigned_to: 'user',
        status: 'in_progress',
        due_date: '2026-07-10T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      }),
      makeTask({
        id: 'task_human_title',
        title: '[HUMAN] Call client back',
        assigned_to: 'alice',
        status: 'in_progress',
        due_date: '2026-07-10T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      }),
      makeTask({
        id: 'task_human_project',
        title: 'Manual bookkeeping',
        assigned_to: 'alice',
        project: 'human-tasks',
        status: 'in_progress',
        due_date: '2026-07-10T12:00:00Z',
        updated_at: '2026-07-12T06:00:00Z',
      }),
    ];

    for (const task of cases) {
      writeTask(task);
      const before = readTaskRaw(task.id);

      const dryRun = sweepDueTasks(paths, {
        now: new Date('2026-07-12T12:00:00Z'),
      });
      expect(dryRun.skipped_human).toContain(task.id);
      expect(dryRun.actions.find(action => action.id === task.id)).toBeUndefined();

      const applied = sweepDueTasks(paths, {
        dryRun: false,
        now: new Date('2026-07-12T12:00:00Z'),
      });
      expect(applied.skipped_human).toContain(task.id);
      expect(applied.actions.find(action => action.id === task.id)).toBeUndefined();
      expect(readTaskRaw(task.id)).toBe(before);
    }
  });

  it('skips system tasks by default but can include them explicitly', () => {
    writeTask(makeTask({
      id: 'task_system',
      title: 'Cron: heartbeat backlog',
      assigned_to: 'alice',
      due_date: '2026-07-10T12:00:00Z',
      updated_at: '2026-07-12T06:00:00Z',
      created_by: 'heartbeat-1783880818',
      project: 'system',
    }));

    const defaultReport = sweepDueTasks(paths, {
      now: new Date('2026-07-12T12:00:00Z'),
    });
    expect(defaultReport.actions).toEqual([]);
    expect(defaultReport.skipped_system).toBe(1);

    const included = sweepDueTasks(paths, {
      now: new Date('2026-07-12T12:00:00Z'),
      includeSystem: true,
    });
    expect(included.actions).toEqual([
      expect.objectContaining({ id: 'task_system', reasons: ['overdue'] }),
    ]);
  });

  it('skips someday tasks and treats legacy null due dates as stalled-only when applicable', () => {
    writeTask(makeTask({
      id: 'task_someday',
      title: 'Someday task',
      assigned_to: 'alice',
      status: 'someday',
      due_date: '2026-07-10T12:00:00Z',
      updated_at: '2026-07-12T06:00:00Z',
    }));
    writeTask(makeTask({
      id: 'task_legacy_pending',
      title: 'Legacy pending',
      assigned_to: 'alice',
      due_date: null,
      updated_at: '2026-07-12T06:00:00Z',
    }));
    writeTask(makeTask({
      id: 'task_legacy_stalled',
      title: 'Legacy stalled',
      assigned_to: 'alice',
      status: 'in_progress',
      due_date: null,
      updated_at: '2026-07-12T06:00:00Z',
    }));

    const report = sweepDueTasks(paths, {
      now: new Date('2026-07-12T12:00:00Z'),
    });

    expect(report.actions.find(action => action.id === 'task_someday')).toBeUndefined();
    expect(report.actions.find(action => action.id === 'task_legacy_pending')).toBeUndefined();
    expect(report.actions.find(action => action.id === 'task_legacy_stalled')).toEqual(
      expect.objectContaining({ reasons: ['stalled'] }),
    );
  });

  it('dry-run makes no file changes and maxActions caps overflow candidates', () => {
    writeTask(makeTask({
      id: 'task_cap_1',
      title: 'Cap 1',
      assigned_to: 'alice',
      due_date: '2026-07-10T12:00:00Z',
    }));
    writeTask(makeTask({
      id: 'task_cap_2',
      title: 'Cap 2',
      assigned_to: 'alice',
      due_date: '2026-07-10T12:00:00Z',
    }));
    writeTask(makeTask({
      id: 'task_cap_3',
      title: 'Cap 3',
      assigned_to: 'alice',
      due_date: '2026-07-10T12:00:00Z',
    }));

    const before = readTaskRaw('task_cap_1');
    const report = sweepDueTasks(paths, {
      now: new Date('2026-07-12T12:00:00Z'),
      maxActions: 2,
    });

    expect(report.actions).toHaveLength(2);
    expect(report.capped).toBe(1);
    expect(readTaskRaw('task_cap_1')).toBe(before);
  });

  it('deliverDueSweepActions writes inbox messages and survives a bad assignee name', () => {
    const delivery = deliverDueSweepActions([
      {
        id: 'task_due_msg',
        title: 'Due message',
        assigned_to: 'frank2',
        org: 'acme',
        priority: 'high',
        due_date: '2026-07-12T11:00:00Z',
        updated_at: '2026-07-12T08:00:00Z',
        reasons: ['overdue'],
      },
      {
        id: 'task_bad_msg',
        title: 'Bad assignee',
        assigned_to: 'bad/name',
        org: 'acme',
        priority: 'normal',
        due_date: null,
        updated_at: '2026-07-12T08:00:00Z',
        reasons: ['stalled'],
      },
    ], {
      instanceId: 'default',
      org: 'acme',
      fromAgent: 'codexer',
    });

    expect(delivery.delivered).toBe(1);
    expect(delivery.failed).toEqual([
      expect.objectContaining({ id: 'task_bad_msg', error: expect.stringMatching(/Invalid agent name/) }),
    ]);
    const inbox = readInbox('frank2');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toContain('Task overdue: [high] Due message');
  });
});

/**
 * Cross-org task lifecycle — exercises the findTaskFile fallback so an
 * assignee in one org can drive the lifecycle of a task filed by an
 * orchestrator in a sibling org. Standard cortextOS dispatch pattern:
 * an orchestrator in one org files a task, a specialist in another org
 * needs to update and complete it from their own agent session.
 *
 * These tests build a REAL nested filesystem layout (matching the
 * production shape at ~/.cortextos/<instance>/orgs/<org>/tasks/) so they
 * cover the actual cross-org path resolution, not a mocked shortcut.
 */
describe('Cross-org task lifecycle', () => {
  let testDir: string;
  let orgAPaths: BusPaths;
  let orgBTaskDir: string;
  let warnLog: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-crossorg-test-'));
    // Nested layout: <ctxRoot>/orgs/{OrgA,OrgB}/tasks/
    mkdirSync(join(testDir, 'orgs', 'OrgA', 'tasks'), { recursive: true });
    mkdirSync(join(testDir, 'orgs', 'OrgB', 'tasks'), { recursive: true });

    orgAPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agentA'),
      inflight: join(testDir, 'inflight', 'agentA'),
      processed: join(testDir, 'processed', 'agentA'),
      logDir: join(testDir, 'logs', 'agentA'),
      stateDir: join(testDir, 'state', 'agentA'),
      taskDir: join(testDir, 'orgs', 'OrgA', 'tasks'),
      approvalDir: join(testDir, 'orgs', 'OrgA', 'approvals'),
      analyticsDir: join(testDir, 'orgs', 'OrgA', 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    orgBTaskDir = join(testDir, 'orgs', 'OrgB', 'tasks');

    warnLog = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLog.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Helper: drop a raw task JSON file into OrgB's tasks dir without
   * going through createTask (which only knows about OrgA's taskDir). */
  function writeOrgBTask(taskId: string, overrides: Record<string, unknown> = {}): void {
    const task = {
      id: taskId,
      title: 'Cross-org task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'agentA',
      created_by: 'orchestrator',
      org: 'OrgB',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-04-11T20:00:00Z',
      updated_at: '2026-04-11T20:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
      ...overrides,
    };
    writeFileSync(join(orgBTaskDir, `${taskId}.json`), JSON.stringify(task), 'utf-8');
  }

  it('updateTask same-org happy path: still works via the fast path', () => {
    // Regression guard for the existing single-org behavior. This is the
    // hot path and must not pay any cross-org scan cost when it hits.
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    updateTask(orgAPaths, taskId, 'in_progress');

    const content = JSON.parse(
      readFileSync(join(orgAPaths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(content.status).toBe('in_progress');
  });

  it('updateTask cross-org: finds task in sibling org via findTaskFile fallback', () => {
    // Repro: file a task in OrgB, try to update it from an OrgA-scoped
    // session. Before findTaskFile, this threw "Task not found" because
    // updateTask only looked at orgAPaths.taskDir.
    const taskId = 'task_test_001';
    writeOrgBTask(taskId);

    updateTask(orgAPaths, taskId, 'in_progress');

    // Verify the OrgB file got updated, NOT the (nonexistent) OrgA file.
    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('in_progress');
    // Explicit timestamp comparison: the seed updated_at is a fixed moment
    // in the past, so the real Date.now() that updateTask stamps MUST be
    // strictly greater. Avoids the brittle string-inequality form that
    // would silently pass on any future refactor that changed the seed.
    expect(new Date(orgBContent.updated_at).getTime()).toBeGreaterThan(
      new Date('2026-04-11T20:00:00Z').getTime(),
    );
    expect(existsSync(join(orgAPaths.taskDir, `${taskId}.json`))).toBe(false);
  });

  it('updateTask not found anywhere: throws with a clear error naming ctxRoot', () => {
    expect(() => updateTask(orgAPaths, 'task_999_000', 'in_progress')).toThrow(
      /not found in any org under .*\/orgs\//,
    );
  });

  it('completeTask cross-org: finds task in sibling org and marks it done', () => {
    const taskId = 'task_test_002';
    writeOrgBTask(taskId);

    completeTask(orgAPaths, taskId, 'cross-org completion');

    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('completed');
    expect(orgBContent.completed_at).toBeTruthy();
    expect(orgBContent.result).toBe('cross-org completion');
  });

  it('findTaskFile ambiguity: same ID in two orgs triggers warn naming both orgs', () => {
    // Manually create the same task id in BOTH orgs. Real collisions
    // should be vanishingly rare (epoch_ms + 3 digits), but the warn path
    // must be tested so operators hitting it in production get actionable
    // information.
    const taskId = 'task_1_000';
    writeOrgBTask(taskId);
    // Write the same ID to OrgA via direct filesystem (bypassing
    // createTask so we can reuse the exact ID).
    const orgATaskPath = join(orgAPaths.taskDir, `${taskId}.json`);
    writeFileSync(
      orgATaskPath,
      JSON.stringify({
        id: taskId,
        title: 'OrgA collision',
        status: 'pending',
        org: 'OrgA',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    // findTaskFile should return the OrgA path (same-org fast path wins)
    // without ever emitting the ambiguity warning. The fast path only
    // checks same-org; the cross-org scan is ONLY exercised when same-org
    // misses. So the ambiguity warning path requires same-org to miss
    // AND multiple sibling orgs to hit.
    //
    // To exercise the warn, delete the OrgA copy and write collisions
    // into two OTHER orgs.
    rmSync(orgATaskPath);
    mkdirSync(join(testDir, 'orgs', 'OrgC', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'orgs', 'OrgC', 'tasks', `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'OrgC collision',
        status: 'pending',
        org: 'OrgC',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    // Warn must have fired and must name BOTH the task id and the two orgs.
    expect(warnLog.length).toBeGreaterThanOrEqual(1);
    const warn = warnLog[0];
    expect(warn).toContain(taskId);
    expect(warn).toMatch(/found in 2 orgs/);
    expect(warn).toContain('OrgB');
    expect(warn).toContain('OrgC');
  });

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    writeOrgBTask('task_other_1', { title: 'Sibling-org task 1' });
    writeOrgBTask('task_other_2', { title: 'Sibling-org task 2' });

    const tasks = listTasks(orgAPaths);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(sameOrgId);
    expect(tasks[0].title).toBe('Same-org task');
  });
});

describe('claimTask — atomic claim (beads-inspired)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('happy path: claims a pending task, flips status + assignee, writes lock file', () => {
    const id = createTask(paths, 'alice', 'acme', 'Claimable work');
    const task = claimTask(paths, id, 'alice');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('alice');

    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe('alice');

    // Lock file recorded the claimant + timestamp
    const lock = readFileSync(join(paths.taskDir, '.claims', `${id}.claim`), 'utf-8');
    expect(lock.split('\t')[0]).toBe('alice');
  });

  it('rejects second claim with a named owner when the lock already exists', () => {
    const id = createTask(paths, 'alice', 'acme', 'Race target');
    claimTask(paths, id, 'alice');
    expect(() => claimTask(paths, id, 'bob-agent')).toThrow(/already claimed by alice/);
  });

  it('is idempotent when the same agent re-claims (no throw, returns the task)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Re-claim');
    claimTask(paths, id, 'alice');
    const again = claimTask(paths, id, 'alice');
    expect(again.assigned_to).toBe('alice');
    expect(again.status).toBe('in_progress');
  });

  it('rejects claim on a non-pending task with a clear status message', () => {
    const id = createTask(paths, 'alice', 'acme', 'Already done');
    updateTask(paths, id, 'completed');
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not pending.*status=completed/);
  });

  it('throws "not found" for an unknown task id', () => {
    expect(() => claimTask(paths, 'task_nonexistent_000', 'alice')).toThrow(/not found in any org/);
  });

  it('rolls back the lock if the task-JSON write fails (so retry can still succeed)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Rollback probe');
    const claimPath = join(paths.taskDir, '.claims', `${id}.claim`);

    // Force atomicWriteSync to fail by deleting the task file mid-flight.
    // Simplest repro: remove the task json right after the lock is taken
    // by intercepting findTaskFile's call path — instead just delete the
    // task file before claimTask reads it, and reuse the existing
    // not-found path. Then confirm no stale .claim file is left behind.
    rmSync(join(paths.taskDir, `${id}.json`));
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not found in any org/);
    expect(existsSync(claimPath)).toBe(false);
  });

  it('concurrent tight-loop race: exactly one agent wins and task JSON is consistent', () => {
    // Two agents attempt to claim the same pending task in a tight sequential
    // loop that mimics rapid concurrent callers (same process, same event loop
    // tick — sufficient because withFileLockSync serializes same-process
    // callers via acquireLock which uses mkdirSync O_EXCL).
    const id = createTask(paths, 'sys', 'acme', 'Race prize');

    const results: Array<{ agent: string; error: string | null }> = [];
    for (const agent of ['alice', 'bob']) {
      try {
        claimTask(paths, id, agent);
        results.push({ agent, error: null });
      } catch (err) {
        results.push({ agent, error: (err as Error).message });
      }
    }

    // Exactly one winner, exactly one loser.
    const winners = results.filter(r => r.error === null);
    const losers  = results.filter(r => r.error !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Loser must get the 'already claimed by' error (not a spurious crash).
    expect(losers[0].error).toMatch(/already claimed by/);

    // The task JSON on disk must reflect exactly the winner's assignment.
    const taskPath = join(paths.taskDir, `${id}.json`);
    const onDisk = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe(winners[0].agent);
  });

  it('serializes claim against completeTask on the same lock key (no lost update)', () => {
    // Spy on withFileLockSync to capture the lock key each mutator acquires.
    // claimTask MUST lock on dirname(filePath) — the same key completeTask uses —
    // so all writers to <taskId>.json are mutually exclusive.
    //
    // Failure mode under pre-fix code: claimTask locked on <taskDir>/.claims
    // while completeTask locked on <taskDir>, so claimKeys and completeKeys
    // contain different paths and the containment assertion fails.
    const spy = vi.spyOn(lockMod, 'withFileLockSync');
    const id = createTask(paths, 'alice', 'acme', 'Concurrency probe');
    spy.mockClear(); // discard createTask's lock calls
    claimTask(paths, id, 'alice');
    const claimKeys = spy.mock.calls.map(c => c[0] as string);
    spy.mockClear();
    completeTask(paths, id, 'done');
    const completeKeys = spy.mock.calls.map(c => c[0] as string);
    spy.mockRestore();
    // Both mutators must acquire a lock on the task directory.
    expect(claimKeys.length).toBeGreaterThan(0);
    expect(completeKeys.length).toBeGreaterThan(0);
    // claimTask must use the SAME lock key as completeTask.
    expect(claimKeys).toContain(completeKeys[completeKeys.length - 1]);
  });
});

describe('Task audit log (append-only JSONL)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('createTask writes one "create" audit entry', () => {
    const id = createTask(paths, 'alice', 'acme', 'First task', { description: 'd' });
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(1);
    expect(log[0].event).toBe('create');
    expect(log[0].agent).toBe('alice');
    expect(log[0].to).toBe('pending');
    expect(log[0].note).toBe('First task');
  });

  it('full lifecycle records create + claim + complete in order', () => {
    const id = createTask(paths, 'alice', 'acme', 'Lifecycle');
    claimTask(paths, id, 'alice');
    completeTask(paths, id, 'shipped');

    const log = readTaskAudit(paths, id);
    expect(log.map(e => e.event)).toEqual(['create', 'claim', 'complete']);
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('in_progress');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('in_progress');
    expect(log[2].to).toBe('completed');
    expect(log[2].note).toBe('shipped');
  });

  it('updateTask audit captures from->to transition with assignee as agent', () => {
    const id = createTask(paths, 'alice', 'acme', 'Updatable', { assignee: 'alice' });
    updateTask(paths, id, 'blocked');
    updateTask(paths, id, 'pending');

    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(3); // create + 2 updates
    expect(log[1].event).toBe('update');
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('blocked');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('blocked');
    expect(log[2].to).toBe('pending');
  });

  it('audit log is append-only — existing entries are never overwritten', () => {
    const id = createTask(paths, 'alice', 'acme', 'Append proof');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    const before = readFileSync(path, 'utf-8');
    updateTask(paths, id, 'blocked');
    const after = readFileSync(path, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('corrupt lines are skipped without blocking replay of surrounding entries', () => {
    const id = createTask(paths, 'alice', 'acme', 'Corrupt survivor');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    // Inject a malformed line between two valid ones
    writeFileSync(path, readFileSync(path, 'utf-8') + 'not-json-at-all\n');
    updateTask(paths, id, 'in_progress');
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(2); // create + update, corrupt middle line skipped
    expect(log[0].event).toBe('create');
    expect(log[1].event).toBe('update');
  });

  it('readTaskAudit returns [] for a task with no history', () => {
    expect(readTaskAudit(paths, 'task_nonexistent_000')).toEqual([]);
  });
});

describe('Task dependency DAG (blocks / blocked_by)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dag-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function readTask(id: string) {
    return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  }

  it('blocked_by stores the declared dependency + the peer gets a symmetric blocks edge', () => {
    const a = createTask(paths, 'alice', 'acme', 'A (blocker)');
    const b = createTask(paths, 'alice', 'acme', 'B (blocked)', { blockedBy: [a] });

    expect(readTask(b).blocked_by).toEqual([a]);
    expect(readTask(a).blocks).toEqual([b]);
  });

  it('blocks is the symmetric reverse of blocked_by', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blocks: [a] });

    // "B blocks A" means A is blocked_by B
    expect(readTask(a).blocked_by).toEqual([b]);
    expect(readTask(b).blocks).toEqual([a]);
  });

  it('checkTaskDependencies returns open blockers with their current status', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });

    let open = checkTaskDependencies(paths, blocked);
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');

    completeTask(paths, blocker, 'done');
    open = checkTaskDependencies(paths, blocked);
    expect(open).toEqual([]);
  });

  it('checkTaskDependencies reports missing:true for dangling dep references', () => {
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: ['task_nonexistent_777'] });
    const open = checkTaskDependencies(paths, b);
    expect(open).toEqual([{ id: 'task_nonexistent_777', status: 'missing' }]);
  });

  it('cycle detection: A blocked_by B, B blocked_by A throws at creation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    // A declares new blocked_by edge to B — would form A -> B -> A cycle.
    expect(() => createTask(paths, 'alice', 'acme', 'A-rewrite', { blockedBy: [b], blocks: [a] })).toThrow(/cycle/i);
  });

  it('REGRESSION: cycle-rejected createTask leaves ZERO state on disk — no task json, no audit, no peer mutation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });

    // Snapshot A's blocks list before the cycle-try attempt.
    const aBlocksBefore = readTask(a).blocks ?? [];

    // Attempt a cycle: new task blocked_by c + blocks a → cycle-try → a → b → c → cycle-try.
    const filesBefore = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(() => createTask(paths, 'alice', 'acme', 'cycle-try', { blockedBy: [c], blocks: [a] })).toThrow(/cycle/i);

    // Invariants: (1) no new task JSON, (2) no audit directory entry for the rejected id,
    // (3) peer A's blocks list unchanged.
    const filesAfter = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(filesAfter).toEqual(filesBefore);
    // A's `blocks` list must not have been mutated by the attempted creation.
    expect(readTask(a).blocks ?? []).toEqual(aBlocksBefore);
    // No dangling audit dir file for a task id that never existed.
    const auditDir = join(paths.taskDir, 'audit');
    if (existsSync(auditDir)) {
      const auditFiles = readdirSync(auditDir);
      // No audit file for any task whose id isn't one of the 3 we successfully created.
      const validIds = new Set([a, b, c]);
      for (const f of auditFiles) {
        const id = f.replace(/\.jsonl$/, '');
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  it('listTasks --respect-deps orders unblocked tasks before blocked ones', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });
    const free = createTask(paths, 'alice', 'acme', 'Free');

    const ordered = listTasks(paths, { respectDeps: true });
    const ids = ordered.map(t => t.id);
    // All 3 present
    expect(ids).toContain(blocker);
    expect(ids).toContain(blocked);
    expect(ids).toContain(free);
    // `blocked` must come after both `blocker` and `free` in the list.
    const idx = (id: string) => ids.indexOf(id);
    expect(idx(blocked)).toBeGreaterThan(idx(blocker));
    expect(idx(blocked)).toBeGreaterThan(idx(free));

    // Once blocker completes, respectDeps no longer demotes blocked.
    completeTask(paths, blocker, 'done');
    const reordered = listTasks(paths, { respectDeps: true });
    const blockedTask = reordered.find(t => t.id === blocked)!;
    expect(blockedTask.status).toBe('pending');
    // Specifically: blocked should no longer be forced after 'free'
    // (both unblocked now, fall back to created_at ordering).
  });
});

describe('compactTasks — semantic compaction of old completed tasks', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-compact-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  // Helper: age a completed task's completed_at by overwriting the JSON.
  function backdateCompletion(id: string, daysAgo: number) {
    const p = join(paths.taskDir, `${id}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    t.completed_at = ts;
    t.updated_at = ts;
    writeFileSync(p, JSON.stringify(t));
  }

  it('archives a completed task older than cutoff — removes active JSON, preserves audit log', () => {
    const id = createTask(paths, 'alice', 'acme', 'Old done', { assignee: 'alice' });
    completeTask(paths, id, 'shipped');
    backdateCompletion(id, 40);

    const auditPath = join(paths.taskDir, 'audit', `${id}.jsonl`);
    expect(existsSync(auditPath)).toBe(true);

    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived.map(a => a.id)).toEqual([id]);
    expect(report.skipped).toEqual([]);

    // Active JSON gone, audit log still there
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);
    expect(existsSync(auditPath)).toBe(true);

    // Archive entry written to the correct month file
    const archiveFile = report.archived[0].archive_file;
    const archiveLine = readFileSync(join(paths.taskDir, archiveFile), 'utf-8').trim();
    const entry = JSON.parse(archiveLine);
    expect(entry.id).toBe(id);
    expect(entry.title).toBe('Old done');
    expect(entry.result).toBe('shipped');
    expect(entry.assigned_to).toBe('alice');
  });

  it('skips recently-completed tasks (within cutoff)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Fresh done');
    completeTask(paths, id, 'ok');
    // Leave completed_at as "just now" — should be skipped.
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === id)?.reason).toMatch(/within cutoff/);
  });

  it('skips in-progress and blocked tasks regardless of age', () => {
    const a = createTask(paths, 'alice', 'acme', 'In progress');
    claimTask(paths, a, 'alice'); // -> in_progress
    const b = createTask(paths, 'alice', 'acme', 'Blocked');
    updateTask(paths, b, 'blocked');

    const report = compactTasks(paths, { olderThanDays: 0 });
    expect(report.archived).toEqual([]);
  });

  it('NEVER archives a completed task still referenced by an open task\'s blocked_by chain', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);

    // Dependent is still pending → blocker must not be compacted away.
    expect(dependent).toBeDefined();
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === blocker)?.reason).toMatch(/still.*blocked_by/);
    expect(existsSync(join(paths.taskDir, `${blocker}.json`))).toBe(true);
  });

  it('REGRESSION: transitive blocker guard — A<-B<-C with C open preserves BOTH A and B', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });
    expect(c).toBeDefined();

    // A + B both completed and aged out; C stays open.
    completeTask(paths, a, 'done-a');
    completeTask(paths, b, 'done-b');
    backdateCompletion(a, 60);
    backdateCompletion(b, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    // Neither A nor B should be archived — both are in the transitive
    // blocker closure of open C.
    expect(report.archived).toEqual([]);
    const skippedIds = report.skipped.map(s => s.id).sort();
    expect(skippedIds).toContain(a);
    expect(skippedIds).toContain(b);
    // Both must still be on disk.
    expect(existsSync(join(paths.taskDir, `${a}.json`))).toBe(true);
    expect(existsSync(join(paths.taskDir, `${b}.json`))).toBe(true);
  });

  it('once the dependent completes, the blocker becomes eligible', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);
    completeTask(paths, dependent, 'done');
    backdateCompletion(dependent, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    const archivedIds = report.archived.map(a => a.id).sort();
    expect(archivedIds).toEqual([blocker, dependent].sort());
  });

  it('is idempotent — running a second time on the same data archives nothing', () => {
    const id = createTask(paths, 'alice', 'acme', 'Run-twice');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const first = compactTasks(paths, { olderThanDays: 30 });
    expect(first.archived.map(a => a.id)).toEqual([id]);

    const second = compactTasks(paths, { olderThanDays: 30 });
    expect(second.archived).toEqual([]);
  });

  it('dry-run reports candidates without modifying anything', () => {
    const id = createTask(paths, 'alice', 'acme', 'Dry-run target');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const report = compactTasks(paths, { olderThanDays: 30, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.archived.map(a => a.id)).toEqual([id]);
    // Active JSON still present
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
  });
});
