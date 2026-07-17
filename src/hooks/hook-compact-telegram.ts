/**
 * hook-compact-telegram.ts — PreCompact hook.
 * Sends a Telegram notification when Claude Code begins context compaction —
 * but ONLY for agents that opt in via `emit_system_telegram_pings: true` in
 * their config.json. All other agents log a bus event instead (silence-pings).
 * Never blocks compaction: 5s abort + catch-all.
 */
import { loadEnv } from './index.js';
import { logSuppressedSystemPing, readEmitSystemPingsFlag } from './system-pings.js';

export { readEmitSystemPingsFlag } from './system-pings.js';

/**
 * Best-effort bus-event record of a suppressed compaction notice, so the
 * signal is preserved off-Telegram. Never throws.
 */
export function logSuppressedCompactNotice(agentName: string): void {
  logSuppressedSystemPing(agentName, 'compact_notice');
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
