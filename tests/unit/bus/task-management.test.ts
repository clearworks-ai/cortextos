import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, checkStaleTasks, archiveTasks, checkHumanTasks, sweepSilentAssignees } from '../../../src/bus/task';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { BusPaths, Task, Heartbeat } from '../../../src/types';

/**
 * Helper to create a task with a backdated timestamp.
 * Writes a task JSON directly with manipulated dates.
 */
function createBackdatedTask(
  paths: BusPaths,
  overrides: Partial<Task> & { id: string },
): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const task: Task = {
    id: overrides.id,
    title: overrides.title ?? 'Test task',
    description: overrides.description ?? '',
    type: overrides.type ?? 'agent',
    needs_approval: overrides.needs_approval ?? false,
    status: overrides.status ?? 'pending',
    assigned_to: overrides.assigned_to ?? 'agent1',
    created_by: overrides.created_by ?? 'agent1',
    org: overrides.org ?? 'testorg',
    priority: overrides.priority ?? 'normal',
    project: overrides.project ?? '',
    kpi_key: overrides.kpi_key ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    completed_at: overrides.completed_at ?? null,
    due_date: overrides.due_date ?? null,
    archived: overrides.archived ?? false,
  };
  atomicWriteSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
}

function hoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function daysAgo(days: number): string {
  return hoursAgo(days * 24);
}

describe('Advanced Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-taskmgmt-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agent1'),
      inflight: join(testDir, 'inflight', 'agent1'),
      processed: join(testDir, 'processed', 'agent1'),
      logDir: join(testDir, 'logs', 'agent1'),
      stateDir: join(testDir, 'state', 'agent1'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('checkStaleTasks', () => {
    it('identifies stale in_progress tasks (>2h)', () => {
      createBackdatedTask(paths, {
        id: 'task_001_001',
        title: 'Stale in progress',
        status: 'in_progress',
        updated_at: hoursAgo(3), // 3 hours ago
        created_at: hoursAgo(5),
      });
      createBackdatedTask(paths, {
        id: 'task_002_002',
        title: 'Fresh in progress',
        status: 'in_progress',
        updated_at: hoursAgo(1), // 1 hour ago
        created_at: hoursAgo(1),
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.length).toBe(1);
      expect(report.stale_in_progress[0].id).toBe('task_001_001');
    });

    it('identifies stale pending tasks (>24h)', () => {
      createBackdatedTask(paths, {
        id: 'task_003_003',
        title: 'Stale pending',
        status: 'pending',
        created_at: hoursAgo(25), // 25 hours ago
        updated_at: hoursAgo(25),
      });
      createBackdatedTask(paths, {
        id: 'task_004_004',
        title: 'Fresh pending',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_pending.length).toBe(1);
      expect(report.stale_pending[0].id).toBe('task_003_003');
    });

    it('identifies overdue tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_005_005',
        title: 'Overdue task',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
        due_date: daysAgo(1), // due yesterday
      });
      createBackdatedTask(paths, {
        id: 'task_006_006',
        title: 'Future task',
        status: 'pending',
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1),
        due_date: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), // due tomorrow
      });

      const report = checkStaleTasks(paths);
      expect(report.overdue.length).toBe(1);
      expect(report.overdue[0].id).toBe('task_005_005');
    });

    it('skips completed tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_007_007',
        title: 'Done task',
        status: 'completed',
        created_at: hoursAgo(48),
        updated_at: hoursAgo(48),
        completed_at: hoursAgo(48),
        due_date: daysAgo(1), // overdue but completed
      });

      const report = checkStaleTasks(paths);
      expect(report.stale_in_progress.length).toBe(0);
      expect(report.stale_pending.length).toBe(0);
      expect(report.stale_human.length).toBe(0);
      expect(report.overdue.length).toBe(0);
    });
  });

  describe('archiveTasks', () => {
    it('moves old completed tasks to archive/', () => {
      createBackdatedTask(paths, {
        id: 'task_010_010',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8), // completed 8 days ago, > 7 day threshold
      });

      const report = archiveTasks(paths);
      expect(report.archived).toBe(1);
      expect(report.dry_run).toBe(false);

      // File should be moved to archive/
      expect(existsSync(join(paths.taskDir, 'task_010_010.json'))).toBe(false);
      expect(existsSync(join(paths.taskDir, 'archive', 'task_010_010.json'))).toBe(true);
    });

    it('dry-run does not modify files', () => {
      createBackdatedTask(paths, {
        id: 'task_011_011',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8),
      });

      const report = archiveTasks(paths, true);
      expect(report.archived).toBe(1);
      expect(report.dry_run).toBe(true);

      // File should still be in original location
      expect(existsSync(join(paths.taskDir, 'task_011_011.json'))).toBe(true);
      expect(existsSync(join(paths.taskDir, 'archive'))).toBe(false);
    });

    it('prunes legacy task .json.bak files (orphaned and live) and reports the count', () => {
      createBackdatedTask(paths, { id: 'task_020_020', title: 'Live task' });
      // Legacy .bak next to a live task + an orphaned .bak whose task is gone.
      atomicWriteSync(join(paths.taskDir, 'task_020_020.json.bak'), '{}');
      atomicWriteSync(join(paths.taskDir, 'task_099_099.json.bak'), '{}');
      // Non-task files must be untouched.
      atomicWriteSync(join(paths.taskDir, 'archive-2026-07.jsonl'), '');

      const report = archiveTasks(paths);
      expect(report.pruned_bak).toBe(2);
      expect(existsSync(join(paths.taskDir, 'task_020_020.json.bak'))).toBe(false);
      expect(existsSync(join(paths.taskDir, 'task_099_099.json.bak'))).toBe(false);
      expect(existsSync(join(paths.taskDir, 'task_020_020.json'))).toBe(true);
      expect(existsSync(join(paths.taskDir, 'archive-2026-07.jsonl'))).toBe(true);
    });

    it('dry-run counts prunable .bak files without deleting them', () => {
      atomicWriteSync(join(paths.taskDir, 'task_098_098.json.bak'), '{}');

      const report = archiveTasks(paths, true);
      expect(report.pruned_bak).toBe(1);
      expect(existsSync(join(paths.taskDir, 'task_098_098.json.bak'))).toBe(true);
    });

    it('task writes no longer produce .json.bak files', () => {
      const id = createTask(paths, 'agent1', 'testorg', 'No-bak task');
      updateTask(paths, id, { status: 'in_progress' }, 'agent1');
      completeTask(paths, id, 'completed in archive test');

      const baks = readdirSync(paths.taskDir).filter(f => f.endsWith('.json.bak'));
      expect(baks).toEqual([]);
    });

    it('adds archived:true field', () => {
      createBackdatedTask(paths, {
        id: 'task_012_012',
        title: 'Old done task',
        status: 'completed',
        created_at: daysAgo(10),
        updated_at: daysAgo(8),
        completed_at: daysAgo(8),
      });

      archiveTasks(paths);

      const archivedContent = readFileSync(
        join(paths.taskDir, 'archive', 'task_012_012.json'),
        'utf-8',
      );
      const task = JSON.parse(archivedContent);
      expect(task.archived).toBe(true);
    });
  });

  describe('checkHumanTasks', () => {
    it('finds human-assigned stale tasks', () => {
      createBackdatedTask(paths, {
        id: 'task_020_020',
        title: 'Human task old',
        status: 'pending',
        assigned_to: 'human',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });
      createBackdatedTask(paths, {
        id: 'task_021_021',
        title: 'User task old',
        status: 'in_progress',
        assigned_to: 'user',
        created_at: hoursAgo(30),
        updated_at: hoursAgo(30),
      });
      createBackdatedTask(paths, {
        id: 'task_022_022',
        title: 'Human task fresh',
        status: 'pending',
        assigned_to: 'human',
        created_at: hoursAgo(1), // only 1 hour old
        updated_at: hoursAgo(1),
      });
      createBackdatedTask(paths, {
        id: 'task_023_023',
        title: 'Agent task old',
        status: 'pending',
        assigned_to: 'agent1',
        created_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      });

      const humanTasks = checkHumanTasks(paths);
      expect(humanTasks.length).toBe(2);
      const ids = humanTasks.map(t => t.id).sort();
      expect(ids).toEqual(['task_020_020', 'task_021_021']);
    });
  });

  describe('sweepSilentAssignees', () => {
    function makeHeartbeat(agent: string, lastHeartbeat: string): Heartbeat {
      return {
        agent,
        org: 'testorg',
        status: 'running',
        current_task: '',
        mode: 'day',
        last_heartbeat: lastHeartbeat,
        loop_interval: '15m',
      };
    }

    function readTask(id: string): Task {
      return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8')) as Task;
    }

    it('flags an open task whose assignee heartbeat is older than threshold', () => {
      createBackdatedTask(paths, { id: 'task_s1', assigned_to: 'boris', status: 'in_progress' });
      const report = sweepSilentAssignees(paths, {
        heartbeats: [makeHeartbeat('boris', hoursAgo(3))],
      });
      expect(report.actions).toHaveLength(1);
      expect(report.actions[0].id).toBe('task_s1');
      expect(report.actions[0].reason).toBe('silent_assignee');
      expect(report.actions[0].heartbeat_age_ms).toBeGreaterThan(2.9 * 3_600_000);
      expect(report.actions[0].heartbeat_age_ms).toBeLessThan(3.1 * 3_600_000);
    });

    it('does not flag a fresh heartbeat (1h < 2h threshold)', () => {
      createBackdatedTask(paths, { id: 'task_s2', assigned_to: 'boris' });
      const report = sweepSilentAssignees(paths, {
        heartbeats: [makeHeartbeat('boris', hoursAgo(1))],
      });
      expect(report.actions).toEqual([]);
    });

    it('flags with null age when the assignee has no heartbeat entry at all', () => {
      createBackdatedTask(paths, { id: 'task_s3', assigned_to: 'boris' });
      const report = sweepSilentAssignees(paths, { heartbeats: [] });
      expect(report.actions).toHaveLength(1);
      expect(report.actions[0].heartbeat_age_ms).toBeNull();
    });

    it('does not flag human-exempt tasks even with no heartbeat', () => {
      createBackdatedTask(paths, { id: 'task_s4', assigned_to: 'human' });
      const report = sweepSilentAssignees(paths, { heartbeats: [] });
      expect(report.actions).toEqual([]);
    });

    it('does not flag ephemeral worker assignees', () => {
      createBackdatedTask(paths, { id: 'task_s5', assigned_to: 'worker-1234567890123' });
      const report = sweepSilentAssignees(paths, { heartbeats: [] });
      expect(report.actions).toEqual([]);
    });

    it('does not scan completed / cancelled / archived tasks', () => {
      createBackdatedTask(paths, { id: 'task_s6a', assigned_to: 'boris', status: 'completed' });
      createBackdatedTask(paths, { id: 'task_s6b', assigned_to: 'boris', status: 'cancelled' });
      createBackdatedTask(paths, { id: 'task_s6c', assigned_to: 'boris', archived: true });
      const report = sweepSilentAssignees(paths, { heartbeats: [] });
      expect(report.actions).toEqual([]);
    });

    it('flags a fresh, not-yet-due task with a stale-heartbeat assignee (distinct from staleness)', () => {
      // Default createBackdatedTask: created/updated now, due_date null → sweepDueTasks
      // would never touch it. The silent sweep still must.
      createBackdatedTask(paths, { id: 'task_s7', assigned_to: 'boris' });
      const report = sweepSilentAssignees(paths, {
        heartbeats: [makeHeartbeat('boris', hoursAgo(5))],
      });
      expect(report.actions).toHaveLength(1);
      expect(report.actions[0].id).toBe('task_s7');
    });

    it('apply stamps silent_flagged_at, cools down an immediate re-run, re-flags after 24h', () => {
      createBackdatedTask(paths, { id: 'task_s8', assigned_to: 'boris' });
      const t0 = new Date();

      const first = sweepSilentAssignees(paths, {
        dryRun: false,
        now: t0,
        heartbeats: [makeHeartbeat('boris', hoursAgo(3))],
      });
      expect(first.actions).toHaveLength(1);
      expect(readTask('task_s8').silent_flagged_at).toBeTruthy();

      const second = sweepSilentAssignees(paths, {
        dryRun: false,
        now: t0,
        heartbeats: [makeHeartbeat('boris', hoursAgo(3))],
      });
      expect(second.actions).toEqual([]);
      expect(second.skipped_recent_flag).toBe(1);

      const later = new Date(t0.getTime() + 25 * 3_600_000);
      const third = sweepSilentAssignees(paths, {
        dryRun: false,
        now: later,
        heartbeats: [makeHeartbeat('boris', hoursAgo(3))],
      });
      expect(third.actions).toHaveLength(1);
    });

    it('dry-run (default) leaves the task file byte-identical', () => {
      createBackdatedTask(paths, { id: 'task_s9', assigned_to: 'boris' });
      const before = readFileSync(join(paths.taskDir, 'task_s9.json'), 'utf-8');
      const report = sweepSilentAssignees(paths, {
        heartbeats: [makeHeartbeat('boris', hoursAgo(3))],
      });
      expect(report.actions).toHaveLength(1);
      expect(readFileSync(join(paths.taskDir, 'task_s9.json'), 'utf-8')).toBe(before);
      expect(readTask('task_s9').silent_flagged_at).toBeUndefined();
    });

    it('default wiring reads real state/<agent>/heartbeat.json (fresh skips, stale flags)', () => {
      createBackdatedTask(paths, { id: 'task_s10', assigned_to: 'boris' });
      const hbDir = join(paths.ctxRoot, 'state', 'boris');
      mkdirSync(hbDir, { recursive: true });

      writeFileSync(join(hbDir, 'heartbeat.json'), JSON.stringify(makeHeartbeat('boris', hoursAgo(1))));
      expect(sweepSilentAssignees(paths, {}).actions).toEqual([]);

      writeFileSync(join(hbDir, 'heartbeat.json'), JSON.stringify(makeHeartbeat('boris', hoursAgo(3))));
      expect(sweepSilentAssignees(paths, {}).actions).toHaveLength(1);
    });

    it('skips system-class tasks', () => {
      createBackdatedTask(paths, { id: 'task_s11', assigned_to: 'boris', project: 'system' });
      const report = sweepSilentAssignees(paths, { heartbeats: [] });
      expect(report.actions).toEqual([]);
    });
  });
});
