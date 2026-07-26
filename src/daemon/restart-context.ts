import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ConversationBufferEntry } from '../types/index.js';
import { loadBuffer } from './conversation-buffer.js';

const MAX_MISSION_CHARS = 600;

function truncateMissionText(text: string, maxChars: number = MAX_MISSION_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function deriveMissionFromTrailingInbound(
  entries: ConversationBufferEntry[],
  agentName: string,
  maxChars: number = MAX_MISSION_CHARS,
): string {
  const trailingInbound: string[] = [];

  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const entry = entries[idx];
    const isInboundTelegram = entry.sender !== agentName && entry.via === 'telegram';
    if (!isInboundTelegram) {
      break;
    }

    const trimmedContent = entry.content.trim();
    if (trimmedContent) {
      trailingInbound.push(trimmedContent);
    }
  }

  if (trailingInbound.length === 0) {
    return '';
  }

  return truncateMissionText(trailingInbound.reverse().join('\n\n'), maxChars);
}

export function ensureMissionAnchorFromBuffer(agentDir: string, ctxRoot: string, agentName: string): void {
  try {
    const missionPath = join(agentDir, 'state', 'current-mission.txt');
    if (existsSync(missionPath)) {
      return;
    }

    const mission = deriveMissionFromTrailingInbound(loadBuffer(ctxRoot, agentName), agentName);
    if (!mission) {
      return;
    }

    mkdirSync(join(agentDir, 'state'), { recursive: true });
    writeFileSync(missionPath, mission, 'utf-8');
  } catch {
    // Buffer/mission recovery is best-effort and must never block restart handling.
  }
}

export function findFreshRecentHandoffDoc(
  handoffsDir: string,
  cutoffMs: number,
  ctxHandoffFiredAt: number,
): string | null {
  if (!existsSync(handoffsDir)) {
    return null;
  }

  const recent = readdirSync(handoffsDir)
    .filter((fileName) => fileName.startsWith('handoff-') && fileName.endsWith('.md'))
    .map((fileName) => {
      const fullPath = join(handoffsDir, fileName);
      return {
        fullPath,
        mtimeMs: statSync(fullPath).mtimeMs,
      };
    })
    .filter(({ mtimeMs }) => {
      if (mtimeMs < cutoffMs) {
        return false;
      }
      if (ctxHandoffFiredAt > 0 && mtimeMs < ctxHandoffFiredAt) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return recent[0]?.fullPath ?? null;
}
