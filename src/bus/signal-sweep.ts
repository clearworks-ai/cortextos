import { readFileSync } from 'fs';
import type { BusPaths, Task } from '../types/index.js';
import {
  createTask,
  listTasks,
  classifyTask,
  OPEN_TASK_STATUSES,
  DEFAULT_SWEEP_MAX_ACTIONS,
} from './task.js';

const DAY_MS = 86_400_000;

export type SignalKind = 'blocker' | 'milestone' | 'quiet';

export interface SignalAction {
  signal: SignalKind;
  entity_id: string;
  title: string;
  days: number;
  detail: Record<string, string | number | null>;
}

export interface SignalSweepReport {
  dry_run: boolean;
  scanned_tasks: number;
  crm_loaded: boolean;
  actions: SignalAction[];
  skipped: { signal: SignalKind; entity_id: string; reason: 'already_open' | 'capped' }[];
  counts: { blocker: number; milestone: number; quiet: number };
}

export interface SignalSweepOptions {
  dryRun?: boolean;
  now?: Date;
  maxActions?: number;
  blockerDays?: number;
  milestoneDays?: number;
  quietDays?: number;
  crmContactsPath?: string | null;
  crmPipelinePath?: string | null;
}

export interface SignalDelivery {
  created: string[];
  skipped: string[];
  failed: { entity_id: string; error: string }[];
}

function parseIsoEpoch(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** Clone of the due-sweep already-open marker check, new signal marker namespace. */
function hasOpenSignalMarker(tasks: Task[], kind: SignalKind, entityId: string): boolean {
  const marker = `(signal: ${kind}:${entityId})`;
  return tasks.some(
    (t) => OPEN_TASK_STATUSES.has(t.status) && !t.archived && t.title.includes(marker),
  );
}

interface LoadedCrm {
  engagements: Record<string, unknown>[];
  contactsById: Map<string, Record<string, unknown>>;
}

/**
 * Org-agnostic CRM load: returns null (→ crm_loaded=false) when paths are absent,
 * a file is missing/unreadable, JSON is unparseable, or the shape is neither a
 * wrapped object nor a bare array. Never throws; never hardcodes org paths.
 */
function loadCrm(contactsPath?: string | null, pipelinePath?: string | null): LoadedCrm | null {
  if (!contactsPath || !pipelinePath) return null;
  try {
    const pipelineRaw = JSON.parse(readFileSync(pipelinePath, 'utf-8')) as unknown;
    const contactsRaw = JSON.parse(readFileSync(contactsPath, 'utf-8')) as unknown;

    const engList = extractArray(pipelineRaw, 'engagements');
    const contactList = extractArray(contactsRaw, 'contacts');
    if (engList === null || contactList === null) return null;

    const contactsById = new Map<string, Record<string, unknown>>();
    for (const c of contactList) {
      if (c && typeof c === 'object') {
        const rec = c as Record<string, unknown>;
        if (rec.id !== undefined && rec.id !== null) contactsById.set(String(rec.id), rec);
      }
    }
    return { engagements: engList, contactsById };
  } catch {
    return null;
  }
}

function extractArray(raw: unknown, key: string): Record<string, unknown>[] | null {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const inner = (raw as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return null;
}

/**
 * Read-only 3-signal detector (P4.4): blocked ≥N days with an unsent escalation (a),
 * milestone due within N days (b), client quiet ≥N days (c). Stamps nothing on task
 * files — delivery (deliverSignalActions) creates the surfacing tasks and takes its
 * own lock. Idempotent + capped in scan order a→b→c.
 */
export function sweepSignals(paths: BusPaths, opts: SignalSweepOptions = {}): SignalSweepReport {
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? new Date();
  const nowEpoch = now.getTime();
  const maxActions = Number.isInteger(opts.maxActions) && (opts.maxActions ?? 0) > 0
    ? (opts.maxActions as number)
    : DEFAULT_SWEEP_MAX_ACTIONS;
  const blockerDays = opts.blockerDays ?? 5;
  const milestoneDays = opts.milestoneDays ?? 7;
  const quietDays = opts.quietDays ?? 14;

  const tasks = listTasks(paths);
  const tasksById = new Map<string, Task>(tasks.map((t) => [t.id, t]));

  const report: SignalSweepReport = {
    dry_run: dryRun,
    scanned_tasks: tasks.length,
    crm_loaded: false,
    actions: [],
    skipped: [],
    counts: { blocker: 0, milestone: 0, quiet: 0 },
  };

  const tryPush = (action: SignalAction): void => {
    if (hasOpenSignalMarker(tasks, action.signal, action.entity_id)) {
      report.skipped.push({ signal: action.signal, entity_id: action.entity_id, reason: 'already_open' });
      return;
    }
    if (report.actions.length >= maxActions) {
      report.skipped.push({ signal: action.signal, entity_id: action.entity_id, reason: 'capped' });
      return;
    }
    report.actions.push(action);
    report.counts[action.signal] += 1;
  };

  // (a) blocker — an open [HUMAN] Escalated: row whose (id: X) source is open + aged.
  const firedBlockers = new Set<string>();
  for (const t of tasks) {
    if (!OPEN_TASK_STATUSES.has(t.status) || t.archived) continue;
    if (!t.title.startsWith('[HUMAN] Escalated:')) continue;
    const match = t.title.match(/\(id: ([^),]+)/);
    if (!match) continue;
    const xid = match[1];
    if (firedBlockers.has(xid)) continue;
    const x = tasksById.get(xid);
    if (!x || !OPEN_TASK_STATUSES.has(x.status) || x.archived) continue;
    const createdEpoch = parseIsoEpoch(x.created_at);
    if (createdEpoch === null) continue;
    const ageMs = nowEpoch - createdEpoch;
    if (ageMs < blockerDays * DAY_MS) continue;
    firedBlockers.add(xid);
    tryPush({
      signal: 'blocker',
      entity_id: xid,
      title: x.title,
      days: Math.floor(ageMs / DAY_MS),
      detail: { assigned_to: x.assigned_to, due_date: x.due_date ?? null, escalation_task_id: t.id },
    });
  }

  // (b) milestone — open task due within the look-ahead window (not overdue, not system).
  for (const t of tasks) {
    if (!OPEN_TASK_STATUSES.has(t.status) || t.archived) continue;
    const dueEpoch = parseIsoEpoch(t.due_date);
    if (dueEpoch === null) continue;
    if (dueEpoch < nowEpoch || dueEpoch > nowEpoch + milestoneDays * DAY_MS) continue;
    if (classifyTask(t) === 'system') continue;
    if (t.title.includes('(signal: ') || t.title.startsWith('[HUMAN] Escalated:')) continue;
    tryPush({
      signal: 'milestone',
      entity_id: t.id,
      title: t.title,
      days: Math.floor((dueEpoch - nowEpoch) / DAY_MS),
      detail: { due_date: t.due_date ?? null, assigned_to: t.assigned_to, project: t.project },
    });
  }

  // (c) quiet — active-client engagement with no touch for ≥ quietDays. Guarded on CRM load.
  const crm = loadCrm(opts.crmContactsPath, opts.crmPipelinePath);
  if (crm) {
    report.crm_loaded = true;
    for (const eng of crm.engagements) {
      const stage = String(eng.stage ?? '').toLowerCase();
      if (stage !== 'won' && stage !== 'active_client') continue;
      const status = eng.status !== undefined && eng.status !== null ? String(eng.status).toLowerCase() : '';
      if (status === 'dormant' || status === 'dead') continue;

      const dates: number[] = [];
      const sig = parseIsoEpoch(eng.last_signal_at);
      if (sig !== null) dates.push(sig);
      const contactIds = Array.isArray(eng.contact_ids) ? eng.contact_ids : [];
      for (const cid of contactIds) {
        const contact = crm.contactsById.get(String(cid));
        if (!contact) continue;
        const lc = parseIsoEpoch(contact.last_meaningful_contact);
        if (lc !== null) dates.push(lc);
      }
      if (dates.length === 0) continue;

      const lastTouch = Math.max(...dates);
      const quietMs = nowEpoch - lastTouch;
      if (quietMs < quietDays * DAY_MS) continue;

      const entityId = firstNonEmpty(eng.id, eng.client_org, eng.name);
      if (!entityId) continue;
      const title = firstNonEmpty(eng.name, eng.client_org, eng.id) ?? entityId;
      tryPush({
        signal: 'quiet',
        entity_id: entityId,
        title,
        days: Math.floor(quietMs / DAY_MS),
        detail: { stage, last_signal_at: typeof eng.last_signal_at === 'string' ? eng.last_signal_at : null },
      });
    }
  }

  return report;
}

function buildSignalCreate(action: SignalAction): { title: string; options: Parameters<typeof createTask>[4] } {
  const marker = `(signal: ${action.signal}:${action.entity_id})`;
  if (action.signal === 'blocker') {
    return {
      title: `[HUMAN] Signal: blocked ${action.days}d+ w/ unsent escalation — ${action.title} ${marker}`,
      options: {
        assignee: 'human',
        project: 'signals',
        priority: 'normal',
        description: `Blocker signal: source task ${action.entity_id} ("${action.title}") has been blocked ${action.days}d with a drafted-but-unsent escalation.`,
      },
    };
  }
  if (action.signal === 'milestone') {
    const dueDate = typeof action.detail.due_date === 'string' ? action.detail.due_date : 'soon';
    return {
      title: `[HUMAN] Signal: milestone due ${dueDate} — ${action.title} ${marker}`,
      options: {
        assignee: 'human',
        project: 'signals',
        priority: 'normal',
        description: `Milestone signal: task ${action.entity_id} ("${action.title}") is due ${dueDate}, within the milestone look-ahead window.`,
      },
    };
  }
  return {
    title: `Client quiet ${action.days}d: ${action.title} ${marker}`,
    options: {
      assignee: 'crm',
      project: 'client-health',
      priority: 'normal',
      description: `Quiet-client signal: engagement ${action.entity_id} ("${action.title}") has had no meaningful contact for ${action.days}d.`,
    },
  };
}

/**
 * Create one surfacing task per signal action. Re-runs the already-open marker check
 * just-in-time (delivery runs outside any lock). No Telegram, no sendMessage, no
 * activity feed — surfacing lives in a future cron prompt layer.
 */
export function deliverSignalActions(
  actions: SignalAction[],
  opts: { instanceId: string; org: string; fromAgent: string; paths: BusPaths },
): SignalDelivery {
  const delivery: SignalDelivery = { created: [], skipped: [], failed: [] };
  for (const action of actions) {
    try {
      const tasks = listTasks(opts.paths);
      if (hasOpenSignalMarker(tasks, action.signal, action.entity_id)) {
        delivery.skipped.push(action.entity_id);
        continue;
      }
      const { title, options } = buildSignalCreate(action);
      const id = createTask(opts.paths, opts.fromAgent, opts.org, title, options);
      delivery.created.push(id);
    } catch (err) {
      delivery.failed.push({ entity_id: action.entity_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return delivery;
}
