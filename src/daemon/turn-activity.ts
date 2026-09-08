/**
 * turn-activity — liveness from completed TURNS, not from outbound chatter.
 *
 * WHY THIS EXISTS (knox-codex, 2026-09-08). The wedge watchdog used
 * conversation-buffer.jsonl's mtime as its staleness clock. That file is touched
 * only on outbound Telegram sends, so "working silently" and "wedged" were the
 * same observation, and agents were force-restarted for not having spoken to
 * Josh in days (frank2 at 3412min, larry at 2099min; 229 force-restarts across
 * the fleet in one daemon log).
 *
 * codex-tokens.jsonl carries one row per COMPLETED TURN — the actual signal.
 *
 * THE SESSION FILTER IS MANDATORY. After a restart, a leaked previous-session
 * process keeps appending to the same log (observed 18:16/18:18/18:20/18:25 on
 * 2026-09-08, after the 18:15 restart). Reading the file unfiltered would report
 * a dead agent as alive using the corpse's own turns.
 */

import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Bytes of log tail to consider. The watchdog runs every poll cycle and these
 * logs grow unbounded (knox's is ~667KB), so this must never be a whole-file
 * read. 256KB covers thousands of rows — far more than any sane staleness
 * window — while staying cheap.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * The session the agent is running RIGHT NOW.
 *
 * The thread file wins because it is stamped when the session starts, whereas
 * context_status.json is written per completed turn — so immediately after a
 * restart it still names the OLD session, which would make every fresh start
 * look stale. Falls back to context_status.json when no thread file exists
 * (non-codex runtimes, or first boot).
 */
export function readCurrentSessionId(stateDir: string): string | null {
  const thread = join(stateDir, 'codex-app-server-thread.json');
  if (existsSync(thread)) {
    try {
      const id = JSON.parse(readFileSync(thread, 'utf-8'))?.threadId;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch { /* malformed/partial write — fall through */ }
  }
  const ctx = join(stateDir, 'context_status.json');
  if (existsSync(ctx)) {
    try {
      const id = JSON.parse(readFileSync(ctx, 'utf-8'))?.session_id;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch { /* malformed/partial write */ }
  }
  return null;
}

/**
 * Epoch-ms of the most recent COMPLETED turn belonging to `sessionId`, or null
 * if that session has completed none (a fresh start) or the log is unreadable.
 *
 * Null is deliberately distinct from "old": a caller must not treat "no turns
 * yet" as a stall, or it would kill every agent during boot.
 */
export function readLastTurnAtMs(tokensLogPath: string, sessionId: string): number | null {
  if (!sessionId || !existsSync(tokensLogPath)) return null;

  let text: string;
  try {
    const size = statSync(tokensLogPath).size;
    if (size === 0) return null;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = openSync(tokensLogPath, 'r');
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }
    text = buf.toString('utf-8');
    // A tail read lands mid-row; that partial first line is not valid JSON and
    // must be discarded rather than parsed.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return null;
  }

  let newest: number | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: { timestamp?: unknown; session_id?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue; // truncated or interleaved write — skip, never throw
    }
    if (row.session_id !== sessionId) continue;
    if (typeof row.timestamp !== 'string') continue;
    const ms = Date.parse(row.timestamp);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}
