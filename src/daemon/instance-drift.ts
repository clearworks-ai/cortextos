import { resolveActiveInstance } from '../utils/resolve-active-instance.js';

/**
 * M7 boot-pin drift detection (RW-2, third split-brain leg).
 *
 * The daemon resolves its instance id ONCE at boot (via the shared resolver
 * chain) and is pinned to that value for its whole lifetime — its ctxRoot,
 * IPC socket, registry, crons and heartbeats all live under
 * ~/.cortextos/<bootInstanceId>/. The ACTIVE_INSTANCE marker, however, can be
 * rewritten at any time (`cortextos instance --set …`), and bare CLI calls
 * resolve the marker *now*. If the marker drifts away from the daemon's boot
 * value, CLI ops silently target a different instance tree than the live
 * daemon writes — the exact "status running ≠ functioning" /
 * "not in registry" split-brain class.
 *
 * This check makes the daemon side of that split loud: it compares the
 * current marker against the boot-pinned instance id and returns a warning
 * message when they diverge (null when in agreement or no marker exists).
 * Pure + side-effect free so it is trivially testable; the daemon calls it
 * on a fixed cadence and logs the result.
 */
export function detectInstanceMarkerDrift(bootInstanceId: string): string | null {
  const markerNow = resolveActiveInstance('');
  if (!markerNow || markerNow === bootInstanceId) return null;
  return (
    `INSTANCE MARKER DRIFT: daemon booted pinned to instance '${bootInstanceId}' but ` +
    `~/.cortextos/state/ACTIVE_INSTANCE now reads '${markerNow}'. Bare CLI calls resolve ` +
    `'${markerNow}' while this daemon keeps reading/writing '${bootInstanceId}' ` +
    `(registry, crons, sockets, heartbeats). Either restart the daemon under the new ` +
    `marker or reset it: cortextos instance --set ${bootInstanceId}`
  );
}

/** Cadence for the daemon's marker-drift re-warn loop. */
export const INSTANCE_MARKER_DRIFT_CHECK_MS = 60_000;
