import { execFileSync } from 'child_process';

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | 'NOTFOUND';
export type RunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'stale'
  | null;
export type CompareStatus = 'behind' | 'identical' | 'ahead' | 'diverged' | null;

export interface CiRun {
  headSha: string;
  status: string;
  conclusion: RunConclusion;
  createdAt: string;
}

export interface CiAlertInput {
  prState: PrState;
  runs: CiRun[];
  headSha?: string;
  compareStatus?: CompareStatus;
  ghError?: boolean;
}

export interface CiAlertDecision {
  surface: boolean;
  reason: string;
}

const RUN_FAILURE_CONCLUSIONS = new Set<Exclude<RunConclusion, null>>(['failure', 'timed_out']);
const RUN_NON_FAILURE_CONCLUSIONS = new Set<Exclude<RunConclusion, null>>([
  'success',
  'cancelled',
  'skipped',
  'action_required',
  'neutral',
  'stale',
]);

function decision(surface: boolean, reason: string): CiAlertDecision {
  return { surface, reason };
}

function runSortKey(run: CiRun): number {
  const ts = Date.parse(run.createdAt);
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

function normalizePrState(raw: string): PrState {
  if (raw === 'OPEN' || raw === 'MERGED' || raw === 'CLOSED') {
    return raw;
  }
  return 'NOTFOUND';
}

function normalizeCompareStatus(raw: string): CompareStatus {
  if (raw === 'behind' || raw === 'identical' || raw === 'ahead' || raw === 'diverged') {
    return raw;
  }
  return null;
}

function normalizeRunConclusion(raw: unknown): RunConclusion {
  if (raw === null) {
    return null;
  }
  if (
    raw === 'success' ||
    raw === 'failure' ||
    raw === 'cancelled' ||
    raw === 'skipped' ||
    raw === 'timed_out' ||
    raw === 'action_required' ||
    raw === 'neutral' ||
    raw === 'stale'
  ) {
    return raw;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function parseRuns(raw: string): CiRun[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const runs: CiRun[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }

    const headSha = item.headSha;
    const status = item.status;
    const createdAt = item.createdAt;
    if (typeof headSha !== 'string' || typeof status !== 'string' || typeof createdAt !== 'string') {
      continue;
    }

    runs.push({
      headSha,
      status,
      conclusion: normalizeRunConclusion(item.conclusion),
      createdAt,
    });
  }

  return runs;
}

function runGh(args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function evaluateCiAlert(input: CiAlertInput): CiAlertDecision {
  if (input.ghError) {
    return decision(false, 'skip: gh context unavailable (fail-safe)');
  }

  if (input.prState === 'MERGED') {
    return decision(false, 'skip: PR merged');
  }

  if (input.prState === 'CLOSED') {
    return decision(false, 'skip: PR closed');
  }

  if (
    input.headSha &&
    (input.compareStatus === 'behind' || input.compareStatus === 'identical')
  ) {
    return decision(false, 'skip: head SHA already in main');
  }

  const runs = [...input.runs].sort((left, right) => runSortKey(right) - runSortKey(left));
  if (runs.length === 0) {
    return decision(false, 'skip: no runs found');
  }

  const latestRun = runs[0];
  if (latestRun.status !== 'completed') {
    return decision(false, 'skip: latest run still in progress');
  }

  const latestCompletedRun = runs.find(run => run.status === 'completed');
  if (!latestCompletedRun) {
    return decision(false, 'skip: no runs found');
  }

  if (latestCompletedRun.conclusion === 'success') {
    return decision(false, 'skip: newer run succeeded');
  }

  if (
    latestCompletedRun.conclusion !== null &&
    RUN_NON_FAILURE_CONCLUSIONS.has(latestCompletedRun.conclusion)
  ) {
    return decision(false, 'skip: latest run not a failure');
  }

  if (
    latestCompletedRun.conclusion !== null &&
    RUN_FAILURE_CONCLUSIONS.has(latestCompletedRun.conclusion)
  ) {
    return decision(true, 'surface: open PR, latest run failed');
  }

  return decision(false, 'skip: latest run not a failure');
}

export function gatherCiAlertContext(
  repo: string,
  branch: string,
  opts: { headSha?: string } = {}
): CiAlertInput {
  const fallback = (): CiAlertInput => ({
    prState: 'NOTFOUND',
    runs: [],
    headSha: opts.headSha,
    ghError: true,
  });

  try {
    const prState = normalizePrState(
      runGh([
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--head',
        branch,
        '--json',
        'state',
        '--jq',
        '.[0].state // "NOTFOUND"',
      ])
    );

    const runs = parseRuns(
      runGh([
        'run',
        'list',
        '--repo',
        repo,
        '--branch',
        branch,
        '--limit',
        '10',
        '--json',
        'headSha,status,conclusion,createdAt',
      ])
    );

    let compareStatus: CompareStatus | undefined;
    if (opts.headSha) {
      compareStatus = normalizeCompareStatus(
        runGh(['api', `repos/${repo}/compare/main...${opts.headSha}`, '--jq', '.status'])
      );
    }

    return {
      prState,
      runs,
      headSha: opts.headSha,
      compareStatus,
    };
  } catch {
    return fallback();
  }
}
