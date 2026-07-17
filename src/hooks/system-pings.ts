import { readFileSync } from 'fs';
import { join } from 'path';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

export type SuppressedSystemPingKind = 'compact_notice' | 'lifecycle_notice';

/**
 * Read emit_system_telegram_pings from the agent's config.json.
 * Returns false (silent) on missing dir, missing file, malformed JSON, or
 * absent/non-true flag.
 */
export function readEmitSystemPingsFlag(agentDir: string | undefined): boolean {
  if (!agentDir) return false;
  try {
    const cfg = JSON.parse(
      readFileSync(join(agentDir, 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    return cfg.emit_system_telegram_pings === true;
  } catch {
    return false;
  }
}

/**
 * Best-effort bus-event record of a suppressed system ping. Never throws.
 */
export function logSuppressedSystemPing(
  agentName: string,
  kind: SuppressedSystemPingKind,
  type?: string,
): void {
  try {
    const instanceId = process.env.CTX_INSTANCE_ID || 'default';
    const org = process.env.CTX_ORG || 'unknown';
    const paths = resolvePaths(agentName, instanceId, process.env.CTX_ORG);
    const metadata: { kind: SuppressedSystemPingKind; type?: string } = { kind };
    if (type) metadata.type = type;
    logEvent(paths, agentName, org, 'agent_activity', 'system_ping_suppressed', 'info', metadata);
  } catch {
    /* best-effort — suppression logging must never block the hook */
  }
}
