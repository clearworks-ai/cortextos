import { homedir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import { validateInstanceId } from './validate.js';

/**
 * Path to the canonical-instance marker file.
 *
 * The marker lives at the TOP LEVEL of ~/.cortextos — NOT nested under an
 * instance directory (~/.cortextos/{instance}/...). It has to be readable
 * *before* the active instance is known, so it cannot itself be keyed by the
 * instance it is trying to name.
 *
 *   ~/.cortextos/state/ACTIVE_INSTANCE
 *
 * Its sole content is the id of the instance that should be treated as
 * canonical when no explicit instance was requested (no --instance flag and no
 * CTX_INSTANCE_ID env var). This lets an operator promote e.g. `cortextos1` to
 * be the default target of bare invocations without editing every call site.
 */
export function activeInstanceMarkerPath(): string {
  return join(homedir(), '.cortextos', 'state', 'ACTIVE_INSTANCE');
}

/**
 * Resolve the canonical active instance from the marker file.
 *
 * Reads ~/.cortextos/state/ACTIVE_INSTANCE, trims surrounding whitespace, and
 * validates the contents via the same validateInstanceId() rule the rest of
 * the codebase uses (/^[a-z0-9_-]+$/). When the marker is present AND valid,
 * its contents are returned. In every other case — the file is missing, empty,
 * whitespace-only, holds an invalid id, or cannot be read for any reason — the
 * provided fallback is returned.
 *
 * This function NEVER throws. It is called on the no-instance resolution path
 * (see resolve-instance-id.ts), so a corrupt or missing marker must degrade
 * gracefully to the historical default rather than break every bare CLI call.
 *
 * @param fallback The instance id to return when no valid marker exists.
 *                 Defaults to 'default' to preserve back-compat: with no marker
 *                 present, bare invocations still resolve to 'default'.
 */
export function resolveActiveInstance(fallback = 'default'): string {
  let raw: string;
  try {
    raw = readFileSync(activeInstanceMarkerPath(), 'utf-8');
  } catch {
    // Missing file or any fs/permission error -> historical default.
    return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    // Empty / whitespace-only marker -> historical default.
    return fallback;
  }

  try {
    validateInstanceId(trimmed);
  } catch {
    // Marker present but holds an invalid id -> historical default rather than
    // propagating a value that would fail validation downstream.
    return fallback;
  }

  return trimmed;
}
