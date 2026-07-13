import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CiAlertInput } from '../../../src/utils/ci-alert-gate.js';
import { evaluateCiAlert } from '../../../src/utils/ci-alert-gate.js';
import { checkAndRecordSourceEvent, isValidSourceKey } from '../../../src/utils/event-dedup.js';

interface CiAlertCase {
  name: string;
  input: CiAlertInput;
  expectedSurface: boolean;
  expectedReason: string;
}

const cases: CiAlertCase[] = [
  {
    name: 'stale failure superseded by newer green run skips (PR #39 scenario)',
    input: {
      prState: 'OPEN',
      headSha: '1c35662',
      compareStatus: 'diverged',
      runs: [
        {
          headSha: '3291433',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-07-03T06:01:00Z',
        },
        {
          headSha: '1c35662',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: false,
    expectedReason: 'skip: newer run succeeded',
  },
  {
    name: 'merged PR skips immediately',
    input: {
      prState: 'MERGED',
      runs: [
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: false,
    expectedReason: 'skip: PR merged',
  },
  {
    name: 'closed PR skips immediately',
    input: {
      prState: 'CLOSED',
      runs: [
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: false,
    expectedReason: 'skip: PR closed',
  },
  {
    name: 'head SHA behind main skips',
    input: {
      prState: 'OPEN',
      headSha: 'abc',
      compareStatus: 'behind',
      runs: [
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: false,
    expectedReason: 'skip: head SHA already in main',
  },
  {
    name: 'head SHA identical to main skips',
    input: {
      prState: 'OPEN',
      headSha: 'abc',
      compareStatus: 'identical',
      runs: [
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: false,
    expectedReason: 'skip: head SHA already in main',
  },
  {
    name: 'open PR with latest failed run surfaces',
    input: {
      prState: 'OPEN',
      headSha: 'abc',
      compareStatus: 'ahead',
      runs: [
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: true,
    expectedReason: 'surface: open PR, latest run failed',
  },
  {
    name: 'latest run still in progress skips even if older failure exists',
    input: {
      prState: 'OPEN',
      runs: [
        {
          headSha: 'abc',
          status: 'in_progress',
          conclusion: null,
          createdAt: '2026-07-03T06:00:00Z',
        },
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: false,
    expectedReason: 'skip: latest run still in progress',
  },
  {
    name: 'no runs skips fail-safe',
    input: {
      prState: 'OPEN',
      runs: [],
    },
    expectedSurface: false,
    expectedReason: 'skip: no runs found',
  },
  {
    name: 'gh error skips fail-safe',
    input: {
      prState: 'NOTFOUND',
      runs: [],
      ghError: true,
    },
    expectedSurface: false,
    expectedReason: 'skip: gh context unavailable (fail-safe)',
  },
  {
    name: 'no PR found but latest failed run still surfaces',
    input: {
      prState: 'NOTFOUND',
      runs: [
        {
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-03T05:25:00Z',
        },
      ],
    },
    expectedSurface: true,
    expectedReason: 'surface: open PR, latest run failed',
  },
];

describe('evaluateCiAlert', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = evaluateCiAlert(testCase.input);
      expect(result.surface).toBe(testCase.expectedSurface);
      expect(result.reason).toBe(testCase.expectedReason);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }
});

describe('ci-alert-gate run-id dedup contract', () => {
  const repo = 'clearworks-ai/cortextos';
  const runId = '29240232879';
  const dedupKey = `ci:${repo}/${runId}`;
  let ctxRoot: string;
  const ledgerPath = () => join(ctxRoot, 'state', 'comms-event-dedup.json');

  const surfacingInput: CiAlertInput = {
    prState: 'OPEN',
    headSha: 'abc',
    compareStatus: 'ahead',
    runs: [
      { headSha: 'abc', status: 'completed', conclusion: 'failure', createdAt: '2026-07-03T05:25:00Z' },
    ],
  };

  const skippingInput: CiAlertInput = {
    prState: 'MERGED',
    runs: [
      { headSha: 'abc', status: 'completed', conclusion: 'failure', createdAt: '2026-07-03T05:25:00Z' },
    ],
  };

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'ci-alert-dedup-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('dedup key ci:<owner>/<repo>/<runId> is a valid source key (single colon)', () => {
    expect(isValidSourceKey(dedupKey)).toBe(true);
    expect(isValidSourceKey(`ci:${repo}:${runId}`)).toBe(false);
  });

  it('run-id first-seen: gate surfaces and the run is recorded in the ledger', () => {
    const gate = evaluateCiAlert(surfacingInput);
    expect(gate.surface).toBe(true);

    const dedup = checkAndRecordSourceEvent(ctxRoot, dedupKey);
    expect(dedup).toMatchObject({ surface: true, reason: 'first-seen' });
    expect(existsSync(ledgerPath())).toBe(true);

    const ledger = JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(ledger)).toContain(dedupKey);
  });

  it('identical repeat: dedup returns duplicate and the decision downgrades to SKIP with the dedup reason', () => {
    checkAndRecordSourceEvent(ctxRoot, dedupKey);

    const dedup = checkAndRecordSourceEvent(ctxRoot, dedupKey);
    expect(dedup.surface).toBe(false);
    expect(dedup.reason).toBe('duplicate');

    const gate = evaluateCiAlert(surfacingInput);
    const result = dedup.surface
      ? gate
      : { surface: false, reason: `skip: run ${runId} already alerted (dedup)` };
    expect(result.surface).toBe(false);
    expect(result.reason).toBe('skip: run 29240232879 already alerted (dedup)');
  });

  it('no run-id: decision is the pure gate output and no ledger is created', () => {
    const gate = evaluateCiAlert(surfacingInput);
    expect(gate).toEqual({ surface: true, reason: 'surface: open PR, latest run failed' });
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('gate SKIP with run-id present: no ledger write', () => {
    const gate = evaluateCiAlert(skippingInput);
    expect(gate.surface).toBe(false);
    expect(gate.reason).toBe('skip: PR merged');
    expect(existsSync(ledgerPath())).toBe(false);
  });
});
