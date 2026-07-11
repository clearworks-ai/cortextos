import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Suppression window for handoff back-ping re-fires. */
export const HANDOFF_BACKPING_SUPPRESS_MS = 10 * 60_000;

export interface BackPingState {
  /** epoch ms of last emitted back-ping, or null if none / unreadable. */
  lastPingMs: number | null;
  /** current time epoch ms. */
  nowMs: number;
  /** epoch ms of newest INBOUND message in the live buffer, or null. */
  newestInboundMs: number | null;
  /** suppression window in ms. */
  windowMs: number;
}

/**
 * Return true when the handoff back-ping should be SUPPRESSED (skipped).
 *  - no prior ping        -> allow (false)
 *  - window elapsed       -> allow (false)
 *  - within window AND a materially-new inbound message arrived after the last
 *    ping -> allow (false)
 *  - within window, nothing new -> suppress (true)
 */
export function shouldSuppressBackPing(s: BackPingState): boolean {
  if (s.lastPingMs === null) return false;
  if (s.nowMs - s.lastPingMs >= s.windowMs) return false;
  if (s.newestInboundMs !== null && s.newestInboundMs > s.lastPingMs) return false;
  return true;
}

function markerPath(ctxRoot: string, agent: string): string {
  return join(ctxRoot, 'state', agent, '.last-back-ping');
}

/** Read last back-ping epoch ms. Returns null when missing/unreadable/NaN. */
export function readLastBackPingMs(ctxRoot: string, agent: string): number | null {
  try {
    const p = markerPath(ctxRoot, agent);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Write the marker with the given epoch ms. Best-effort; never throws. */
export function writeLastBackPingMs(ctxRoot: string, agent: string, nowMs: number): void {
  try {
    const dir = join(ctxRoot, 'state', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(ctxRoot, agent), String(nowMs), 'utf-8');
  } catch {
    /* non-fatal: dedup marker is best-effort observability */
  }
}
