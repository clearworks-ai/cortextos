
/**
 * hook-permission-telegram.ts - Blocking PermissionRequest hook
 * Forwards permission prompts to Telegram with Approve/Deny inline buttons.
 * Polls for a response file written by fast-checker when the user taps a button.
 * Timeout: 1800s (30 min, deny by default).
 *
 * Cron-originated calls (detected via the .cron-active marker written by
 * AgentManager.onFire) are DENIED IMMEDIATELY without sending a Telegram
 * message or waiting 30 minutes. This fixes the stall where an autonomous cron
 * injected into the main PTY trips a permission rule and blocks the entire
 * session for 30 minutes before auto-denying.
 *
 * The deny-fast path emits a bus event `cron_permission_denied` so the digest
 * can surface "cron X needs a permission it can't get — refactor it to run in
 * a --skip-permissions worker". The interactive Telegram (TIMED OUT message)
 * is suppressed for cron denials; Josh sees the denial via the digest tab, not
 * a raw late-night buzz.
 */

import { TelegramAPI } from '../telegram/api';
import {
  readStdin,
  parseHookInput,
  loadEnv,
  outputDecision,
  generateId,
  waitForResponseFile,
  formatToolSummary,
  isClaudeDirOperation,
  sanitizeCodeBlock,
  buildPermissionKeyboard,
  cleanupResponseFile,
} from './index';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';

/**
 * Check whether the agent is currently in a cron-originated turn by reading
 * the .cron-active marker written by AgentManager.onFire.
 *
 * Returns the cron name if the marker is present AND not expired; null otherwise.
 * Expired markers (past their expiresAt) are treated as absent — a crashed daemon
 * process could leave a stale marker behind, and we must not deny interactive
 * approvals indefinitely.
 */
function readCronActive(stateDir: string): { cronName: string; firedAt: string } | null {
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

/**
 * Emit a `cron_permission_denied` bus event via `cortextos bus log-event` so
 * the orchestrator digest can surface which cron+tool needs a privilege it can't
 * have in the interactive main session. Best-effort: failures are swallowed so
 * a broken bus never blocks the deny-fast path.
 */
function emitCronPermissionDeniedEvent(opts: {
  agentName: string;
  cronName: string;
  toolName: string;
  firedAt: string;
}): void {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const cliPath = frameworkRoot ? join(frameworkRoot, 'dist', 'cli.js') : null;
  const meta = JSON.stringify({
    cronName: opts.cronName,
    toolName: opts.toolName,
    firedAt: opts.firedAt,
    reason: 'auto-denied: cron-originated, no human present',
  });
  try {
    if (cliPath) {
      execFile(
        process.execPath,
        [cliPath, 'bus', 'log-event', 'action', 'cron_permission_denied', 'warn', '--meta', meta],
        { timeout: 5_000 },
        () => { /* fire-and-forget */ },
      );
    } else {
      execFile(
        'cortextos',
        ['bus', 'log-event', 'action', 'cron_permission_denied', 'warn', '--meta', meta],
        { timeout: 5_000 },
        () => { /* fire-and-forget */ },
      );
    }
  } catch { /* best-effort */ }
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  // ExitPlanMode and AskUserQuestion are handled by other hooks
  if (tool_name === 'ExitPlanMode' || tool_name === 'AskUserQuestion') {
    process.exit(0);
  }

  const env = loadEnv();

  if (!env.botToken || !env.chatId) {
    outputDecision('deny', 'No Telegram credentials configured for remote approval');
    return;
  }

  // Auto-approve .claude/ directory writes
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision('allow');
    return;
  }

  // Deny-fast for cron-originated permission requests.
  // When the daemon's cron scheduler fires a cron, it writes a .cron-active
  // marker in the agent's state dir immediately before injecting the cron
  // prompt. If a tool call within that cron turn reaches this hook, we deny
  // IMMEDIATELY (no 30-min wait, no interactive Telegram) and emit a bus event
  // so the digest can surface which cron+tool combination needs to be refactored
  // into a --skip-permissions worker. This prevents the main session from being
  // blocked for 30 minutes on an autonomous cron that nobody can approve.
  const cronActive = readCronActive(env.stateDir);
  if (cronActive !== null) {
    emitCronPermissionDeniedEvent({
      agentName: env.agentName,
      cronName: cronActive.cronName,
      toolName: tool_name,
      firedAt: cronActive.firedAt,
    });
    outputDecision(
      'deny',
      `auto-denied: cron-originated (${cronActive.cronName}), no human present — refactor to a --skip-permissions worker`,
    );
    return;
  }

  // Deny-fast for worker-session permission requests (see isWorkerSession).
  if (isWorkerSession()) {
    outputDecision(
      'deny',
      'auto-denied: worker-session (CTX_WORKER=1), no human present — refactor to a --skip-permissions worker',
    );
    return;
  }

  // Build human-readable summary
  const summary = formatToolSummary(tool_name, tool_input);

  // Generate unique ID
  const uniqueId = generateId();
  mkdirSync(env.stateDir, { recursive: true });
  const responseFile = join(env.stateDir, `hook-response-${uniqueId}.json`);

  // Register cleanup
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  // Build message
  let message = `PERMISSION REQUEST\nAgent: ${env.agentName}\nTool: ${tool_name}\n\n\`\`\`\n${sanitizeCodeBlock(summary)}\n\`\`\``;

  // Truncate if over limit
  if (message.length > 3800) {
    message = message.slice(0, 3800) + '...(truncated)';
  }

  const keyboard = buildPermissionKeyboard(uniqueId);
  const api = new TelegramAPI(env.botToken);

  try {
    await api.sendMessage(env.chatId, message, keyboard);
  } catch {
    outputDecision('deny', 'Failed to send permission request to Telegram');
    return;
  }

  // Poll for response (30 min timeout)
  const TIMEOUT_MS = 1800 * 1000;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);

  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || 'deny';
      if (decision === 'allow') {
        outputDecision('allow');
      } else {
        outputDecision('deny', 'Denied by user via Telegram');
      }
    } catch {
      outputDecision('deny', 'Invalid response file');
    }
  } else {
    // Timeout — only fires for genuinely interactive (non-cron) sessions.
    // Cron-originated requests are denied-fast above (before the Telegram send),
    // so this path is only reached when a human-in-the-loop approve was
    // legitimately awaited and nobody responded within 30 minutes.
    try {
      await api.sendMessage(
        env.chatId,
        `Permission request TIMED OUT (auto-denied): ${tool_name}`,
      );
    } catch {
      // Ignore notification failure
    }
    outputDecision('deny', 'Timed out waiting for Telegram approval (30m)');
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hook-permission-telegram error: ${err}\n`);
    outputDecision('deny', `Hook error: ${err}`);
  });
}
