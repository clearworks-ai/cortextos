import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CronDefinition } from '../types/index.js';

export interface BannedCronPromptPattern {
  id: string;
  re: RegExp;
}

interface OverlayPatternEntry {
  id: string;
  source: string;
  flags?: string;
}

export interface BannedCronPromptMatch {
  name: string;
  patternId: string;
}

export const BANNED_CRON_PROMPT_PATTERNS: readonly BannedCronPromptPattern[] = [
  {
    id: 'full-human-task-list-telegram',
    re: /send\b[\s\S]{0,40}\b(full|entire|all|complete)\b[\s\S]{0,40}\b(human\s+)?task\s+list\b[\s\S]{0,40}\btelegram\b/i,
  },
] as const;

function ctxRoot(): string {
  return process.env.CTX_ROOT ?? process.cwd();
}

function overlayPath(): string {
  return join(ctxRoot(), 'state', 'cron-banned-patterns.json');
}

function isOverlayPatternEntry(value: unknown): value is OverlayPatternEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.source === 'string' &&
    (entry.flags === undefined || typeof entry.flags === 'string')
  );
}

function loadOverlayPatterns(): BannedCronPromptPattern[] {
  const path = overlayPath();
  if (!existsSync(path)) {
    return [];
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(raw)) {
      return [];
    }

    const patterns: BannedCronPromptPattern[] = [];
    for (const entry of raw) {
      if (!isOverlayPatternEntry(entry)) {
        continue;
      }

      try {
        patterns.push({
          id: entry.id,
          re: new RegExp(entry.source, entry.flags ?? ''),
        });
      } catch {
        // Ignore malformed overlay entries; the compiled floor still applies.
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

function allPatterns(): BannedCronPromptPattern[] {
  return [...BANNED_CRON_PROMPT_PATTERNS, ...loadOverlayPatterns()];
}

export function findBannedCronPrompts(crons: CronDefinition[]): BannedCronPromptMatch[] {
  const patterns = allPatterns();
  const matches: BannedCronPromptMatch[] = [];

  for (const cron of crons) {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(cron.prompt)) {
        matches.push({ name: cron.name, patternId: pattern.id });
        break;
      }
    }
  }

  return matches;
}

export function validateCronsPrompt(crons: CronDefinition[]): void {
  const [match] = findBannedCronPrompts(crons);
  if (!match) {
    return;
  }

  throw new Error(
    `Refusing to write cron "${match.name}": prompt matches banned pattern ` +
      `"${match.patternId}". This prompt was blocked to prevent a known Telegram-spam recurrence. ` +
      `Edit the prompt or update state/cron-banned-patterns.json.`
  );
}
