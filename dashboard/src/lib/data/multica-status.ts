// cortextOS Dashboard — Multica live-status reader
//
// The Multica bridge persists, per bus task, the LAST SEEN live Multica issue
// status in sync-state.json (written by the poll worker). This is the live
// task/engagement status — it reflects in_progress / in_review / blocked, not
// just the local todo/backlog snapshot. The dashboard reads it so an engagement
// row shows real in-flight work rather than a stale "todo".
//
// File:  <CTX_ROOT|framework>/orgs/clearworksai/state/multica-bridge/sync-state.json
//   { schema_version, updated_at, links: { <bus_task_id>: { multica_issue_id,
//     last_seen_multica_status, ... } } }
//
// Missing / corrupt file ⇒ empty map (honest: no live status, never fabricated).

import fs from 'fs';
import path from 'path';
import { CTX_ROOT, CTX_FRAMEWORK_ROOT } from '@/lib/config';

// Live Multica issue statuses (mirror src/bus/multica/types.ts).
export type MulticaLiveStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled';

const LIVE_STATUSES = new Set<MulticaLiveStatus>([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
]);

interface SyncLink {
  multica_issue_id: string | null;
  last_seen_multica_status: string | null;
}

interface SyncState {
  links?: Record<string, SyncLink>;
}

/** Candidate sync-state.json locations (env override wins, then state, then framework). */
export function multicaSyncStatePaths(): string[] {
  const rel = path.join(
    'orgs',
    'clearworksai',
    'state',
    'multica-bridge',
    'sync-state.json',
  );
  const paths: string[] = [];
  const env = process.env.MULTICA_SYNC_STATE;
  if (env && env.trim()) paths.push(env.trim());
  paths.push(path.join(CTX_ROOT, rel));
  paths.push(path.join(CTX_FRAMEWORK_ROOT, rel));
  return paths;
}

/**
 * Live Multica status keyed by bus task id. Only links with a resolved issue
 * and a recognized live status are returned.
 */
export function loadMulticaLiveStatus(): Map<string, MulticaLiveStatus> {
  const map = new Map<string, MulticaLiveStatus>();
  let state: SyncState | null = null;
  for (const p of multicaSyncStatePaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      state = JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncState;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!state?.links) return map;

  for (const [taskId, link] of Object.entries(state.links)) {
    if (!link || !link.multica_issue_id) continue;
    const s = link.last_seen_multica_status;
    if (s && LIVE_STATUSES.has(s as MulticaLiveStatus)) {
      map.set(taskId, s as MulticaLiveStatus);
    }
  }
  return map;
}

/** A live status counts as "open work" (not done/cancelled). */
export function isLiveOpen(s: MulticaLiveStatus): boolean {
  return s !== 'done' && s !== 'cancelled';
}

/** A live status that means work is actively in flight (reflect, not just todo). */
export function isLiveInFlight(s: MulticaLiveStatus): boolean {
  return s === 'in_progress' || s === 'in_review';
}
