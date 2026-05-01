/**
 * hook-extract-facts.ts — PreCompact hook.
 *
 * Captures the session summary produced by Claude Code at compaction time
 * and appends it to the agent's canonical daily checkpoint markdown file at
 * ${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/${CTX_AGENT_NAME}/memory/YYYY-MM-DD.md
 *
 * Folded into the daily checkpoint (2026-05-01) — was previously writing to a
 * separate `state/<agent>/memory/facts/<date>.jsonl`. One file per session day,
 * not two. Daily checkpoint is the single source of mid-session and end-session
 * recall.
 *
 * Registered in settings.json under "PreCompact". Fires and returns immediately
 * — never blocks compaction.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadEnv, readStdin } from './index.js';

interface PreCompactPayload {
  session_id?: string;
  summary?: string;
  transcript?: string;
  turns?: Array<{ role: string; content: string }>;
}

/**
 * Extract topic keywords from a summary string.
 * Simple word-frequency approach — no LLM call, no external deps.
 * Exported for unit testing.
 */
export function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'that', 'this', 'these', 'those', 'it', 'its',
    'i', 'we', 'you', 'he', 'she', 'they', 'my', 'our', 'your', 'their',
    'not', 'no', 'so', 'if', 'then', 'than', 'as', 'also', 'just', 'now',
    'up', 'out', 'what', 'which', 'who', 'when', 'where', 'how', 'about',
    'after', 'before', 'into', 'through', 'during', 'each', 'some', 'any',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  const freq: Record<string, number> = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([word]) => word);
}

/**
 * Resolve the agent's canonical memory directory:
 *   ${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/agents/${CTX_AGENT_NAME}/memory
 * Falls back to runtime state dir if framework env is missing.
 */
function resolveMemoryDir(env: { agentName: string; ctxRoot: string }): string {
  const fwRoot = process.env.CTX_FRAMEWORK_ROOT;
  const org = process.env.CTX_ORG;
  if (fwRoot && org) {
    return join(fwRoot, 'orgs', org, 'agents', env.agentName, 'memory');
  }
  return join(env.ctxRoot, 'state', env.agentName, 'memory');
}

async function main(): Promise<void> {
  const env = loadEnv();

  try {
    const raw = await Promise.race([
      readStdin(),
      new Promise<string>(resolve => setTimeout(() => resolve(''), 10_000)),
    ]);
    let payload: PreCompactPayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { summary: raw.trim() };
      }
    }

    let summaryText = payload.summary || '';
    if (!summaryText && payload.turns && payload.turns.length > 0) {
      const lastAssistant = [...payload.turns].reverse().find(t => t.role === 'assistant');
      if (lastAssistant) summaryText = lastAssistant.content;
    }

    if (!summaryText || summaryText.trim().length < 20) return;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19) + ' UTC';
    const sessionId = payload.session_id || `session-${Date.now()}`;
    const keywords = extractKeywords(summaryText);
    const summary = summaryText.slice(0, 8000);

    const memoryDir = resolveMemoryDir(env);
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const checkpointFile = join(memoryDir, `${dateStr}.md`);

    const block = [
      '',
      `## Compact-time checkpoint — ${timeStr}`,
      `- session: ${sessionId}`,
      keywords.length > 0 ? `- keywords: ${keywords.slice(0, 10).join(', ')}` : '',
      '',
      summary,
      '',
    ].filter(line => line !== undefined).join('\n');

    appendFileSync(checkpointFile, block, 'utf-8');

  } catch {
    // Never fail — compaction must not be blocked
  }
}

main().catch(() => process.exit(0));
