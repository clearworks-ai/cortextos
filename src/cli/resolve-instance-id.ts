import { resolveActiveInstance } from '../utils/resolve-active-instance.js';

/**
 * Resolve the target instance id for a CLI command.
 *
 * Priority (highest wins):
 *   1. explicit --instance <id> option
 *   2. CTX_INSTANCE_ID environment variable
 *   3. canonical-instance marker (~/.cortextos/state/ACTIVE_INSTANCE)
 *   4. 'default'
 *
 * Back-compat: with no marker present, a bare invocation (no option, no env)
 * still resolves to 'default' — resolveActiveInstance falls back to the value
 * we pass it, and never throws.
 */
export function resolveInstanceId(instance?: string): string {
  return instance || process.env.CTX_INSTANCE_ID || resolveActiveInstance('default');
}
