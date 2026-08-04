// cortextOS Dashboard - Client Delivery data model (Mission Control v2)
//
// An ENGAGEMENT is a real CLIENT engagement (Alloi, MSIA, OCG …) — NOT an
// internal bus task project. Sources of truth, all live files on disk:
//
//   - CRM pipeline:  <CRM_DIR>/pipeline.json   (.engagements[] rows)
//   - CRM contacts:  <CRM_DIR>/contacts.json   (.contacts[] rows, id-keyed)
//   - Org-brain:     <ORG_BRAIN_CLIENTS_DIR>/<slug>.md  (H1 / Contacts /
//                    History dated lines / Open Items markdown table + optional
//                    `phase:` frontmatter)
//
// The loader snapshots derived rows into SQLite (client_engagements /
// client_items) inside syncAll() so render stays a pure DB read (freshness
// rule). Nothing is fabricated: a missing dir yields an empty set + a visible
// "no client sources configured" state, never a placeholder row.

import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { getCrmDir, getOrgBrainClientsDir } from '@/lib/config';
import { getRecentEvents } from '@/lib/data/events';
import { getTasks } from '@/lib/data/tasks';
import { getBlessedRoster } from '@/lib/data/blessed-roster';
import {
  loadMulticaLiveStatus,
  isLiveInFlight,
  isLiveOpen,
  type MulticaLiveStatus,
} from '@/lib/data/multica-status';
import type { Event, Task } from '@/lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;

// Paths come from config.ts (CRM_DIR / ORG_BRAIN_CLIENTS_DIR env-overridable).

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EngagementStatus = 'on_track' | 'at_risk' | 'blocked';

export interface ClientContact {
  name: string;
  role: string;
}

export interface ClientOpenItem {
  item: string;
  owner: string;
  deadline?: string; // ISO date or undefined
  status: string;
  open: boolean;
}

export interface ClientEngagement {
  id: string; // per-DEAL stable key (a client may appear more than once)
  client: string; // display name
  clientOrg: string; // raw client_org
  industry?: string;
  contact?: ClientContact;
  phase: string; // unified-lifecycle label (blessed roster)
  phaseNumber: number; // 1-4
  progress: number; // 0-100
  status: EngagementStatus;
  total: number;
  completed: number;
  open: number;
  overdue: number;
  blocked: number;
  inProgress: number; // items live in-flight per Multica (in_progress / in_review)
  liveStatus?: string; // rolled-up live Multica status label (e.g. "in progress", "blocked")
  nextMilestone?: string;
  nextDue?: string; // ISO
  startedAt?: string; // ISO
  history: string[]; // dated history lines (newest first)
}

export interface ClientKpiValue {
  value: number;
  label: string;
  sublabel?: string;
  estimated?: boolean;
  spark?: number[];
}

export interface ClientKpis {
  activeEngagements: ClientKpiValue;
  shippedThisWeek: ClientKpiValue;
  onTimeRate: ClientKpiValue;
  openItems: ClientKpiValue;
  avgResponse: ClientKpiValue;
}

export interface ClientSignal {
  id: string;
  tone: 'warn' | 'good' | 'info';
  title: string;
  detail: string;
}

export interface ClientSources {
  crmDir: string;
  clientsDir: string;
  crmDirExists: boolean;
  clientsDirExists: boolean;
  configured: boolean;
}

// ---------------------------------------------------------------------------
// Raw parsing
// ---------------------------------------------------------------------------

interface PipelineEngagement {
  name?: string;
  stage?: string;
  status?: string;
  client_org?: string;
  client_industry?: string;
  primary_contact_id?: string;
  contact_ids?: string[];
  last_signal_at?: string;
  archived?: boolean;
  stage_history?: { at?: string; to?: string; from?: string }[];
  billing?: string | null;
}

interface CrmContact {
  id?: string;
  name?: string;
  role?: string;
  title?: string;
  category?: string;
  tags?: string[];
}

interface ClientMd {
  frontmatter: Record<string, string>;
  title?: string;
  contacts: string[]; // raw "Name — Role — email" lines
  history: string[]; // dated lines, file order (newest first as authored)
  openItems: ClientOpenItem[];
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function loadPipeline(): PipelineEngagement[] {
  const raw = readJson<{ engagements?: PipelineEngagement[] } | PipelineEngagement[]>(
    path.join(getCrmDir(), 'pipeline.json'),
  );
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw.engagements) ? raw.engagements : [];
}

function loadContacts(): Map<string, CrmContact> {
  const raw = readJson<{ contacts?: CrmContact[] } | CrmContact[]>(
    path.join(getCrmDir(), 'contacts.json'),
  );
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.contacts) ? raw.contacts : [];
  const map = new Map<string, CrmContact>();
  for (const c of list) {
    if (c && c.id != null) map.set(String(c.id), c);
  }
  return map;
}

/** Slugify a client_org into the org-brain md filename stem. */
export function clientSlug(clientOrg: string): string {
  return clientOrg
    .toLowerCase()
    .replace(/\.[a-z]+$/, '') // drop a trailing TLD like .us / .com
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse an org-brain client md file: frontmatter, H1, Contacts, History, Open Items. */
export function parseClientMd(src: string): ClientMd {
  const result: ClientMd = { frontmatter: {}, contacts: [], history: [], openItems: [] };

  let body = src;
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) result.frontmatter[m[1].trim()] = m[2].trim();
    }
    body = src.slice(fm[0].length);
  }

  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) result.title = h1[1].replace(/^Client:\s*/i, '').trim();

  // Split into ## sections.
  const sections = new Map<string, string>();
  const re = /^##\s+(.+)$/gm;
  const marks: { name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    marks.push({ name: m[1].trim(), start: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? body.indexOf('\n##', marks[i].start) : body.length;
    const stop = end === -1 ? body.length : end;
    sections.set(marks[i].name.toLowerCase(), body.slice(marks[i].start, stop));
  }

  const contactsSec = sections.get('contacts');
  if (contactsSec) {
    for (const line of contactsSec.split('\n')) {
      const t = line.replace(/^[-*]\s+/, '').trim();
      if (t && line.trim().startsWith('-')) result.contacts.push(t);
    }
  }

  const historySec = sections.get('history (dated, newest first)') ?? sections.get('history');
  if (historySec) {
    for (const line of historySec.split('\n')) {
      const t = line.replace(/^[-*]\s+/, '').trim();
      if (t && line.trim().startsWith('-')) result.history.push(t);
    }
  }

  const openSec = sections.get('open items');
  if (openSec) {
    const rows = openSec
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|'));
    // Expect header row + separator row, then data rows.
    for (const row of rows) {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 5) continue;
      // Skip header and markdown separator rows.
      if (/^item$/i.test(cells[0])) continue;
      if (/^:?-{2,}:?$/.test(cells[0])) continue;
      // Skip an all-blank template row (`| | | | | |`) — every cell empty after
      // trim — so it isn't counted as a phantom open item.
      if (cells.every((c) => c === '')) continue;
      const deadlineRaw = cells[2];
      const statusRaw = (cells[4] || '').toLowerCase();
      const open = statusRaw !== 'done' && statusRaw !== 'closed' && statusRaw !== 'complete' && statusRaw !== 'completed' && statusRaw !== 'cancelled';
      result.openItems.push({
        item: cells[0],
        owner: cells[1],
        deadline: deadlineRaw ? normalizeDate(deadlineRaw) : undefined,
        status: statusRaw || 'open',
        open,
      });
    }
  }

  return result;
}

function normalizeDate(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function loadClientMd(clientOrg: string): ClientMd | null {
  const dir = getOrgBrainClientsDir();
  if (!fs.existsSync(dir)) return null;
  const candidate = path.join(dir, `${clientSlug(clientOrg)}.md`);
  if (fs.existsSync(candidate)) {
    try {
      return parseClientMd(fs.readFileSync(candidate, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function deriveContact(
  eng: PipelineEngagement,
  contacts: Map<string, CrmContact>,
  md: ClientMd | null,
): ClientContact | undefined {
  const cid = eng.primary_contact_id;
  if (cid) {
    const c = contacts.get(cid);
    if (c?.name) {
      return { name: c.name, role: c.role ?? c.title ?? '' };
    }
  }
  // Fallback: first Contacts line in the md ("Name — Role — email").
  if (md && md.contacts.length > 0) {
    const parts = md.contacts[0].split(/\s+—\s+|\s+-\s+/);
    return { name: parts[0]?.trim() ?? '', role: parts[1]?.trim() ?? '' };
  }
  return undefined;
}

function deriveStartedAt(eng: PipelineEngagement): string | undefined {
  const hist = eng.stage_history ?? [];
  for (const h of hist) {
    if ((h.to === 'won' || h.to === 'committed') && h.at) {
      const t = Date.parse(h.at);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  }
  return undefined;
}

/** Bus tasks whose project matches this client's slug (a client-linked task). */
function clientTasks(clientOrg: string, tasks: Task[]): Task[] {
  const slug = clientSlug(clientOrg);
  return tasks.filter((t) => {
    const proj = (t.project ?? '').toLowerCase();
    return proj === slug || proj === clientOrg.toLowerCase();
  });
}

function isTaskOpen(t: Task): boolean {
  return t.status !== 'completed';
}

// ---------------------------------------------------------------------------
// Engagement build
// ---------------------------------------------------------------------------

/**
 * Build the engagement rows from the BLESSED ROSTER (authoritative membership +
 * phase per CLIENT-ROSTER-AND-PHASES.md), joining live data:
 *   - contact + history + Open Items from the org-brain md,
 *   - CRM pipeline row (matched by client_org) for last_signal_at / stage_history,
 *   - client-linked bus tasks,
 *   - LIVE Multica issue status per linked task (in_progress / in_review / blocked).
 *
 * Membership is NOT derived from the CRM won-stage (that mislabeled OCG/MSIA and
 * dropped Alloi/521/Kadre). Phase comes from the roster's unified-lifecycle model.
 */
export function buildEngagements(org?: string): ClientEngagement[] {
  const contacts = loadContacts();
  const pipeline = loadPipeline();
  const tasks = getTasks(org ? { org } : undefined);
  const liveStatusByTask = loadMulticaLiveStatus();
  const now = Date.now();

  const roster = getBlessedRoster();
  const rows: ClientEngagement[] = [];

  for (const b of roster) {
    // CRM pipeline row for this deal (matched by client_org, non-archived).
    // Stage-compatibility guard: a roster row already at phase 3 (Delivered/
    // Monitoring) or 4 (Post-delivery Follow-up) must NOT be matched to an
    // unrelated pre-sales-stage deal that happens to share the client name (a
    // client can have both a delivered engagement and a newer qualified deal —
    // confirmed live with SEIU 521). Keeping the check inside the predicate lets
    // .find() skip an incompatible row and keep scanning for a delivery-consistent
    // one. 'won'/'committed' reuses deriveStartedAt()'s existing precedent below.
    const eng = pipeline.find(
      (p) =>
        !p.archived &&
        (p.client_org ?? '').trim().toLowerCase() === b.clientOrg.toLowerCase() &&
        (b.phaseNumber < 3 || p.stage === 'won' || p.stage === 'committed'),
    );

    const md = loadClientMd(b.clientOrg);
    const contact = deriveContact(eng ?? {}, contacts, md);

    // Item universe: org-brain Open Items rows + client-linked bus tasks.
    const openItems = md?.openItems ?? [];
    const linkedTasks = clientTasks(b.clientOrg, tasks);

    // Live Multica status for each linked task (falls back to local task status).
    const taskLive = linkedTasks.map((t) => ({
      task: t,
      live: liveStatusByTask.get(t.id),
    }));

    const taskOpen = (x: { task: Task; live?: MulticaLiveStatus }) =>
      x.live ? isLiveOpen(x.live) : isTaskOpen(x.task);
    const taskInFlight = (x: { task: Task; live?: MulticaLiveStatus }) =>
      x.live ? isLiveInFlight(x.live) : x.task.status === 'in_progress';
    const taskBlocked = (x: { task: Task; live?: MulticaLiveStatus }) =>
      x.live ? x.live === 'blocked' : x.task.status === 'blocked';

    const itemTotal = openItems.length + linkedTasks.length;
    const itemClosed =
      openItems.filter((i) => !i.open).length + taskLive.filter((x) => !taskOpen(x)).length;
    const openCount =
      openItems.filter((i) => i.open).length + taskLive.filter(taskOpen).length;

    const overdue =
      openItems.filter((i) => i.open && i.deadline && Date.parse(i.deadline) < now).length +
      taskLive.filter(
        (x) => taskOpen(x) && x.task.due_date && Date.parse(x.task.due_date) < now,
      ).length;

    const blocked =
      openItems.filter((i) => i.open && /blocked/i.test(i.status)).length +
      taskLive.filter(taskBlocked).length;

    const inProgress = taskLive.filter(taskInFlight).length;

    // Quiet check reuses the last_signal_at freshness the signal-sweep uses.
    const lastSignal = eng?.last_signal_at ? Date.parse(eng.last_signal_at) : NaN;
    const quiet = Number.isFinite(lastSignal) && now - lastSignal >= 14 * DAY_MS;

    // Status: blocked wins, then in-flight reflects live work, then at_risk, else on_track.
    let status: EngagementStatus = 'on_track';
    if (blocked > 0) status = 'blocked';
    else if (overdue > 0 || quiet) status = 'at_risk';

    // Rolled-up LIVE label (reflect, not just todo): prefer the most escalated
    // live signal present among linked tasks.
    let liveStatus: string | undefined;
    if (blocked > 0) liveStatus = 'blocked';
    else if (inProgress > 0) liveStatus = 'in progress';
    else if (taskLive.some((x) => x.live === 'in_review')) liveStatus = 'in review';
    else if (taskLive.some((x) => x.live && isLiveOpen(x.live))) liveStatus = 'active';

    // Soonest dated open item.
    const dated = openItems
      .filter((i) => i.open && i.deadline)
      .map((i) => ({ item: i.item, ms: Date.parse(i.deadline as string) }))
      .filter((x) => Number.isFinite(x.ms))
      .sort((a, b) => a.ms - b.ms);
    const nextDue = dated.length > 0 ? new Date(dated[0].ms).toISOString() : undefined;
    const nextMilestone = dated.length > 0 ? dated[0].item : undefined;

    rows.push({
      id: b.id,
      client: md?.title ?? b.client,
      clientOrg: b.clientOrg,
      industry: eng?.client_industry ?? b.industry,
      contact,
      phase: b.phase,
      phaseNumber: b.phaseNumber,
      progress: itemTotal > 0 ? Math.round((itemClosed / itemTotal) * 100) : 0,
      status,
      total: itemTotal,
      completed: itemClosed,
      open: openCount,
      overdue,
      blocked,
      inProgress,
      liveStatus,
      nextMilestone,
      nextDue,
      startedAt: eng ? deriveStartedAt(eng) : undefined,
      history: (md?.history ?? []).slice(0, 8),
    });
  }

  // Roster order = phase ascending (Pre-sales Design → Post-delivery Follow-up).
  rows.sort((a, b) => a.phaseNumber - b.phaseNumber);
  return rows;
}

// ---------------------------------------------------------------------------
// KPIs (client-only)
// ---------------------------------------------------------------------------

export function buildClientKpis(engagements: ClientEngagement[], org?: string): ClientKpis {
  const now = Date.now();
  const weekAgo = now - 7 * DAY_MS;
  const thirtyAgo = now - 30 * DAY_MS;

  const active = engagements.filter((e) => e.open > 0);
  const industries = new Set(
    engagements.map((e) => e.industry).filter((v): v is string => !!v && v.trim() !== ''),
  );

  const totalOpen = engagements.reduce((n, e) => n + e.open, 0);
  const totalOverdue = engagements.reduce((n, e) => n + e.overdue, 0);

  // Shipped this week: client-linked bus tasks completed in trailing 7d, per day.
  const tasks = getTasks(org ? { org } : undefined);
  const engOrgs = new Set(engagements.map((e) => clientSlug(e.clientOrg)));
  const clientCompleted = tasks.filter((t) => {
    if (!t.completed_at) return false;
    const proj = (t.project ?? '').toLowerCase();
    return engOrgs.has(proj) && Date.parse(t.completed_at) >= weekAgo;
  });
  const spark: number[] = new Array(7).fill(0);
  for (const t of clientCompleted) {
    const ms = Date.parse(t.completed_at as string);
    if (!Number.isFinite(ms)) continue;
    const idx = 6 - Math.floor((now - ms) / DAY_MS);
    if (idx >= 0 && idx < 7) spark[idx] += 1;
  }

  // On-time (30d): client-linked tasks closed in 30d that HAD a deadline.
  const dueClosed = tasks.filter((t) => {
    const proj = (t.project ?? '').toLowerCase();
    return (
      engOrgs.has(proj) && t.completed_at && t.due_date && Date.parse(t.completed_at) >= thirtyAgo
    );
  });
  const onTime = dueClosed.filter(
    (t) => Date.parse(t.completed_at as string) <= Date.parse(t.due_date as string),
  ).length;
  const onTimeRate = dueClosed.length > 0 ? Math.round((onTime / dueClosed.length) * 100) : 0;

  const avgResponse = estimateAvgResponseMinutes();

  return {
    activeEngagements: {
      value: active.length,
      label: 'Active Engagements',
      sublabel: industries.size > 0 ? `${industries.size} vertical${industries.size > 1 ? 's' : ''}` : `${engagements.length} total`,
    },
    shippedThisWeek: {
      value: clientCompleted.length,
      label: 'Shipped This Week',
      sublabel: 'client closes · 7d',
      spark,
    },
    onTimeRate: {
      value: onTimeRate,
      label: 'On-Time Rate',
      sublabel: dueClosed.length > 0 ? `${onTime}/${dueClosed.length} · 30d` : 'no dated closes · 30d',
    },
    openItems: {
      value: totalOpen,
      label: 'Open Items',
      sublabel: totalOverdue > 0 ? `${totalOverdue} overdue` : 'none overdue',
    },
    avgResponse: {
      value: avgResponse ?? 0,
      label: 'Avg Response',
      sublabel: avgResponse != null ? 'inbound → outbound · est' : 'not enough interactions',
      estimated: true,
    },
  };
}

interface Interaction {
  timestamp?: string;
  ts?: string;
  direction?: string;
}

/**
 * Median gap (minutes) from an inbound client interaction to the next outbound
 * one, read from crm/interactions.jsonl. Explicitly ESTIMATED — the honesty
 * label stays until inbound timestamps are systematic.
 */
function estimateAvgResponseMinutes(): number | null {
  const p = path.join(getCrmDir(), 'interactions.jsonl');
  if (!fs.existsSync(p)) return null;
  let lines: Interaction[];
  try {
    lines = fs
      .readFileSync(p, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Interaction;
        } catch {
          return {} as Interaction;
        }
      });
  } catch {
    return null;
  }

  const events = lines
    .map((r) => ({
      ms: Date.parse((r.timestamp ?? r.ts ?? '') as string),
      dir: (r.direction ?? '').toLowerCase(),
    }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);

  const gaps: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].dir !== 'inbound') continue;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].dir === 'outbound') {
        const gap = events[j].ms - events[i].ms;
        if (gap > 0 && gap < 14 * DAY_MS) gaps.push(gap);
        break;
      }
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.max(1, Math.round(median / 60000));
}

// ---------------------------------------------------------------------------
// Signals (against client rows)
// ---------------------------------------------------------------------------

export function buildClientSignals(engagements: ClientEngagement[], org?: string): ClientSignal[] {
  const now = Date.now();
  const signals: ClientSignal[] = [];
  const tasks = getTasks(org ? { org } : undefined);

  // warn — engagement blocked/at_risk ≥5d WITH a drafted escalation.
  for (const e of engagements) {
    if (e.status !== 'blocked' && e.status !== 'at_risk') continue;
    if (e.blocked === 0 && e.overdue === 0) continue;
    const nameMatch = new RegExp(escapeRe(e.client) + '|' + escapeRe(e.clientOrg), 'i');
    const hasEscalation = tasks.some(
      (t) =>
        (t.assignee === 'human' || /^\[HUMAN\]/i.test(t.title) || t.needs_approval) &&
        isTaskOpen(t) &&
        nameMatch.test(`${t.title} ${t.description ?? ''}`),
    );
    signals.push({
      id: `warn-${e.id}`,
      tone: 'warn',
      title: `${e.client} ${e.status === 'blocked' ? 'blocked' : 'at risk'} on ${e.nextMilestone ? shorten(e.nextMilestone) : 'an open item'}`,
      detail: hasEscalation
        ? 'Escalation drafted, needs your approval.'
        : 'No escalation drafted yet.',
    });
  }

  // info — 2+ next-milestone due dates within the current week.
  const dueThisWeek = engagements
    .filter((e) => e.nextDue && Date.parse(e.nextDue) >= now && Date.parse(e.nextDue) <= now + 7 * DAY_MS)
    .map((e) => `${e.client}: ${shorten(e.nextMilestone ?? 'milestone')}`);
  if (dueThisWeek.length >= 2) {
    signals.push({
      id: 'info-milestones-week',
      tone: 'info',
      title: `${dueThisWeek.length} client milestones due this week`,
      detail: dueThisWeek.slice(0, 3).join(' · '),
    });
  }

  // good — only rendered if a real accuracy/threshold event above threshold exists.
  const accuracyEvent = findAccuracyEvent(engagements, org);
  if (accuracyEvent) {
    signals.push({
      id: 'good-accuracy',
      tone: 'good',
      title: accuracyEvent.title,
      detail: accuracyEvent.detail,
    });
  }

  // Order: warn → good → info (v1 ordering kept).
  const rank: Record<ClientSignal['tone'], number> = { warn: 0, good: 1, info: 2 };
  signals.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return signals;
}

function findAccuracyEvent(
  engagements: ClientEngagement[],
  org?: string,
): { title: string; detail: string } | null {
  const events = getRecentEvents(200, org);
  for (const ev of events) {
    const msg = ev.message ?? '';
    const m = msg.match(/(accuracy|precision)[^\d]{0,20}(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (!m) continue;
    const pct = parseFloat(m[2]);
    const threshold = extractThreshold(ev);
    if (threshold != null && pct < threshold) continue;
    const client = engagements.find((e) =>
      new RegExp(escapeRe(e.client) + '|' + escapeRe(e.clientOrg), 'i').test(msg),
    );
    return {
      title: `${client ? client.client + ' ' : ''}accuracy ${pct}%${threshold != null ? ` (≥ ${threshold}% threshold)` : ''}`,
      detail: shorten(msg, 120),
    };
  }
  return null;
}

function extractThreshold(ev: Event): number | null {
  const data = ev.data ?? {};
  const t = data.threshold ?? data.target;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const n = parseFloat(t);
    if (Number.isFinite(n)) return n;
  }
  const m = (ev.message ?? '').match(/threshold[^\d]{0,10}(\d{1,3}(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shorten(s: string, max = 60): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------------------------------------------------------------------------
// SQLite snapshot (called from syncAll)
// ---------------------------------------------------------------------------

export function ensureClientTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_engagements (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL,
      client_org TEXT NOT NULL,
      industry TEXT,
      contact_name TEXT,
      contact_role TEXT,
      phase TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'on_track',
      total INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      open INTEGER NOT NULL DEFAULT 0,
      overdue INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      next_milestone TEXT,
      next_due TEXT,
      started_at TEXT,
      history TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id TEXT NOT NULL,
      item TEXT NOT NULL,
      owner TEXT,
      deadline TEXT,
      status TEXT,
      open INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_client_engagements_org ON client_engagements(org);
    CREATE INDEX IF NOT EXISTS idx_client_items_eng ON client_items(engagement_id);
  `);
}

/**
 * Snapshot derived engagement rows + open items into SQLite. Called inside
 * syncAll() so the API/RSC read is a pure DB read. Full replace each pass
 * (the derived set is small and cheap to recompute).
 */
export function syncClients(): number {
  ensureClientTables();
  const engagements = buildEngagements();
  const now = new Date().toISOString();

  const upsertEng = db.prepare(`
    INSERT OR REPLACE INTO client_engagements
      (id, org, client, client_org, industry, contact_name, contact_role, phase,
       progress, status, total, completed, open, overdue, blocked, next_milestone,
       next_due, started_at, history, synced_at)
    VALUES
      (@id, @org, @client, @client_org, @industry, @contact_name, @contact_role, @phase,
       @progress, @status, @total, @completed, @open, @overdue, @blocked, @next_milestone,
       @next_due, @started_at, @history, @synced_at)
  `);

  const run = db.transaction(() => {
    db.prepare('DELETE FROM client_engagements').run();
    for (const e of engagements) {
      upsertEng.run({
        id: e.id,
        org: '',
        client: e.client,
        client_org: e.clientOrg,
        industry: e.industry ?? null,
        contact_name: e.contact?.name ?? null,
        contact_role: e.contact?.role ?? null,
        phase: e.phase,
        progress: e.progress,
        status: e.status,
        total: e.total,
        completed: e.completed,
        open: e.open,
        overdue: e.overdue,
        blocked: e.blocked,
        next_milestone: e.nextMilestone ?? null,
        next_due: e.nextDue ?? null,
        started_at: e.startedAt ?? null,
        history: JSON.stringify(e.history),
        synced_at: now,
      });
    }
  });
  run();
  return engagements.length;
}

// ---------------------------------------------------------------------------
// Source-config introspection (for the honest "no sources" state)
// ---------------------------------------------------------------------------

export function getClientSources(): ClientSources {
  const crmDir = getCrmDir();
  const clientsDir = getOrgBrainClientsDir();
  const crmDirExists = fs.existsSync(path.join(crmDir, 'pipeline.json'));
  const clientsDirExists = fs.existsSync(clientsDir);
  return {
    crmDir,
    clientsDir,
    crmDirExists,
    clientsDirExists,
    configured: crmDirExists,
  };
}
