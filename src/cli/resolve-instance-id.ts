import { resolveActiveInstance } from '../utils/active-instance.js';

/**
 * WS7 — shared instance-id resolution for CLI commands.
 *
 * Resolution order:
 *   1. explicit `--instance <id>` option value
 *   2. CTX_INSTANCE_ID environment variable
 *   3. ~/.cortextos/ACTIVE_INSTANCE marker file
 *   4. 'cortextos1' (ACTIVE_INSTANCE_FALLBACK)
 *
 * This replaces the historical final fallback of the literal 'default' — the
 * DEAD instance (frozen 2026-06-25). Bare lifecycle commands (`cortextos
 * restart <agent>` etc.) hit that dead tree and answered "Daemon is not
 * running" even though the fleet was healthy under cortextos1. Commands that
 * feed off this resolver: start/stop/restart/enable-agent/notify-agent/doctor
 * and status.
 *
 * NOTE (guardrail): src/daemon/* and src/hooks/* keep their own literal
 * 'default' fallbacks — PM2 and the daemon always set CTX_INSTANCE_ID
 * explicitly for child processes, so this resolver must not be wired there.
 *
 * Commander subcommands that still declare `.option('--instance <id>',
 * 'Instance ID', 'default')` bake the dead literal in as the option value;
 * adopting this resolver there (drop the option default, pass the option
 * value through resolveInstanceId) is the cutover wiring — a separate,
 * Josh-approved window. This module ships the behavior; it does not flip
 * those commands.
 */
export function resolveInstanceId(explicitInstance?: string): string {
  return explicitInstance || process.env.CTX_INSTANCE_ID || resolveActiveInstance();
}
