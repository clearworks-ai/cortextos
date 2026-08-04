// cortextOS Dashboard - Fleet Ops (Epics + Josh's human tasks)
//
// The ADDITIVE panel Josh liked from v1, relabelled truthfully. This is NOT
// client-delivery data — it is the internal fleet: open EPICS the agents run
// and the human-class tasks waiting on Josh. Kept in its own tab, never mixed
// into client KPIs/engagements.
//
// Epic + human-task semantics mirror src/bus/task.ts:
//   - ensureEpicTask   → title "Epic: <slug>", project == slug (task.ts:113)
//   - classifyTask     → 'human' when assigned_to ∈ {human,user}, project ==
//                        'human-tasks', or a [HUMAN]/Josh:/Decide: title
//                        (task.ts:91-111)

import { getTasks } from '@/lib/data/tasks';
import type { Task } from '@/lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'waiting']);

export interface EpicRow {
  id: string; // epic task id
  slug: string; // project slug
  title: string; // humanized slug
  owner: string; // owning agent
  ageDays: number;
  total: number; // child tasks in the same project (incl. the epic)
  open: number;
  completed: number;
  blocked: number;
}

export interface HumanTaskRow {
  id: string;
  title: string;
  priority: string;
  dueDate?: string;
  overdue: boolean;
  ageDays: number;
}

export interface FleetOps {
  epics: EpicRow[];
  humanTasks: HumanTaskRow[];
}

function isOpen(t: Task): boolean {
  return OPEN_STATUSES.has(t.status);
}

function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function ageDays(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : 0;
}

/** classifyTask 'human' semantics (task.ts:91-111), open-only surface. */
function isHumanTask(t: Task): boolean {
  return (
    t.assignee === 'human' ||
    t.assignee === 'user' ||
    t.project === 'human-tasks' ||
    /^(\[HUMAN\]|Josh:|Decide:)/i.test(t.title)
  );
}

export function getFleetOps(org?: string): FleetOps {
  const now = Date.now();
  const tasks = getTasks(org ? { org } : undefined);

  // Group by project for child counts (v1's grouping, re-homed).
  const byProject = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.project?.trim();
    if (!key) continue;
    const arr = byProject.get(key);
    if (arr) arr.push(t);
    else byProject.set(key, [t]);
  }

  // Open epics: the "Epic: <slug>" task with project == slug, still open.
  const epics: EpicRow[] = [];
  for (const t of tasks) {
    if (!/^Epic:\s+/i.test(t.title)) continue;
    if (!isOpen(t)) continue;
    const slug = (t.project ?? '').trim() || t.title.replace(/^Epic:\s+/i, '').trim();
    const children = byProject.get(slug) ?? [t];
    epics.push({
      id: t.id,
      slug,
      title: humanize(slug),
      owner: t.assignee ?? 'unassigned',
      ageDays: ageDays(t.created_at, now),
      total: children.length,
      open: children.filter(isOpen).length,
      completed: children.filter((c) => c.status === 'completed').length,
      blocked: children.filter((c) => c.status === 'blocked').length,
    });
  }
  epics.sort((a, b) => b.blocked - a.blocked || b.open - a.open || b.ageDays - a.ageDays);

  // Josh's human tasks: open only, sorted by due date, overdue highlighted.
  const humanTasks: HumanTaskRow[] = tasks
    .filter((t) => isHumanTask(t) && isOpen(t))
    .map((t) => {
      const dueMs = t.due_date ? Date.parse(t.due_date) : NaN;
      return {
        id: t.id,
        title: t.title.replace(/^\[HUMAN\]\s*/i, ''),
        priority: t.priority ?? 'normal',
        dueDate: t.due_date,
        overdue: Number.isFinite(dueMs) && dueMs < now,
        ageDays: ageDays(t.created_at, now),
      };
    })
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      const ad = a.dueDate ? Date.parse(a.dueDate) : Infinity;
      const bd = b.dueDate ? Date.parse(b.dueDate) : Infinity;
      return ad - bd;
    });

  return { epics, humanTasks };
}
