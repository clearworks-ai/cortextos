/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction —
 * but ONLY for agents that opt in via `emit_system_telegram_pings: true` in
 * their config.json. All other agents log a bus event instead (silence-pings).
 * Never blocks compaction: 5s abort + catch-all.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadEnv } from './index.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

/**
 * Read emit_system_telegram_pings from the agent's config.json.
 * Mirrors readMaxCrashesPerDay in hook-crash-alert.ts (hook processes inherit
 * CTX_AGENT_DIR from the agent PTY env — src/pty/agent-pty.ts:77).
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
 * Best-effort bus-event record of a suppressed compaction notice, so the
 * signal is preserved off-Telegram. Never throws.
 */
export function logSuppressedCompactNotice(agentName: string): void {
  try {
    const instanceId = process.env.CTX_INSTANCE_ID || 'default';
    const org = process.env.CTX_ORG || 'unknown';
    const paths = resolvePaths(agentName, instanceId, process.env.CTX_ORG);
    logEvent(paths, agentName, org, 'agent_activity', 'system_ping_suppressed', 'info', {
      kind: 'compact_notice',
    });
  } catch {
    /* best-effort — suppression logging must never block compaction */
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  // Per-agent gate FIRST (silence-pings): background agents are
  // silent by default; only opted-in agents may ping Telegram.
  if (!readEmitSystemPingsFlag(process.env.CTX_AGENT_DIR)) {
    logSuppressedCompactNotice(env.agentName || 'agent');
    return;
  }

  if (!env.botToken || !env.chatId) return;

  const agentName = env.agentName || 'agent';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: `[${agentName}] Context compacting... resuming shortly`,
      }),
      signal: controller.signal,
    });
  } catch {
    // Never fail — compaction must not be blocked
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
