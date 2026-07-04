import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { validateInstanceId } from './validate.js';

/**
 * Path to the active-instance marker file.
 *
 * It lives at the TOP LEVEL of ~/.cortextos (NOT nested under any
 * ~/.cortextos/{instance}/ directory) so it can be read before we know which
 * instance we are resolving to. Its single-line contents name the instance the
 * fleet should resolve to when no instance is passed explicitly (via option or
 * CTX_INSTANCE_ID).
 *
 * WHY THIS EXISTS: the literal string 'default' is the historical fallback, but
 * on a consolidated machine the ONLY live instance is 'cortextos1'; 'default'
 * points at a dead root. Any command that forgets --instance silently resolves
 * to that dead root. The marker lets a machine declare its live instance ONCE so
 * bare commands resolve to the real fleet instead of the trap.
 *
 * This is the CODE half only. Writing the marker on the live machine is a
 * Josh-gated prod cutover step and is deliberately NOT done here.
 */
export function activeInstanceMarkerPath(): string {
  return join(homedir(), '.cortextos', 'state', 'ACTIVE_INSTANCE');
}

/**
 * Resolve the active instance for the "no instance specified" case.
 *
 * Resolution order for a bare (no-arg) resolution is handled by callers, which
 * generally check an explicit option and CTX_INSTANCE_ID FIRST, then fall back
 * to this function. This function itself only decides between the marker and the
 * documented fallback:
 *
 *   1. If the marker file exists and holds a valid instance id, return it.
 *   2. Otherwise return `fallback` (default 'default') — preserving legacy
 *      behavior on machines/tests that have no marker. BACK-COMPAT.
 *
 * A marker whose contents are empty or invalid (fails validateInstanceId) is
 * ignored gracefully and the fallback is returned, so a corrupt marker can
 * never break resolution or open a path-traversal vector.
 *
 * NOTE: this reads the marker fresh on every call (no caching). Resolution
 * happens rarely (process/CLI startup) and the marker changes only during a
 * deliberate cutover, so freshness beats a stale cache.
 */
export function resolveActiveInstance(fallback: string = 'default'): string {
  try {
    const markerPath = activeInstanceMarkerPath();
    if (existsSync(markerPath)) {
      const contents = readFileSync(markerPath, 'utf-8').trim();
      if (contents) {
        try {
          validateInstanceId(contents);
          return contents;
        } catch {
          // Corrupt/invalid marker contents — fall through to the fallback
          // rather than propagating an error into every resolution site.
        }
      }
    }
  } catch {
    // Any fs error (permissions, race on delete, etc.) must not break
    // resolution — degrade to the documented fallback.
  }
  return fallback;
}
