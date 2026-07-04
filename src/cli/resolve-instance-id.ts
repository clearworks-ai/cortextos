import { resolveActiveInstance } from '../utils/resolve-active-instance.js';

/**
 * Resolve the effective instance id for a CLI command.
 *
 * Priority (highest to lowest):
 *   1. explicit --instance option
 *   2. CTX_INSTANCE_ID env var
 *   3. active-instance marker file (~/.cortextos/state/ACTIVE_INSTANCE)
 *   4. literal 'default' (legacy back-compat when no marker exists)
 *
 * Steps 3+4 are handled by resolveActiveInstance('default'), which returns the
 * marker's contents when present and 'default' otherwise.
 */
export function resolveInstanceId(instance?: string): string {
  return instance || process.env.CTX_INSTANCE_ID || resolveActiveInstance('default');
}
