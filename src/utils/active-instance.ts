import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * WS7 — ACTIVE_INSTANCE marker resolution.
 *
 * The historical code default was the literal instance id 'default', but that
 * instance is DEAD (frozen 2026-06-25) while `cortextos1` is the LIVE canonical
 * instance every agent actually runs under. Bare `cortextos` commands therefore
 * hit a frozen state tree and reported "Daemon is not running" — the recurring
 * trap documented in the fleet-consolidation grounding.
 *
 * Resolution order for callers that have no explicit instance id:
 *   1. ~/.cortextos/ACTIVE_INSTANCE marker file (plain text, first line, trimmed)
 *      — only honored when the value passes the instance-id validation regex.
 *   2. ACTIVE_INSTANCE_FALLBACK ('cortextos1').
 *
 * This function NEVER throws: all filesystem access is wrapped in try/catch
 * (same posture as writeStopMarker in src/cli/stop.ts) and invalid marker
 * content falls back silently. It is safe to call from any CLI entry point.
 *
 * NOTE: src/daemon/* and src/hooks/* intentionally keep their literal
 * 'default' fallbacks — PM2 / the daemon set CTX_INSTANCE_ID explicitly for
 * every child process, so the marker never applies there. Do not sweep those.
 */

/** Canonical live instance used when no marker/env/arg supplies an id. */
export const ACTIVE_INSTANCE_FALLBACK = 'cortextos1';

// Mirrors AGENT_NAME_REGEX in src/utils/validate.ts (validateInstanceId), but
// tested non-throwing here so a corrupt marker file can never crash a command.
const INSTANCE_ID_REGEX = /^[a-z0-9_-]+$/;

/** Absolute path of the ACTIVE_INSTANCE marker file. */
export function getActiveInstanceMarkerPath(): string {
  return join(homedir(), '.cortextos', 'ACTIVE_INSTANCE');
}

/**
 * Resolve the active instance id from the marker file, falling back to
 * ACTIVE_INSTANCE_FALLBACK. Never throws.
 */
export function resolveActiveInstance(): string {
  try {
    const raw = readFileSync(getActiveInstanceMarkerPath(), 'utf-8');
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (firstLine && INSTANCE_ID_REGEX.test(firstLine)) {
      return firstLine;
    }
  } catch {
    // Missing file, permission error, or unreadable content — fall back.
  }
  return ACTIVE_INSTANCE_FALLBACK;
}
