import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../../utils/atomic.js';
import type { GenerationToken } from './types.js';

/**
 * Task 2.2: adapts upstream `31af138b`'s fresh-start-marker identity fix for
 * this fork, ahead of the full lifecycle supervisor wiring (Tasks 2.4/2.5).
 *
 * Upstream's version defers the marker's rename-reservation to AFTER a
 * successful spawn (a stat-only, non-destructive probe feeds the mode
 * decision; the reservation itself only happens in the post-spawn consume
 * step). This fork's design reserves EAGERLY, at decision time
 * (`importFreshRequest`, called from `AgentProcess.shouldContinue()`), and
 * carries the reservation handle through to whichever outcome
 * (`consumeFreshRequest` / `restoreFreshRequest`) the spawn attempt reaches —
 * mirroring the "reserve by rename, not bare mkdir/mtime" discipline already
 * established for the Task 1.2 store lock (`acquireStoreLock`) rather than
 * upstream's stat-identity-comparison mechanics. Both designs share the same
 * invariant this task exists to guarantee: a request survives a failed spawn,
 * a newer request is never destroyed by an older consumer, and deciding a
 * mode never by itself consumes anything.
 */

const FORCE_FRESH_BASENAME = '.force-fresh';
const SESSION_REFRESH_BASENAME = '.session-refresh';

export interface ImportedFreshRequest {
  requestId: string;
  markerPath: string;
  reservedPath: string;
  reason: string;
  observedMtimeMs: number;
}

function forceFreshMarkerPath(stateDir: string): string {
  return join(stateDir, FORCE_FRESH_BASENAME);
}

function newRequestId(): string {
  return `ffr-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Import (reserve) the `.force-fresh` marker at `stateDir`, if one is
 * present, by RENAME — never by read-then-unlink.
 *
 * A read-then-unlink is a TOCTOU: `.force-fresh` has multiple independent
 * writers (`AgentProcess.armForceFresh()`'s image-poison/opencode-wedge
 * auto-recovery, and `src/bus/system.ts`'s `hardRestart()` from a separate
 * CLI process), so a new request can land between the read and the unlink
 * and get silently destroyed by a consumer that never actually honored it.
 * `renameSync` is the atomic take: exactly one caller's rename can succeed
 * against a given source path, so concurrent importers never both believe
 * they own the same request.
 *
 * Returns `null` when no marker is present (`ENOENT`) or when a concurrent
 * importer already won the race to rename it away first — in the latter
 * case the request belongs to whichever renamer succeeded, never to us.
 * Never throws: a decision path (this is called from
 * `AgentProcess.shouldContinue()`) must not fail on a marker-import race or
 * an unreadable reserved file.
 */
export function importFreshRequest(stateDir: string): ImportedFreshRequest | null {
  const markerPath = forceFreshMarkerPath(stateDir);
  const requestId = newRequestId();
  const reservedPath = `${markerPath}.reserved.${requestId}`;

  try {
    renameSync(markerPath, reservedPath);
  } catch {
    // ENOENT (no marker present), or we lost a race against a concurrent
    // importer whose rename already moved the source away. Either way there
    // is no request here for THIS call to own.
    return null;
  }

  let observedMtimeMs: number;
  try {
    observedMtimeMs = statSync(reservedPath).mtimeMs;
  } catch {
    // The reserved file vanished between our rename and this stat. We are
    // the exclusive owner of this exact reservedPath, so this should be
    // unreachable in practice — but a decision path must fail safe, not
    // throw, so treat it as "no request to import".
    return null;
  }

  let reason = '';
  try {
    reason = readFileSync(reservedPath, 'utf-8').trim();
  } catch {
    reason = '';
  }

  return { requestId, markerPath, reservedPath, reason, observedMtimeMs };
}

/**
 * Consume a previously-imported fresh request. Call ONLY after the spawn
 * that decided `fresh` mode from this request has succeeded.
 *
 * Deletes ONLY the reserved copy (`req.reservedPath`) — by construction,
 * once a request has been reserved-by-rename there is no live file left at
 * `req.markerPath` under that exact name unless a NEW marker was
 * independently written after the reservation, which this function never
 * touches (it is a separate, later request with its own lifecycle).
 *
 * Idempotent: consuming an already-consumed (or already-restored-elsewhere)
 * request is a silent no-op, never a throw.
 */
export function consumeFreshRequest(req: ImportedFreshRequest): void {
  try {
    unlinkSync(req.reservedPath);
  } catch {
    // Already gone — consumed earlier, restored elsewhere, or externally
    // cleaned up. Consuming is idempotent.
  }
}

/**
 * Restore a previously-imported fresh request after a FAILED spawn attempt,
 * so the next attempt still starts fresh.
 *
 * Never clobbers a newer `.force-fresh` request that has already been
 * written at the live marker path since this one was reserved: a live
 * marker can only exist at that path again if some OTHER writer created it
 * after our `importFreshRequest` renamed the prior one away, which makes it
 * definitionally the newer, superseding request. Compares mtimes as the
 * documented guard (never restore over anything at-or-newer than what we
 * observed at import time) rather than relying solely on presence, so the
 * ordering guarantee is explicit and testable rather than incidental.
 */
export function restoreFreshRequest(req: ImportedFreshRequest): void {
  let liveMtimeMs: number | null = null;
  try {
    liveMtimeMs = statSync(req.markerPath).mtimeMs;
  } catch {
    liveMtimeMs = null; // no live marker currently present
  }

  if (liveMtimeMs !== null && liveMtimeMs >= req.observedMtimeMs) {
    // A newer (or, in a same-tick tie, indistinguishably-ordered) request
    // already stands at the live path. It supersedes the one that just
    // failed — drop our now-redundant reservation without touching it.
    try { unlinkSync(req.reservedPath); } catch { /* best-effort */ }
    return;
  }

  try {
    renameSync(req.reservedPath, req.markerPath);
  } catch {
    // Reserved file already gone (e.g. concurrently consumed/restored by
    // another path) — best-effort restore only, never throw from a
    // recovery path.
  }
}

/**
 * Write the `.force-fresh` marker through an atomic temp-write + rename
 * swap, rather than an in-place `writeFileSync` onto the canonical path.
 *
 * This is the "small helper" `src/bus/system.ts`'s `hardRestart()` routes
 * its write through (Task 2.2 Step 3): a deliberate two-step migration.
 * Step one (this task) makes the WRITE mechanics safe against a concurrent
 * `importFreshRequest` reader — the marker either fully exists with its
 * complete content or doesn't exist yet, never a partially-written file a
 * renamer could reserve mid-write. Step two (Task 2.8) is routing this
 * call site through the full `AgentLifecycleSupervisor.request()` API once
 * the daemon's IPC/CLI layer submits identified requests end to end.
 *
 * `content` is caller-supplied so this changes only the write mechanics,
 * never the on-disk content shape any existing writer already produces.
 */
export function writeForceFreshMarker(stateDir: string, content: string): void {
  ensureDir(stateDir);
  const markerPath = forceFreshMarkerPath(stateDir);
  const stagingPath = `${markerPath}.write-${newRequestId()}`;
  writeFileSync(stagingPath, content, 'utf-8');
  try {
    renameSync(stagingPath, markerPath);
  } catch (err) {
    try { unlinkSync(stagingPath); } catch { /* best-effort cleanup only */ }
    throw err;
  }
}

/**
 * Project a `.session-refresh` marker as an identified transition rather
 * than a bare, ownerless `writeFileSync`.
 *
 * The on-disk shape consumed by `src/hooks/hook-crash-alert.ts` is
 * presence-only (see its `classifyFromMarkers` — the file's content is
 * never parsed there), so this keeps writing the EXACT same line the hook
 * has always seen; only the write site moves into a function keyed to a
 * real `GenerationToken`. `token` is intentionally unused today — nothing
 * reads it back yet — so this task's contribution is fixing the call
 * signature ahead of Task 2.4's rewire, which is what starts asserting that
 * a STALE marker (wrong generation) can neither cancel nor authorize a
 * transition. Until then this function is a pure relocation, not a
 * behavior change.
 */
export function projectSessionRefreshMarker(stateDir: string, _token: GenerationToken): void {
  writeFileSync(
    join(stateDir, SESSION_REFRESH_BASENAME),
    'session-time-cap rollover\n',
    'utf-8',
  );
}
