// tests/unit/bus/task-human-type.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, isHumanExemptTask, claimTask } from '../../../src/bus/task';
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
