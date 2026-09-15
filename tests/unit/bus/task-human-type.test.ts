// tests/unit/bus/task-human-type.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, isHumanExemptTask, claimTask, classifyTask, updateTask } from '../../../src/bus/task';
import type { BusPaths, Task } from '../../../src/types';

describe('createTask type option (G-BUS-1)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-type-test-'));
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

  const readTaskJson = (taskId: string): Task => (
    JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task
  );

  it('defaults to type "agent" when options.type is omitted', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Untyped task');
    expect(readTaskJson(taskId).type).toBe('agent');
  });

  it('persists type "human" on disk when options.type is "human"', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Human task', { type: 'human' });
    expect(readTaskJson(taskId).type).toBe('human');
  });

  it('isHumanExemptTask is true for a type:"human" task', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Human task', { type: 'human' });
    expect(isHumanExemptTask(readTaskJson(taskId))).toBe(true);
  });

  it('isHumanExemptTask is false for an ordinary agent task', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Ordinary task', { assignee: 'boris' });
    const onDisk = readTaskJson(taskId);
    expect(onDisk.type).toBe('agent');
    expect(isHumanExemptTask(onDisk)).toBe(false);
  });
});

describe('claimTask human-exempt guard (G-BUS-2)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-guard-test-'));
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

  const readTaskJson = (taskId: string): Task => (
    JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task
  );

  it('throws the exact human-exempt message and leaves the task pending with no claim file', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    expect(() => claimTask(paths, taskId, 'boris')).toThrow(
      `Task ${taskId} is human-exempt (type=human, assigned_to=human); pass --force-claim to promote it deliberately`,
    );
    const onDisk = readTaskJson(taskId);
    expect(onDisk.status).toBe('pending');
    expect(existsSync(join(paths.taskDir, '.claims', `${taskId}.claim`))).toBe(false);
  });

  it('promotes a human-exempt task to in_progress when { force: true } is passed', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    const task = claimTask(paths, taskId, 'boris', { force: true });
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('boris');
    expect(readTaskJson(taskId).status).toBe('in_progress');
  });

  it('leaves an ordinary agent task claimable exactly as before (regression)', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Ordinary task');
    const task = claimTask(paths, taskId, 'boris');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('boris');
  });
});

// --- G2a-3 (G-BUS-3): classifyTask honours type:'human' ----------------------
// `--type human` without `--assignee` left the owner as the invoking agent, and
// classifyTask ignored `type` entirely — so a type:human task classified as
// 'build': it got the build-class due date, was missing from
// `list-tasks --class human`, and could hit build-only completion checks.

describe('classifyTask type:"human" (G-BUS-3)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-classify-type-test-'));
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

  const readTaskJson = (taskId: string): Task => (
    JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task
  );

  it('classifies a type:"human" task as human even when assigned to an agent', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Review the renewal terms', {
      type: 'human',
      assignee: 'boris',
    });
    const onDisk = readTaskJson(taskId);
    expect(onDisk.type).toBe('human');
    expect(onDisk.assigned_to).toBe('boris');
    expect(classifyTask(onDisk)).toBe('human');
  });

  it('still classifies an ordinary agent task as build (regression)', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Review the renewal terms', { assignee: 'boris' });
    expect(classifyTask(readTaskJson(taskId))).toBe('build');
  });

  it('still classifies a cron: task as system, type notwithstanding', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'cron: rotate logs', { type: 'human', assignee: 'boris' });
    expect(classifyTask(readTaskJson(taskId))).toBe('system');
  });
});

// --- G2r2-4 (G2B-7 / G2A-4): guard placement + the human claimant -----------

describe('claimTask human-exempt guard placement (G-BUS-2)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-order-test-'));
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

  const readTaskJson = (taskId: string): Task => (
    JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8')) as Task
  );

  it("lets Multica's claimTask(paths, id, 'human') through without force", () => {
    // src/bus/multica/poll.ts:175 assigns a pending human task to Josh with
    // exactly this call. The claimant IS the human, so the barrier does not apply.
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    const task = claimTask(paths, taskId, 'human');
    expect(task.status).toBe('in_progress');
    expect(readTaskJson(taskId).status).toBe('in_progress');
    expect(readTaskJson(taskId).assigned_to).toBe('human');
  });

  it("lets the 'user' claimant through without force", () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    expect(claimTask(paths, taskId, 'user').status).toBe('in_progress');
  });

  it('refuses an agent re-claim through the existing same-owner claim file', () => {
    // G2B-7: force-claim as boris, reset to pending (update-task permits it,
    // leaving the .claim file), then claim again with no force. The same-owner
    // idempotency branch used to return success before the barrier ran.
    const taskId = createTask(paths, 'paul', 'acme', 'Decide pricing', { type: 'human', assignee: 'human' });
    claimTask(paths, taskId, 'boris', { force: true });
    updateTask(paths, taskId, 'pending');
    expect(existsSync(join(paths.taskDir, '.claims', `${taskId}.claim`))).toBe(true);

    expect(() => claimTask(paths, taskId, 'boris')).toThrow(/is human-exempt/);
    expect(readTaskJson(taskId).status).toBe('pending');
  });

  it('still lets an ordinary agent re-claim its own task idempotently (regression)', () => {
    const taskId = createTask(paths, 'paul', 'acme', 'Ordinary task');
    claimTask(paths, taskId, 'boris');
    updateTask(paths, taskId, 'pending');
    expect(claimTask(paths, taskId, 'boris').id).toBe(taskId);
  });
});
