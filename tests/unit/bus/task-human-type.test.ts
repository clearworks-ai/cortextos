// tests/unit/bus/task-human-type.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, isHumanExemptTask } from '../../../src/bus/task';
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
