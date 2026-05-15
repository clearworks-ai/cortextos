/**
 * hook-tool-result-router.ts — PostToolUse hook.
 *
 * Forwards tool call + result preview to two destinations:
 *   1. dispatch-events stream (via logEvent → analytics/events/{agent}/{date}.jsonl)
 *      so the dashboard activity feed can render full output.
 *   2. Telegram (preview only, capped at ~1500 chars) so the user sees what
 *      Larry/Frank2/Codexer just ran within ~5s of execution.
 *
 * Trivial / high-noise tool calls are suppressed (bus heartbeat, log-event,
 * cron-fire, memory/state reads). The hook never blocks execution — it always
 * exits 0 within its 10s settings.json timeout regardless of failures.
 *
 * Implements Item 4 of .planning/larry-ux-parity-spec.md.
 */

import { readStdin, loadEnv } from './index.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';

const TELEGRAM_MAX = 1500;
const PREVIEW_MAX = 500;

interface HookPayload {
  tool_name: string;
  tool_input: any;
  tool_response?: any;
  tool_result?: any;
}

/**
 * Parse the PostToolUse payload. Claude Code documents the result field
 * inconsistently across versions ("tool_response" in newer builds,
 * "tool_result" in older). Accept both.
 */
function parsePostToolPayload(input: string): HookPayload {
  try {
    const parsed = JSON.parse(input);
    return {
      tool_name: parsed.tool_name || 'unknown',
      tool_input: parsed.tool_input || {},
      tool_response: parsed.tool_response,
      tool_result: parsed.tool_result,
    };
  } catch {
    return { tool_name: 'unknown', tool_input: {} };
  }
}

/**
 * Tools that fire constantly as part of bus housekeeping. Surfacing them
 * would drown the activity feed and rate-limit Telegram.
 */
function isTrivial(toolName: string, toolInput: any): boolean {
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '');
    if (/cortextos\s+bus\s+(update-heartbeat|log-event|update-cron-fire)/.test(cmd)) {
      return true;
    }
  }
  if (toolName === 'Read') {
    const path = String(toolInput?.file_path || '');
    if (/state\/current-mission\.txt$/.test(path)) return true;
    if (/MEMORY[^/]*\.md$/i.test(path)) return true;
  }
  return false;
}

/**
 * Pull a short human-readable description from tool_input. Mirrors the
 * style of formatToolSummary in index.ts but kept inline so the hook
 * stays self-contained and one-line per tool.
 */
function describeTool(toolName: string, toolInput: any): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = String(toolInput?.command || '').replace(/\s+/g, ' ').trim();
      return cmd.slice(0, 200);
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path = String(toolInput?.file_path || toolInput?.notebook_path || '');
      return path;
    }
    case 'Glob':
      return String(toolInput?.pattern || '');
    case 'Grep':
      return String(toolInput?.pattern || '');
    case 'WebFetch':
    case 'WebSearch':
      return String(toolInput?.url || toolInput?.query || '');
    case 'Task':
    case 'Agent':
      return String(toolInput?.description || toolInput?.subagent_type || '');
    default:
      return JSON.stringify(toolInput).slice(0, 200);
  }
}

/**
 * Extract a textual preview of the tool result. PostToolUse payloads vary by
 * tool — Bash gives stdout/stderr, Edit gives a diff or oldString/newString,
 * Read gives file content, etc. Returns { preview, totalLines }.
 */
function previewResult(toolName: string, result: any): { preview: string; totalLines: number } {
  if (result == null) return { preview: '', totalLines: 0 };

  let text = '';
  if (typeof result === 'string') {
    text = result;
  } else if (typeof result === 'object') {
    // Bash
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (stdout || stderr) {
      text = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
    } else if (typeof result.output === 'string') {
      text = result.output;
    } else if (typeof result.content === 'string') {
      text = result.content;
    } else if (Array.isArray(result.content)) {
      text = result.content
        .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
        .join('\n');
    } else if (typeof result.diff === 'string') {
      text = result.diff;
    } else {
      try {
        text = JSON.stringify(result);
      } catch {
        text = String(result);
      }
    }
  } else {
    text = String(result);
  }

  const totalLines = text ? text.split('\n').length : 0;
  const preview = text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text;
  return { preview, totalLines };
}

/**
 * Build the Telegram-bound message. Caps total length at TELEGRAM_MAX.
 */
function buildTelegramMessage(
  agentName: string,
  toolName: string,
  description: string,
  preview: string,
  totalLines: number,
  textLength: number,
): string {
  const header = `🔧 ${agentName} ran ${toolName}: ${description}`.slice(0, 400);
  const truncatedNote =
    textLength > preview.length
      ? `\n... see dashboard for full output (${totalLines} lines)`
      : '';

  let body = preview ? `output (first ${PREVIEW_MAX} chars):\n${preview}${truncatedNote}` : '';

  let full = body ? `${header}\n${body}` : header;
  if (full.length > TELEGRAM_MAX) {
    const remaining = TELEGRAM_MAX - header.length - 64; // leave room for tail note
    const trimmedPreview = preview.slice(0, Math.max(0, remaining));
    body = `output (truncated):\n${trimmedPreview}\n... see dashboard for full output (${totalLines} lines)`;
    full = `${header}\n${body}`;
    if (full.length > TELEGRAM_MAX) full = full.slice(0, TELEGRAM_MAX);
  }
  return full;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const payload = parsePostToolPayload(input);
  const { tool_name, tool_input } = payload;

  if (!tool_name || tool_name === 'unknown') return;
  if (isTrivial(tool_name, tool_input)) return;

  const env = loadEnv();
  const agentName = env.agentName || 'agent';
  const org = process.env.CTX_ORG || '';

  const result = payload.tool_response ?? payload.tool_result;
  const { preview, totalLines } = previewResult(tool_name, result);
  const description = describeTool(tool_name, tool_input);

  // Compute full text length so the "truncated" note is accurate.
  let textLength = 0;
  try {
    if (result != null) {
      if (typeof result === 'string') textLength = result.length;
      else if (typeof result === 'object') {
        const stdout = typeof (result as any).stdout === 'string' ? (result as any).stdout : '';
        const stderr = typeof (result as any).stderr === 'string' ? (result as any).stderr : '';
        if (stdout || stderr) textLength = stdout.length + stderr.length;
        else if (typeof (result as any).output === 'string') textLength = (result as any).output.length;
        else if (typeof (result as any).content === 'string') textLength = (result as any).content.length;
        else textLength = JSON.stringify(result).length;
      }
    }
  } catch {
    textLength = preview.length;
  }

  // 1. Activity feed (best-effort; never blocks).
  try {
    const paths = resolvePaths(agentName, env.ctxRoot.split('/').pop() || 'default', org);
    logEvent(paths, agentName, org, 'agent_activity', 'tool_result', 'info', {
      tool: tool_name,
      description,
      preview,
      total_lines: totalLines,
      total_chars: textLength,
    });
  } catch {
    // Activity feed is best-effort.
  }

  // 2. Telegram (best-effort; never blocks).
  if (!env.botToken || !env.chatId) return;

  const message = buildTelegramMessage(
    agentName,
    tool_name,
    description,
    preview,
    totalLines,
    textLength,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://api.telegram.org/bot${env.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
  } catch {
    // Never fail — PostToolUse must not block the agent.
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => process.exit(0));
