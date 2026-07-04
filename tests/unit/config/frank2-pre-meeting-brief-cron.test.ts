// Validates the frank2 pre-meeting-brief cron consolidation:
// the old daily `pre-meeting-brief` cron stays in config.json but disabled,
// and the new `pre-meeting-brief-page` cron (*/15 7-19 * * 1-5) does a cheap
// inline scan and conditionally spawns a worker — delivery (Telegram, page
// publish) lives in the worker skill, never in the cron prompt.
//
// OPERATOR NOTE: merging this config change does NOT activate the cron on the
// running frank2 — an operator must load it into live crons.json afterwards
// (`cortextos --instance cortextos1 bus add-cron ...` or a daemon reload);
// no live state is touched by this change or this test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { findBannedCronPrompts } from '../../../src/utils/cron-prompt-validator.js';
import type { CronDefinition } from '../../../src/types/index.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CONFIG_PATH = path.join(
  REPO_ROOT,
  'orgs',
  'clearworksai',
  'agents',
  'frank2',
  'config.json'
);

interface AgentCronEntry {
  name: string;
  type?: string;
  cron?: string;
  interval?: string;
  enabled?: boolean;
  prompt: string;
}

function loadCrons(): AgentCronEntry[] {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as { crons: AgentCronEntry[] };
  return config.crons;
}

describe('frank2 config.json — pre-meeting-brief cron consolidation', () => {
  it('parses as valid JSON with a crons array', () => {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as { crons?: unknown };
    expect(Array.isArray(config.crons)).toBe(true);
  });

  it('keeps the old pre-meeting-brief cron present but disabled', () => {
    const crons = loadCrons();
    const old = crons.find((c) => c.name === 'pre-meeting-brief');
    expect(old).toBeDefined();
    expect(old?.enabled).toBe(false);
  });

  it('adds an enabled pre-meeting-brief-page cron with the right schedule and prompt shape', () => {
    const crons = loadCrons();
    const page = crons.find((c) => c.name === 'pre-meeting-brief-page');
    expect(page).toBeDefined();
    expect(page?.enabled).toBe(true);
    expect(page?.cron).toBe('*/15 7-19 * * 1-5');

    const prompt = page?.prompt ?? '';
    expect(prompt).toContain('meeting-brief-scan');
    expect(prompt).toContain('pre-meeting-brief-page-worker/SKILL.md');
    expect(prompt).toContain('spawn-worker');
    // Delivery belongs to the worker skill, never the cron prompt.
    expect(prompt).not.toContain('send-telegram');
  });

  it('passes the banned-cron-prompt validator for the new entry', () => {
    const crons = loadCrons();
    const page = crons.find((c) => c.name === 'pre-meeting-brief-page');
    expect(page).toBeDefined();

    const candidate: CronDefinition = {
      name: page!.name,
      prompt: page!.prompt,
      schedule: page!.cron ?? '',
      enabled: page!.enabled ?? true,
      created_at: new Date().toISOString(),
    };
    expect(findBannedCronPrompts([candidate])).toEqual([]);
  });

  it('has exactly one cron entry for each of the two names', () => {
    const crons = loadCrons();
    const oldCount = crons.filter((c) => c.name === 'pre-meeting-brief').length;
    const pageCount = crons.filter(
      (c) => c.name === 'pre-meeting-brief-page'
    ).length;
    expect(oldCount).toBe(1);
    expect(pageCount).toBe(1);
  });
});
