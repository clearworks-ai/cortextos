import { describe, expect, it } from 'vitest';
import type { CiAlertInput } from '../../../src/utils/ci-alert-gate.js';
import { evaluateCiAlert } from '../../../src/utils/ci-alert-gate.js';

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
