import { resolveInstanceIdChain } from '../utils/resolve-active-instance.js';

/**
 * Resolve the target instance id for a CLI command.
 *
 * Thin CLI-facing wrapper over the ONE shared resolver chain
 * (resolveInstanceIdChain in utils/resolve-active-instance.ts) so the CLI,
 * the daemon, and the bus/agent env path can never disagree about which
 * instance is canonical.
 *
 * Priority (highest wins):
 *   1. explicit --instance <id> option
 *   2. CTX_INSTANCE_ID environment variable
 *   3. canonical-instance marker (~/.cortextos/state/ACTIVE_INSTANCE)
 *   4. 'default'
 *
 * Back-compat: with no marker present, a bare invocation (no option, no env)
 * still resolves to 'default' — the shared chain falls back gracefully and
 * never throws.
 */
export function resolveInstanceId(instance?: string): string {
  return resolveInstanceIdChain(instance);
}
