import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';

export interface CronActiveInfo {
  cronName: string;
  firedAt: string;
}

/**
 * Check whether the agent is currently in a cron-originated turn by reading
 * the .cron-active marker written by AgentManager.onFire.
 *
 * Returns the cron name if the marker is present AND not expired; null otherwise.
 * Expired markers (past their expiresAt) are treated as absent — a crashed daemon
 * process could leave a stale marker behind, and we must not deny interactive
 * approvals indefinitely.
 */
export function readCronActive(stateDir: string): CronActiveInfo | null {
  const markerPath = join(stateDir, '.cron-active');
  if (!existsSync(markerPath)) return null;
  try {
    const payload = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      cronName?: string;
      firedAt?: string;
      expiresAt?: number;
    };
    const now = Date.now();
    if (payload.expiresAt !== undefined && now > payload.expiresAt) {
      // Stale / expired — treat as absent. Do NOT unlink here; the daemon
      // cleanup (onFire finally block) owns the file lifecycle.
      return null;
    }
    if (!payload.cronName) return null;
    return { cronName: payload.cronName, firedAt: payload.firedAt ?? '' };
  } catch {
    return null;
  }
}

/**
 * Worker-session detection. Worker PTYs (comms-check, transcript-scanner,
 * meeting-brief pages, etc.) launch with CTX_WORKER=1 (set in
 * src/pty/agent-pty.ts). They have no human attached — identical to cron in
 * that nobody can approve — so permission prompts must deny-fast instead of
 * forwarding a live Approve/Deny to Telegram and hanging 30 minutes.
 */
export function isWorkerSession(): boolean {
  return process.env.CTX_WORKER === '1';
}

export type DenyFastResult =
  | { deny: false }
  | { deny: true; source: 'cron'; reason: string; cronName: string; firedAt: string }
  | { deny: true; source: 'worker'; reason: string };

/**
 * Single decision point for "should this hook suppress Telegram and take its
 * safe non-interactive default?". Order matters and mirrors
 * hook-permission-telegram main(): cron marker first, then worker env.
 */
export function shouldDenyFast(stateDir: string): DenyFastResult {
  const cronActive = readCronActive(stateDir);
  if (cronActive !== null) {
    return {
      deny: true,
      source: 'cron',
      reason: `auto-suppressed: cron-originated (${cronActive.cronName}), no human present`,
      cronName: cronActive.cronName,
      firedAt: cronActive.firedAt,
    };
  }
  if (isWorkerSession()) {
    return {
      deny: true,
      source: 'worker',
      reason: 'auto-suppressed: worker-session (CTX_WORKER=1), no human present',
    };
  }
  return { deny: false };
}

/**
 * JSON line a PreToolUse hook prints to stdout to BLOCK the pending tool call
 * and hand `reason` back to Claude so it continues autonomously instead of
 * hanging on a question nobody can answer. Emits BOTH the legacy top-level
 * fields and the modern hookSpecificOutput form for Claude Code version safety.
 */
export function buildPreToolUseDenyOutput(reason: string): string {
  return JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

export interface TelegramSuppressedEventOpts {
  hook: string;
  toolName: string;
  source: 'cron' | 'worker';
  cronName?: string;
  firedAt?: string;
}

export function emitTelegramSuppressedEvent(opts: TelegramSuppressedEventOpts): void {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const cliPath = frameworkRoot ? join(frameworkRoot, 'dist', 'cli.js') : null;
  const meta = JSON.stringify({
    hook: opts.hook,
    toolName: opts.toolName,
    source: opts.source,
    cronName: opts.cronName,
    firedAt: opts.firedAt,
    reason: 'telegram suppressed: autonomous session, no human present',
  });
  try {
    if (cliPath) {
      execFile(
        process.execPath,
        [cliPath, 'bus', 'log-event', 'action', 'worker_telegram_suppressed', 'warn', '--meta', meta],
        { timeout: 5_000 },
        () => { /* fire-and-forget */ },
      );
    } else {
      execFile(
        'cortextos',
        ['bus', 'log-event', 'action', 'worker_telegram_suppressed', 'warn', '--meta', meta],
        { timeout: 5_000 },
        () => { /* fire-and-forget */ },
      );
    }
  } catch { /* best-effort */ }
}
