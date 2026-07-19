/**
 * scripts/migrate-cron-task-leak.ts
 *
 * One-shot migration that strips leaky cron task bookkeeping from live
 * crons.json files across every cortextOS runtime root under ~/.cortextos.
 *
 * Behavior:
 *   - Walk each ~/.cortextos runtime root and inspect
 *     .cortextOS/state/agents/<agent>/crons.json
 *   - Detect leaky prompts by reusing isCronTaskLeakPrompt()
 *   - Strip only the TASK_ID create-task + update-task in_progress segment
 *   - Default to DRY RUN; write only with --apply
 *   - Apply writes atomically and keep a .bak rollback file per crons.json
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { CronDefinition } from '../src/types/index.js';
import { atomicWriteSync } from '../src/utils/atomic.js';
import { isCronTaskLeakPrompt } from '../src/utils/cron-prompt-validator.js';

const DEFAULT_ROOTS_DIR = join(homedir(), '.cortextos');
const CRONS_DIRECTORY = '.cortextOS/state/agents';
const CRONS_FILENAME = 'crons.json';
const BOOKKEEPING_SEGMENT_RE =
  /\s*TASK_ID=\$\(\s*cortextos bus create-task\s+("[^"]*"|'[^']*')(?:\s+--desc\s+("[^"]*"|'[^']*'))?[^)]*\)\s*;\s*cortextos bus update-task \$TASK_ID in_progress[^;]*(?:;|$)\s*/g;

interface CronRecord extends CronDefinition {
  name: string;
  prompt: string;
}

interface CronsEnvelope {
  updated_at: string;
  crons: CronRecord[];
  [key: string]: unknown;
}

export interface StripResult {
  prompt: string;
  changed: boolean;
  manualReview: boolean;
}

export interface MigrationOptions {
  rootsDir: string;
  dryRun: boolean;
}

export interface FileChange {
  path: string;
  crons: { name: string; before: string; after: string }[];
}

export interface MigrationReport {
  filesScanned: number;
  leaksFound: number;
  stripped: number;
  changes: FileChange[];
  manualReview: { path: string; cron: string }[];
}

interface MigrationReportWithParseFailures extends MigrationReport {
  agentSummaries: AgentSummary[];
  parseFailures: string[];
}

interface AgentSummary {
  agent: string;
  path: string;
  leaksFound: number;
  stripped: number;
  manualReview: number;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isCronRecord(value: unknown): value is CronRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.prompt === 'string';
}

function isCronsEnvelope(value: unknown): value is CronsEnvelope {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Array.isArray(record.crons) && record.crons.every(isCronRecord);
}

function extractBookkeepingSegments(prompt: string): string[] {
  BOOKKEEPING_SEGMENT_RE.lastIndex = 0;
  const matches = prompt.match(BOOKKEEPING_SEGMENT_RE);
  BOOKKEEPING_SEGMENT_RE.lastIndex = 0;
  return matches?.map(match => match.trim()) ?? [];
}

function agentNameFromCronsPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-2) ?? path;
}

function parseCronsEnvelope(path: string): CronsEnvelope | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    process.stderr.write(
      `[parse-failure] ${path} :: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `[parse-failure] ${path} :: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return null;
  }

  if (!isCronsEnvelope(parsed)) {
    process.stderr.write(`[parse-failure] ${path} :: unexpected crons.json shape\n`);
    return null;
  }

  return parsed;
}

export function findCronsFiles(rootsDir: string): string[] {
  const baseDir = resolve(rootsDir);
  if (!isDirectory(baseDir)) {
    return [];
  }

  const files: string[] = [];
  for (const rootEntry of readdirSync(baseDir)) {
    const rootPath = join(baseDir, rootEntry);
    if (!isDirectory(rootPath)) {
      continue;
    }

    const agentsDir = join(rootPath, CRONS_DIRECTORY);
    if (!isDirectory(agentsDir)) {
      continue;
    }

    for (const agentEntry of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, agentEntry);
      if (!isDirectory(agentDir)) {
        continue;
      }

      const cronsPath = join(agentDir, CRONS_FILENAME);
      if (existsSync(cronsPath) && isFile(cronsPath)) {
        files.push(cronsPath);
      }
    }
  }

  return files.sort();
}

export function stripTaskLeakBookkeeping(prompt: string): StripResult {
  if (!isCronTaskLeakPrompt(prompt)) {
    return { prompt, changed: false, manualReview: false };
  }

  BOOKKEEPING_SEGMENT_RE.lastIndex = 0;
  const stripped = prompt.replace(BOOKKEEPING_SEGMENT_RE, ' ').replace(/ {2,}/g, ' ').trim();
  BOOKKEEPING_SEGMENT_RE.lastIndex = 0;

  if (
    stripped.includes('$TASK_ID') ||
    stripped.includes('create-task') ||
    stripped.includes('cortextos bus update-task')
  ) {
    return { prompt, changed: false, manualReview: true };
  }

  return { prompt: stripped, changed: stripped !== prompt, manualReview: false };
}

export function runMigration(opts: MigrationOptions): MigrationReport {
  const report: MigrationReportWithParseFailures = {
    filesScanned: 0,
    leaksFound: 0,
    stripped: 0,
    changes: [],
    manualReview: [],
    agentSummaries: [],
    parseFailures: [],
  };

  for (const path of findCronsFiles(opts.rootsDir)) {
    report.filesScanned += 1;

    const envelope = parseCronsEnvelope(path);
    if (envelope === null) {
      report.parseFailures.push(path);
      continue;
    }

    const nextCrons: CronRecord[] = [];
    const fileChanges: FileChange['crons'] = [];
    let fileLeaksFound = 0;
    let fileStripped = 0;
    let fileManualReview = 0;

    for (const cron of envelope.crons) {
      const result = stripTaskLeakBookkeeping(cron.prompt);
      if (result.changed || result.manualReview) {
        report.leaksFound += 1;
        fileLeaksFound += 1;
      }

      if (result.manualReview) {
        report.manualReview.push({ path, cron: cron.name });
        fileManualReview += 1;
        nextCrons.push(cron);
        continue;
      }

      if (result.changed) {
        report.stripped += 1;
        fileStripped += 1;
        fileChanges.push({
          name: cron.name,
          before: cron.prompt,
          after: result.prompt,
        });
        nextCrons.push({ ...cron, prompt: result.prompt });
        continue;
      }

      nextCrons.push(cron);
    }

    if (fileLeaksFound > 0) {
      report.agentSummaries.push({
        agent: agentNameFromCronsPath(path),
        path,
        leaksFound: fileLeaksFound,
        stripped: fileStripped,
        manualReview: fileManualReview,
      });
    }

    if (fileChanges.length === 0) {
      continue;
    }

    report.changes.push({ path, crons: fileChanges });
    if (!opts.dryRun) {
      const nextEnvelope: CronsEnvelope = {
        ...envelope,
        updated_at: new Date().toISOString(),
        crons: nextCrons,
      };
      atomicWriteSync(path, JSON.stringify(nextEnvelope, null, 2), /* keepBak= */ true);
    }
  }

  return report;
}

function formatChangedCronLine(
  mode: 'dry-run' | 'apply',
  path: string,
  change: FileChange['crons'][number]
): string {
  const removed = extractBookkeepingSegments(change.before).join(' | ');
  return `[${mode}] ${path} :: ${change.name} :: removed ${removed}\n`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const dryRun = !argv.includes('--apply');
  const rootIndex = argv.indexOf('--root');
  const rootsDir =
    rootIndex >= 0 && argv[rootIndex + 1] ? argv[rootIndex + 1] : DEFAULT_ROOTS_DIR;
  const report = runMigration({ rootsDir, dryRun }) as MigrationReportWithParseFailures;
  const mode = dryRun ? 'dry-run' : 'apply';

  for (const change of report.changes) {
    for (const cron of change.crons) {
      process.stdout.write(formatChangedCronLine(mode, change.path, cron));
    }
  }

  for (const review of report.manualReview) {
    process.stderr.write(`[manual-review] ${review.path} :: ${review.cron}\n`);
  }

  for (const summary of report.agentSummaries) {
    process.stdout.write(
      `[agent-summary] ${summary.agent} :: leaksFound=${summary.leaksFound} ` +
        `stripped=${summary.stripped} manualReview=${summary.manualReview} :: ${summary.path}\n`
    );
  }

  process.stdout.write(
    `Summary: filesScanned=${report.filesScanned} leaksFound=${report.leaksFound} ` +
      `stripped=${report.stripped} manualReview=${report.manualReview.length}\n`
  );

  if (dryRun) {
    process.stdout.write('Dry run — no files written. Re-run with --apply to write.\n');
  }

  if (report.parseFailures.length > 0) {
    process.stderr.write(`Parse failures: ${report.parseFailures.length}\n`);
  }

  return report.manualReview.length > 0 || report.parseFailures.length > 0 ? 1 : 0;
}

const isMain = (() => {
  try {
    return Boolean(typeof require !== 'undefined' && require.main === module);
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = main();
}
