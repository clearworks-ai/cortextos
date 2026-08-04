import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sweepSignals, deliverSignalActions } from '../../../src/bus/signal-sweep';
import { listTasks } from '../../../src/bus/task';
import type { BusPaths, Task } from '../../../src/types';

const DAY = 86_400_000;
const NOW = new Date('2026-08-03T00:00:00Z');
const NOW_MS = NOW.getTime();

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('signal-sweep', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'signal-sweep-test-'));
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
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.taskDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
    const now = overrides.created_at ?? iso(NOW_MS);
    const task: Task = {
      id: overrides.id,
      title: overrides.title,
      description: overrides.description ?? '',
      type: overrides.type ?? 'agent',
      needs_approval: overrides.needs_approval ?? false,
      status: overrides.status ?? 'pending',
      assigned_to: overrides.assigned_to ?? 'larry',
      created_by: overrides.created_by ?? 'larry',
      org: overrides.org ?? 'acme',
      priority: overrides.priority ?? 'normal',
      project: overrides.project ?? 'larry',
      kpi_key: overrides.kpi_key ?? null,
      created_at: now,
      updated_at: overrides.updated_at ?? now,
      completed_at: overrides.completed_at ?? null,
      due_date: overrides.due_date ?? null,
      archived: overrides.archived ?? false,
    };
    writeFileSync(join(paths.taskDir, `${task.id}.json`), JSON.stringify(task));
    return task;
  }

  function writeCrm(engagements: unknown[], contacts: unknown[]): { contactsPath: string; pipelinePath: string } {
    const contactsPath = join(testDir, 'contacts.json');
    const pipelinePath = join(testDir, 'pipeline.json');
    writeFileSync(pipelinePath, JSON.stringify({ engagements }));
    writeFileSync(contactsPath, JSON.stringify({ contacts }));
    return { contactsPath, pipelinePath };
  }

  // ── (a) blocker ─────────────────────────────────────────────────────────────
  it('(a) fires for a blocked source aged exactly blockerDays behind an open escalation', () => {
    makeTask({ id: 'task_src_1', title: 'Stuck build', status: 'blocked', created_at: iso(NOW_MS - 5 * DAY) });
    makeTask({ id: 'task_esc_1', title: '[HUMAN] Escalated: Stuck build — nudged 3x (id: task_src_1)', assigned_to: 'human' });

    const report = sweepSignals(paths, { now: NOW });
    const blockers = report.actions.filter((a) => a.signal === 'blocker');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].entity_id).toBe('task_src_1');
    expect(blockers[0].days).toBe(5);
    expect(blockers[0].detail.escalation_task_id).toBe('task_esc_1');
  });

  it('(a) does not fire when the source is younger than blockerDays', () => {
    makeTask({ id: 'task_src_2', title: 'Recent', status: 'blocked', created_at: iso(NOW_MS - (5 * DAY - 3_600_000)) });
    makeTask({ id: 'task_esc_2', title: '[HUMAN] Escalated: Recent (id: task_src_2)', assigned_to: 'human' });
    expect(sweepSignals(paths, { now: NOW }).actions.filter((a) => a.signal === 'blocker')).toHaveLength(0);
  });

  it('(a) does not fire when the (id: X) source is completed or missing', () => {
    makeTask({ id: 'task_src_3', title: 'Done src', status: 'completed', created_at: iso(NOW_MS - 10 * DAY) });
    makeTask({ id: 'task_esc_3', title: '[HUMAN] Escalated: Done src (id: task_src_3)', assigned_to: 'human' });
    makeTask({ id: 'task_esc_4', title: '[HUMAN] Escalated: Ghost (id: task_missing_999)', assigned_to: 'human' });
    expect(sweepSignals(paths, { now: NOW }).actions.filter((a) => a.signal === 'blocker')).toHaveLength(0);
  });

  it('(a) dedupes multiple escalation rows pointing at the same source', () => {
    makeTask({ id: 'task_src_5', title: 'One source', status: 'blocked', created_at: iso(NOW_MS - 6 * DAY) });
    makeTask({ id: 'task_esc_5a', title: '[HUMAN] Escalated: One source (id: task_src_5)', assigned_to: 'human' });
    makeTask({ id: 'task_esc_5b', title: '[HUMAN] Escalated: One source again (id: task_src_5)', assigned_to: 'human' });
    expect(sweepSignals(paths, { now: NOW }).actions.filter((a) => a.signal === 'blocker')).toHaveLength(1);
  });

  // ── (b) milestone ───────────────────────────────────────────────────────────
  it('(b) fires for due-today (days 0) and due-in-7d, not 8d or overdue', () => {
    makeTask({ id: 'task_ms_today', title: 'Due today', due_date: iso(NOW_MS) });
    makeTask({ id: 'task_ms_7', title: 'Due in a week', due_date: iso(NOW_MS + 7 * DAY) });
    makeTask({ id: 'task_ms_8', title: 'Due in 8d', due_date: iso(NOW_MS + 8 * DAY) });
    makeTask({ id: 'task_ms_over', title: 'Overdue', due_date: iso(NOW_MS - DAY) });

    const report = sweepSignals(paths, { now: NOW });
    const ms = report.actions.filter((a) => a.signal === 'milestone');
    const ids = ms.map((a) => a.entity_id).sort();
    expect(ids).toEqual(['task_ms_7', 'task_ms_today']);
    expect(ms.find((a) => a.entity_id === 'task_ms_today')?.days).toBe(0);
  });

  it('(b) excludes system-class and signal-marked tasks', () => {
    makeTask({ id: 'task_ms_cron', title: 'Cron: nightly', due_date: iso(NOW_MS + DAY) });
    makeTask({ id: 'task_ms_sys', title: 'System job', project: 'system', due_date: iso(NOW_MS + DAY) });
    makeTask({ id: 'task_ms_sig', title: 'Already surfaced (signal: milestone:x)', due_date: iso(NOW_MS + DAY) });
    expect(sweepSignals(paths, { now: NOW }).actions.filter((a) => a.signal === 'milestone')).toHaveLength(0);
  });

  // ── (c) quiet ───────────────────────────────────────────────────────────────
  it('(c) fires for a won-stage engagement quiet 15d, not 13d, and honors max(last_touch)', () => {
    const { contactsPath, pipelinePath } = writeCrm(
      [
        { id: 'eng-quiet', name: 'Acme Corp', stage: 'won', last_signal_at: iso(NOW_MS - 15 * DAY), contact_ids: ['c1'] },
        { id: 'eng-fresh', name: 'Beta LLC', stage: 'active_client', last_signal_at: iso(NOW_MS - 13 * DAY), contact_ids: [] },
        { id: 'eng-lost', name: 'Gamma', stage: 'lost', last_signal_at: iso(NOW_MS - 40 * DAY), contact_ids: [] },
        { id: 'eng-maxc', name: 'Delta', stage: 'won', last_signal_at: iso(NOW_MS - 40 * DAY), contact_ids: ['c2'] },
      ],
      [
        { id: 'c1', last_meaningful_contact: iso(NOW_MS - 20 * DAY) },
        { id: 'c2', last_meaningful_contact: iso(NOW_MS - 2 * DAY) }, // newer than eng-maxc signal → suppresses
      ],
    );

    const report = sweepSignals(paths, { now: NOW, crmContactsPath: contactsPath, crmPipelinePath: pipelinePath });
    expect(report.crm_loaded).toBe(true);
    const quiet = report.actions.filter((a) => a.signal === 'quiet');
    expect(quiet.map((a) => a.entity_id)).toEqual(['eng-quiet']);
    expect(quiet[0].days).toBe(15);
  });

  it('(c) skips an engagement with zero parseable dates without throwing', () => {
    const { contactsPath, pipelinePath } = writeCrm(
      [{ id: 'eng-nodate', name: 'No Dates', stage: 'won', last_signal_at: null, contact_ids: ['cx'] }],
      [{ id: 'cx', last_meaningful_contact: null }],
    );
    const report = sweepSignals(paths, { now: NOW, crmContactsPath: contactsPath, crmPipelinePath: pipelinePath });
    expect(report.crm_loaded).toBe(true);
    expect(report.actions.filter((a) => a.signal === 'quiet')).toHaveLength(0);
  });

  // ── (c) absent-CRM guard ────────────────────────────────────────────────────
  it('(c) is skipped (crm_loaded false) with no paths, missing files, or malformed JSON — never throws', () => {
    makeTask({ id: 'task_ms_x', title: 'Due soon', due_date: iso(NOW_MS + DAY) }); // other signals still run

    const noPaths = sweepSignals(paths, { now: NOW });
    expect(noPaths.crm_loaded).toBe(false);
    expect(noPaths.actions.filter((a) => a.signal === 'quiet')).toHaveLength(0);
    expect(noPaths.actions.some((a) => a.signal === 'milestone')).toBe(true);

    const missing = sweepSignals(paths, { now: NOW, crmContactsPath: join(testDir, 'nope1.json'), crmPipelinePath: join(testDir, 'nope2.json') });
    expect(missing.crm_loaded).toBe(false);

    const badContacts = join(testDir, 'bad.json');
    const goodPipeline = join(testDir, 'p.json');
    writeFileSync(badContacts, '{not json');
    writeFileSync(goodPipeline, JSON.stringify({ engagements: [] }));
    const malformed = sweepSignals(paths, { now: NOW, crmContactsPath: badContacts, crmPipelinePath: goodPipeline });
    expect(malformed.crm_loaded).toBe(false);
  });

  // ── idempotency ─────────────────────────────────────────────────────────────
  it('idempotency: delivered signals are excluded on the next sweep and re-delivery creates nothing', () => {
    makeTask({ id: 'task_ms_idem', title: 'Milestone once', due_date: iso(NOW_MS + DAY) });

    const first = sweepSignals(paths, { now: NOW });
    expect(first.actions).toHaveLength(1);
    const delivery = deliverSignalActions(first.actions, { instanceId: 'default', org: 'acme', fromAgent: 'codexer', paths });
    expect(delivery.created).toHaveLength(1);

    const second = sweepSignals(paths, { now: NOW });
    expect(second.actions.filter((a) => a.entity_id === 'task_ms_idem')).toHaveLength(0);
    expect(second.skipped.some((s) => s.entity_id === 'task_ms_idem' && s.reason === 'already_open')).toBe(true);

    // Re-delivering the stale first-run actions creates zero new tasks (just-in-time re-check).
    const redeliver = deliverSignalActions(first.actions, { instanceId: 'default', org: 'acme', fromAgent: 'codexer', paths });
    expect(redeliver.created).toEqual([]);
    expect(redeliver.skipped).toContain('task_ms_idem');
  });

  // ── cap ─────────────────────────────────────────────────────────────────────
  it('cap: maxActions=1 with 2 firing entities yields 1 action + 1 capped skip', () => {
    makeTask({ id: 'task_ms_c1', title: 'M1', due_date: iso(NOW_MS + DAY) });
    makeTask({ id: 'task_ms_c2', title: 'M2', due_date: iso(NOW_MS + 2 * DAY) });

    const report = sweepSignals(paths, { now: NOW, maxActions: 1 });
    expect(report.actions).toHaveLength(1);
    expect(report.skipped.filter((s) => s.reason === 'capped')).toHaveLength(1);
  });

  // ── dry-run purity ──────────────────────────────────────────────────────────
  it('dry-run purity: sweepSignals writes nothing to the task dir', () => {
    makeTask({ id: 'task_src_p', title: 'Blocked', status: 'blocked', created_at: iso(NOW_MS - 6 * DAY) });
    makeTask({ id: 'task_esc_p', title: '[HUMAN] Escalated: Blocked (id: task_src_p)', assigned_to: 'human' });
    makeTask({ id: 'task_ms_p', title: 'Due soon', due_date: iso(NOW_MS + DAY) });

    const before = readdirSync(paths.taskDir).sort().map((f) => [f, readFileSync(join(paths.taskDir, f), 'utf-8')]);
    const report = sweepSignals(paths, { now: NOW });
    expect(report.actions.length).toBeGreaterThan(0); // candidates present
    const after = readdirSync(paths.taskDir).sort().map((f) => [f, readFileSync(join(paths.taskDir, f), 'utf-8')]);
    expect(after).toEqual(before);
    expect(listTasks(paths).length).toBe(3);
  });
});
