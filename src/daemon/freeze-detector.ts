import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';

// Detection of "frozen permission dialog" — a native Claude Code permission
// prompt that slipped past hook-permission-telegram (hook disabled, hook
// crashed, or prompt originated from a pre-hook code path). Visible in PTY
// output as a numbered-option menu but no Telegram alert was sent.
//
// Per 2026-04-20 Sage audit:
//   - Signatures are restricted to numbered-option patterns only.
//     Phrases like "Do you want to proceed" were dropped: too broad and
//     liable to match documentation strings or agent explanations.
//   - Flag files live in a centralized directory so `list-frozen-agents`
//     is a single readdir rather than a scan across every agent state dir.
//   - v1 is alert-only. Auto-recovery (inject "2\n" to deny, hard-restart)
//     is deferred to v2 — a loose signature match incorrectly auto-denying
//     a legitimate prompt is worse than a false-silence on a real freeze.

const PERMISSION_SIGNATURES: RegExp[] = [
  /❯\s*1\.\s*Yes\b/,
  /❯\s*1\.\s*No\b/,
  /❯\s*2\.\s*No\b/,
  /❯\s*1\.\s*Allow\b/,
  /❯\s*2\.\s*Deny\b/,
];

export interface FrozenState {
  detected_at: number;
  prompt_excerpt: string;
  agent_name: string;
}

export interface DetectorInput {
  agentName: string;
  recentBuffer: string;
  lastSubstantiveOutputTs: number;
  nowTs: number;
  thresholdSec: number;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export function findPermissionSignature(
  text: string,
): { matched: boolean; excerpt: string } {
  const cleaned = stripAnsi(text);
  for (const sig of PERMISSION_SIGNATURES) {
    const match = cleaned.match(sig);
    if (match && typeof match.index === 'number') {
      const start = Math.max(0, match.index - 200);
      const end = Math.min(cleaned.length, match.index + 300);
      return { matched: true, excerpt: cleaned.slice(start, end).trim() };
    }
  }
  return { matched: false, excerpt: '' };
}

export function detectFrozenPermission(input: DetectorInput): FrozenState | null {
  const { matched, excerpt } = findPermissionSignature(input.recentBuffer);
  if (!matched) return null;
  const secondsSinceOutput = (input.nowTs - input.lastSubstantiveOutputTs) / 1000;
  if (secondsSinceOutput < input.thresholdSec) return null;
  return {
    detected_at: Math.floor(input.nowTs / 1000),
    prompt_excerpt: excerpt,
    agent_name: input.agentName,
  };
}

export function frozenFlagDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'frozen-permissions');
}

export function frozenFlagPath(ctxRoot: string, agentName: string): string {
  return join(frozenFlagDir(ctxRoot), `${agentName}.flag`);
}

export function writeFrozenFlag(ctxRoot: string, state: FrozenState): void {
  try {
    atomicWriteSync(frozenFlagPath(ctxRoot, state.agent_name), JSON.stringify(state));
  } catch {
    // Best-effort — never throw from the freeze detector
  }
}

export function clearFrozenFlag(ctxRoot: string, agentName: string): void {
  try {
    unlinkSync(frozenFlagPath(ctxRoot, agentName));
  } catch {
    // ENOENT is common and safe
  }
}

export function listFrozenAgents(ctxRoot: string): FrozenState[] {
  const dir = frozenFlagDir(ctxRoot);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.flag'));
  } catch {
    return [];
  }
  const out: FrozenState[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<FrozenState>;
      if (
        typeof parsed.agent_name === 'string' &&
        typeof parsed.detected_at === 'number' &&
        typeof parsed.prompt_excerpt === 'string'
      ) {
        out.push(parsed as FrozenState);
      }
    } catch {
      // Skip corrupt flag files
    }
  }
  return out;
}
