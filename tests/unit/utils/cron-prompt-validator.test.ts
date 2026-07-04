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
