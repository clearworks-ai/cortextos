import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index.js';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-prompt-validator-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }

  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors in tempdirs.
  }
});

function makeCron(prompt: string, name = 'heartbeat'): CronDefinition {
  return {
    name,
    prompt,
    schedule: '6h',
    enabled: true,
    created_at: '2026-07-03T00:00:00.000Z',
  };
}

async function importValidator() {
  return import('../../../src/utils/cron-prompt-validator.js');
}

const LEAK_PROMPT =
  'cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; ' +
  'TASK_ID=$(cortextos bus create-task "Cron: heartbeat" --desc "Scheduled cron run" 2>/dev/null); ' +
  'cortextos bus update-task $TASK_ID in_progress 2>/dev/null; ' +
  'Read HEARTBEAT.md and follow its instructions. Update heartbeat, check inbox, run fleet health check across all 3 repos.';

const COMPLETE_PROMPT =
  'cortextos bus update-cron-fire usage-audit --interval 1d 2>/dev/null; ' +
  'TASK_ID=$(cortextos bus create-task "Cron: usage-audit" --desc "Scheduled cron run" 2>/dev/null); ' +
  'cortextos bus update-task $TASK_ID in_progress 2>/dev/null; ' +
  'cortextos bus complete-task $TASK_ID 2>/dev/null; Run the usage audit.';

const PASSIVE_PROMPT =
  'cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; ' +
  'cortextos bus log-event cron-fired heartbeat 2>/dev/null; ' +
  'Read HEARTBEAT.md and follow its instructions.';

describe('cron prompt validator', () => {
  it('findBannedCronPrompts reports the compiled-in banned prompt floor', async () => {
    const { findBannedCronPrompts } = await importValidator();

    expect(
      findBannedCronPrompts([makeCron('Send the full HUMAN task list via Telegram.')])
    ).toEqual([
      {
        name: 'heartbeat',
        patternId: 'full-human-task-list-telegram',
      },
    ]);
  });

  it('enforces overlay patterns from state/cron-banned-patterns.json', async () => {
    const { validateCronsPrompt } = await importValidator();
    const stateDir = join(tmpRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'cron-banned-patterns.json'),
      JSON.stringify([{ id: 'custom-overlay', source: 'dangerous\\s+summary', flags: 'i' }]),
      'utf-8'
    );

    expect(() =>
      validateCronsPrompt([makeCron('Send a dangerous summary to the dashboard.')])
    ).toThrow(/custom-overlay/);
  });

  it('ignores malformed overlays while still enforcing the compiled floor', async () => {
    const { findBannedCronPrompts, validateCronsPrompt } = await importValidator();
    const stateDir = join(tmpRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'cron-banned-patterns.json'), '{ not valid json', 'utf-8');

    expect(() =>
      validateCronsPrompt([makeCron('Routine daily summary for the dashboard.')])
    ).not.toThrow();
    expect(
      findBannedCronPrompts([makeCron('Send the full human task list via Telegram.')])
    ).toHaveLength(1);
  });
});

describe('cron task-lifecycle leak pattern', () => {
  it('rejects a leaky cron prompt and exposes the reusable predicate', async () => {
    const {
      CRON_TASK_LEAK_PATTERN_ID,
      findBannedCronPrompts,
      isCronTaskLeakPrompt,
      validateCronsPrompt,
    } = await importValidator();

    expect(isCronTaskLeakPrompt(LEAK_PROMPT)).toBe(true);
    expect(() => validateCronsPrompt([makeCron(LEAK_PROMPT)])).toThrow(/cron-task-leak-no-complete/);
    expect(findBannedCronPrompts([makeCron(LEAK_PROMPT)])).toEqual([
      {
        name: 'heartbeat',
        patternId: CRON_TASK_LEAK_PATTERN_ID,
      },
    ]);
  });

  it('allows create plus complete in the same prompt', async () => {
    const { findBannedCronPrompts, isCronTaskLeakPrompt, validateCronsPrompt } =
      await importValidator();

    expect(isCronTaskLeakPrompt(COMPLETE_PROMPT)).toBe(false);
    expect(() => validateCronsPrompt([makeCron(COMPLETE_PROMPT, 'usage-audit')])).not.toThrow();
    expect(findBannedCronPrompts([makeCron(COMPLETE_PROMPT, 'usage-audit')])).toEqual([]);
  });

  it('allows prompts with no task bookkeeping', async () => {
    const { findBannedCronPrompts, isCronTaskLeakPrompt, validateCronsPrompt } =
      await importValidator();

    expect(isCronTaskLeakPrompt(PASSIVE_PROMPT)).toBe(false);
    expect(() => validateCronsPrompt([makeCron(PASSIVE_PROMPT)])).not.toThrow();
    expect(findBannedCronPrompts([makeCron(PASSIVE_PROMPT)])).toEqual([]);
  });

  it('keeps the Telegram floor error message unchanged', async () => {
    const { validateCronsPrompt } = await importValidator();

    expect(() =>
      validateCronsPrompt([makeCron('Send the full HUMAN task list via Telegram.')])
    ).toThrow(/known Telegram-spam recurrence/);
  });
});
