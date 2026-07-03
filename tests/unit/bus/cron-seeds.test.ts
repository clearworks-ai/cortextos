/**
 * tests/unit/bus/cron-seeds.test.ts — WS10 seed cron definitions + installer.
 *
 * Asserts the CronDefinition SHAPE only — never executes publish-wiki.sh or
 * the graphify skill. Each test uses a fresh CTX_ROOT tempdir so installer
 * writes never collide across tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring (matches crons-io.test.ts conventions)
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-seeds-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

async function importSeeds() {
  return import('../../../src/bus/cron-seeds.js');
}

async function importCrons() {
  return import('../../../src/bus/crons.js');
}

async function importScheduler() {
  return import('../../../src/daemon/cron-scheduler.js');
}

// ---------------------------------------------------------------------------
// Seed shape
// ---------------------------------------------------------------------------

describe('seed cron definitions', () => {
  it('both seeds have all required CronDefinition fields', async () => {
    const { WIKI_REPUBLISH_CRON, GRAPHIFY_REINDEX_CRON } = await importSeeds();

    for (const seed of [WIKI_REPUBLISH_CRON, GRAPHIFY_REINDEX_CRON]) {
      expect(typeof seed.name).toBe('string');
      expect(seed.name.length).toBeGreaterThan(0);
      expect(typeof seed.prompt).toBe('string');
      expect(seed.prompt.length).toBeGreaterThan(0);
      expect(typeof seed.schedule).toBe('string');
      expect(typeof seed.enabled).toBe('boolean');
      expect(typeof seed.created_at).toBe('string');
    }
  });

  it('seeds use the expected names and schedules', async () => {
    const { WIKI_REPUBLISH_CRON, GRAPHIFY_REINDEX_CRON } = await importSeeds();

    expect(WIKI_REPUBLISH_CRON.name).toBe('wiki-republish');
    expect(WIKI_REPUBLISH_CRON.schedule).toBe('0 7 * * *');
    expect(GRAPHIFY_REINDEX_CRON.name).toBe('graphify-reindex');
    expect(GRAPHIFY_REINDEX_CRON.schedule).toBe('0 5 * * 0');
  });

  it('both schedules parse as valid 5-field cron expressions', async () => {
    const { WIKI_REPUBLISH_CRON, GRAPHIFY_REINDEX_CRON } = await importSeeds();
    const { nextFireFromCron } = await importScheduler();

    const now = Date.UTC(2026, 6, 1, 12, 0, 0);
    expect(Number.isNaN(nextFireFromCron(WIKI_REPUBLISH_CRON.schedule, now))).toBe(false);
    expect(Number.isNaN(nextFireFromCron(GRAPHIFY_REINDEX_CRON.schedule, now))).toBe(false);
  });

  it('both seeds ship disabled — enabling is a deliberate ops action', async () => {
    const { WIKI_REPUBLISH_CRON, GRAPHIFY_REINDEX_CRON } = await importSeeds();

    expect(WIKI_REPUBLISH_CRON.enabled).toBe(false);
    expect(GRAPHIFY_REINDEX_CRON.enabled).toBe(false);
  });

  it('prompts contain zero hardcoded URLs or tokens', async () => {
    const { CRON_SEEDS } = await importSeeds();

    for (const seed of CRON_SEEDS) {
      // No literal URLs of any scheme.
      expect(seed.prompt).not.toMatch(/https?:\/\//i);
      expect(seed.prompt).not.toMatch(/[a-z0-9-]+\.(railway\.app|clearworks\.ai|up\.railway\.app)/i);
      // No token-looking literals — the env var NAMES are allowed, values are not.
      expect(seed.prompt).not.toMatch(/(?:token|bearer)[=:\s]+[A-Za-z0-9_-]{16,}/i);
      // References the env-configured names rather than values (wiki seed only).
      if (seed.name === 'wiki-republish') {
        expect(seed.prompt).toContain('BRIEFS_BASE_URL');
        expect(seed.prompt).toContain('DASHBOARD_BRIEF_TOKEN');
      }
    }
  });

  it('prompts state fail-loud rules and contain no outbound-send instructions', async () => {
    const { CRON_SEEDS } = await importSeeds();

    for (const seed of CRON_SEEDS) {
      expect(seed.prompt.toLowerCase()).toContain('never silently skip');
      expect(seed.prompt.toLowerCase()).toContain('log an error event');
      // Keep clear of anything resembling banned auto-send patterns.
      expect(seed.prompt.toLowerCase()).not.toContain('telegram');
      expect(seed.prompt.toLowerCase()).not.toMatch(/send\b[\s\S]{0,40}\b(full|entire|all|complete)\b[\s\S]{0,40}\btask\s+list\b/);
    }
  });

  it('wiki seed prompt instructs running the scaffold and checking the receipt', async () => {
    const { WIKI_REPUBLISH_CRON } = await importSeeds();

    expect(WIKI_REPUBLISH_CRON.prompt).toContain('bash bus/publish-wiki.sh');
    expect(WIKI_REPUBLISH_CRON.prompt).toContain('WIKI_PUBLISH_RECEIPT');
    expect(WIKI_REPUBLISH_CRON.prompt.toLowerCase()).toContain('exit code');
  });

  it('graphify seed prompt invokes the skill and never imports it', async () => {
    const { GRAPHIFY_REINDEX_CRON } = await importSeeds();

    expect(GRAPHIFY_REINDEX_CRON.prompt.toLowerCase()).toContain('graphify skill');
    expect(GRAPHIFY_REINDEX_CRON.prompt.toLowerCase()).toContain('receipt');

    // The module itself must not import a graphify implementation.
    const src = readFileSync(
      join(__dirname, '../../../src/bus/cron-seeds.ts'),
      'utf-8'
    );
    expect(src).not.toMatch(/import\s[^;]*from\s+['"][^'"]*graphify[^'"]*['"]/i);
    expect(src).not.toMatch(/require\(['"][^'"]*graphify[^'"]*['"]\)/i);
  });
});

// ---------------------------------------------------------------------------
// installCronSeeds — idempotency
// ---------------------------------------------------------------------------

describe('installCronSeeds', () => {
  it('installs both seeds on first call and writes them to crons.json', async () => {
    const { installCronSeeds } = await importSeeds();
    const { getCronByName } = await importCrons();

    const result = installCronSeeds('boris');

    expect(result.installed.sort()).toEqual(['graphify-reindex', 'wiki-republish']);
    expect(result.skipped).toEqual([]);

    const wiki = getCronByName('boris', 'wiki-republish');
    const graphify = getCronByName('boris', 'graphify-reindex');
    expect(wiki).toBeDefined();
    expect(graphify).toBeDefined();
    expect(wiki!.enabled).toBe(false);
    expect(graphify!.enabled).toBe(false);

    expect(
      existsSync(join(tmpRoot, '.cortextOS', 'state', 'agents', 'boris', 'crons.json'))
    ).toBe(true);
  });

  it('second call skips both — provably idempotent', async () => {
    const { installCronSeeds } = await importSeeds();
    const { readCrons } = await importCrons();

    const first = installCronSeeds('boris');
    expect(first.installed).toHaveLength(2);

    const second = installCronSeeds('boris');
    expect(second.installed).toEqual([]);
    expect(second.skipped.sort()).toEqual(['graphify-reindex', 'wiki-republish']);

    // No duplicates written.
    const crons = readCrons('boris');
    expect(crons.filter(c => c.name === 'wiki-republish')).toHaveLength(1);
    expect(crons.filter(c => c.name === 'graphify-reindex')).toHaveLength(1);
  });

  it('never overwrites an existing cron with the same name', async () => {
    const { installCronSeeds, WIKI_REPUBLISH_CRON } = await importSeeds();
    const { addCron, getCronByName } = await importCrons();

    // Pre-existing operator cron that collides on name but has diverged.
    addCron('paul', {
      name: WIKI_REPUBLISH_CRON.name,
      prompt: 'Operator-customized wiki publish prompt.',
      schedule: '0 9 * * *',
      enabled: true,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const result = installCronSeeds('paul');

    expect(result.skipped).toContain('wiki-republish');
    expect(result.installed).toEqual(['graphify-reindex']);

    const preserved = getCronByName('paul', 'wiki-republish');
    expect(preserved!.prompt).toBe('Operator-customized wiki publish prompt.');
    expect(preserved!.schedule).toBe('0 9 * * *');
    expect(preserved!.enabled).toBe(true);
  });
});
