import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findCronsFiles,
  runMigration,
  stripTaskLeakBookkeeping,
} from '../../../scripts/migrate-cron-task-leak';

const HEARTBEAT_LEAK_PROMPT =
  'cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; ' +
  'TASK_ID=$(cortextos bus create-task "Cron: heartbeat" --desc "Scheduled cron run" 2>/dev/null); ' +
  'cortextos bus update-task $TASK_ID in_progress 2>/dev/null; ' +
  'Read HEARTBEAT.md and follow its instructions. Update heartbeat, check inbox, run fleet health check across all 3 repos.';

const HEARTBEAT_STRIPPED_PROMPT =
  'cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; ' +
  'Read HEARTBEAT.md and follow its instructions. Update heartbeat, check inbox, run fleet health check across all 3 repos.';

const NEWS_LEAK_PROMPT =
  "cortextos bus update-cron-fire news-intelligence --interval 1d 2>/dev/null; " +
  "TASK_ID=$(cortextos bus create-task 'Cron: news-intelligence' --desc 'Daily ICP-relevant news digest' 2>/dev/null); " +
  'cortextos bus update-task $TASK_ID in_progress 2>/dev/null; ' +
  'Scan the latest ICP-relevant news and write the digest.';

const USAGE_AUDIT_PROMPT =
  'cortextos bus update-cron-fire usage-audit --interval 1d 2>/dev/null; ' +
  'TASK_ID=$(cortextos bus create-task "Cron: usage-audit" --desc "Scheduled cron run" 2>/dev/null); ' +
  'cortextos bus update-task $TASK_ID in_progress 2>/dev/null; ' +
  'cortextos bus complete-task $TASK_ID 2>/dev/null; Run the usage audit.';

const PASSIVE_PROMPT =
  'cortextos bus update-cron-fire passive --interval 4h 2>/dev/null; ' +
  'cortextos bus log-event cron-fired passive 2>/dev/null; ' +
  'Read HEARTBEAT.md and follow its instructions.';

describe('migrate-cron-task-leak', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cron-task-leak-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(sub: string, agent: string, crons: Array<Record<string, unknown>>) {
    const dir = join(root, sub, '.cortextOS', 'state', 'agents', agent);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'crons.json');
    writeFileSync(
      path,
      JSON.stringify(
        {
          updated_at: '2026-07-19T05:00:00.000Z',
          crons,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
    return path;
  }

  function readCrons(path: string) {
    return JSON.parse(readFileSync(path, 'utf-8')) as {
      updated_at: string;
      crons: Array<Record<string, unknown>>;
    };
  }

  function makeCron(
    name: string,
    prompt: string,
    extras: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      name,
      prompt,
      schedule: '4h',
      enabled: true,
      created_at: '2026-07-19T05:00:00.000Z',
      ...extras,
    };
  }

  it('strips leaky prompts and preserves the rest', () => {
    const path = seed('cortextos1', 'larry', [
      makeCron('heartbeat', HEARTBEAT_LEAK_PROMPT),
      makeCron('news-intelligence', NEWS_LEAK_PROMPT),
      makeCron('usage-audit', USAGE_AUDIT_PROMPT),
      makeCron('passive', PASSIVE_PROMPT),
    ]);

    const report = runMigration({ rootsDir: root, dryRun: false });
    const envelope = readCrons(path);
    const prompts = new Map(
      envelope.crons.map(cron => [String(cron.name), String(cron.prompt)])
    );

    expect(prompts.get('heartbeat')).toBe(HEARTBEAT_STRIPPED_PROMPT);
    expect(prompts.get('news-intelligence')).not.toContain('TASK_ID');
    expect(prompts.get('news-intelligence')).not.toContain('create-task');
    expect(prompts.get('news-intelligence')).not.toContain('in_progress');
    expect(prompts.get('usage-audit')).toBe(USAGE_AUDIT_PROMPT);
    expect(prompts.get('passive')).toBe(PASSIVE_PROMPT);
    expect(report.leaksFound).toBe(2);
    expect(report.stripped).toBe(2);
  });

  it('dry-run writes nothing', () => {
    const path = seed('cortextos1', 'larry', [
      makeCron('heartbeat', HEARTBEAT_LEAK_PROMPT),
      makeCron('news-intelligence', NEWS_LEAK_PROMPT),
    ]);
    const before = readFileSync(path, 'utf-8');

    const report = runMigration({ rootsDir: root, dryRun: true });

    expect(report.leaksFound).toBe(2);
    expect(report.stripped).toBe(2);
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(existsSync(path + '.bak')).toBe(false);
  });

  it('is idempotent across repeated apply runs', () => {
    const path = seed('cortextos1', 'larry', [makeCron('heartbeat', HEARTBEAT_LEAK_PROMPT)]);

    const first = runMigration({ rootsDir: root, dryRun: false });
    expect(first.leaksFound).toBe(1);
    expect(first.stripped).toBe(1);
    const afterFirst = readFileSync(path, 'utf-8');

    const second = runMigration({ rootsDir: root, dryRun: false });
    expect(second.leaksFound).toBe(0);
    expect(second.stripped).toBe(0);
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst);
  });

  it('writes a backup file on apply', () => {
    const path = seed('cortextos1', 'larry', [makeCron('heartbeat', HEARTBEAT_LEAK_PROMPT)]);

    runMigration({ rootsDir: root, dryRun: false });

    const backup = JSON.parse(readFileSync(path + '.bak', 'utf-8')) as {
      crons: Array<Record<string, unknown>>;
    };
    expect(backup.crons[0]?.prompt).toBe(HEARTBEAT_LEAK_PROMPT);
  });

  it('preserves non-prompt cron fields', () => {
    const path = seed('cortextos1', 'larry', [
      makeCron('heartbeat', HEARTBEAT_LEAK_PROMPT, {
        schedule: '6h',
        enabled: false,
        created_at: '2026-07-19T04:00:00.000Z',
      }),
    ]);

    runMigration({ rootsDir: root, dryRun: false });

    const heartbeat = readCrons(path).crons[0] ?? {};
    expect(heartbeat.schedule).toBe('6h');
    expect(heartbeat.enabled).toBe(false);
    expect(heartbeat.created_at).toBe('2026-07-19T04:00:00.000Z');
    expect(heartbeat.prompt).toBe(HEARTBEAT_STRIPPED_PROMPT);
  });

  it('flags residue for manual review and leaves the prompt untouched', () => {
    const trickyPrompt =
      HEARTBEAT_LEAK_PROMPT +
      ' cortextos bus update-task $TASK_ID in_progress 2>/dev/null;';
    const path = seed('cortextos1', 'larry', [makeCron('tricky', trickyPrompt)]);
    const direct = stripTaskLeakBookkeeping(trickyPrompt);

    expect(direct.manualReview).toBe(true);
    expect(direct.changed).toBe(false);
    expect(direct.prompt).toBe(trickyPrompt);

    const report = runMigration({ rootsDir: root, dryRun: false });

    expect(report.manualReview).toEqual([{ path, cron: 'tricky' }]);
    expect(report.stripped).toBe(0);
    expect(readCrons(path).crons[0]?.prompt).toBe(trickyPrompt);
  });

  it('findCronsFiles sweeps both roots and ignores stray files', () => {
    const pathA = seed('cortextos1', 'larry', [makeCron('heartbeat', HEARTBEAT_LEAK_PROMPT)]);
    const pathB = seed('default', 'muse', [makeCron('passive', PASSIVE_PROMPT)]);
    writeFileSync(join(root, 'not-an-agent-file.txt'), 'ignore me\n', 'utf-8');

    expect(findCronsFiles(root)).toEqual([pathB, pathA].sort());
  });
});
