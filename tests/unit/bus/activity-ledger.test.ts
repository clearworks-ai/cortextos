import { describe, it, expect } from 'vitest';
import {
  correlateActivity,
  ledgerFindings,
  type ClaimSignal,
  type ActionSignal,
  type DeclaredCron,
} from '../../../src/bus/activity-ledger';

/**
 * Unit tests for the pure did-vs-claimed activity ledger (WS10 / R6).
 *
 * The motivating incident pattern: agents claim "done / shipped / live"
 * without a backing verification receipt, crons silently never fire, and
 * cron errors go unreported. correlateActivity() surfaces these mismatches
 * from existing signal streams without adding new infrastructure.
 *
 * All tests use frozen fixture data — no fs, no env, no tmpdir.
 */

const NOW = 1_700_000_000_000; // a fixed epoch for all tests
const WINDOW_MS = 30 * 60 * 1000; // 30 minutes (default)

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeClaim(agent: string, kind: ClaimSignal['kind'], offsetMs: number, ref?: string): ClaimSignal {
  return { agent, kind, ts: NOW + offsetMs, ref };
}

function makeAction(agent: string, kind: ActionSignal['kind'], offsetMs: number, ref?: string): ActionSignal {
  return { agent, kind, ts: NOW + offsetMs, ref };
}

function makeCron(agent: string, name: string, interval: string): DeclaredCron {
  return { agent, name, interval };
}

// ---------------------------------------------------------------------------
// Rule 1: claim_without_action
// ---------------------------------------------------------------------------

describe('correlateActivity — Rule 1: claim_without_action', () => {
  it('claim + matching receipt in-window → 0 findings (clean)', () => {
    const claims: ClaimSignal[] = [
      makeClaim('larry', 'telegram_claim', -5 * 60_000, 'build passed, shipped'),
    ];
    const actions: ActionSignal[] = [
      makeAction('larry', 'receipt', -10 * 60_000, 'build'), // 10 min before claim, within 30min window
    ];
    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.clean).toBe(true);
    expect(report.total).toBe(0);
    expect(report.counts.claim_without_action).toBe(0);
  });

  it('telegram_claim + no receipt in-window → one claim_without_action', () => {
    const claims: ClaimSignal[] = [
      makeClaim('larry', 'telegram_claim', -5 * 60_000, 'it is live and deployed'),
    ];
    const actions: ActionSignal[] = [
      // Receipt exists but is 45 minutes before claim — outside the 30-min window
      makeAction('larry', 'receipt', -45 * 60_000, 'build'),
    ];
    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.total).toBe(1);
    expect(report.counts.claim_without_action).toBe(1);
    expect(report.findings[0].kind).toBe('claim_without_action');
    expect(report.findings[0].agent).toBe('larry');
    expect(report.findings[0].claimTs).toBe(NOW - 5 * 60_000);
  });

  it('pre-computed claim_without_receipt event is always a finding (guard already confirmed no receipt)', () => {
    const claims: ClaimSignal[] = [
      makeClaim('frank2', 'claim_without_receipt', -2 * 60_000, 'tests pass'),
    ];
    const actions: ActionSignal[] = []; // no actions at all
    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.total).toBe(1);
    expect(report.counts.claim_without_action).toBe(1);
    expect(report.findings[0].kind).toBe('claim_without_action');
    expect(report.findings[0].agent).toBe('frank2');
  });

  it('telegram_claim whose ref does not trip detectsCompletionClaim → NOT a finding', () => {
    const claims: ClaimSignal[] = [
      // The ref text does not contain a completion claim phrase
      makeClaim('larry', 'telegram_claim', -5 * 60_000, 'working on the feature now'),
    ];
    const actions: ActionSignal[] = [];
    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.total).toBe(0);
    expect(report.clean).toBe(true);
  });

  it('claim outside the analysis window → not counted', () => {
    const claims: ClaimSignal[] = [
      // 5 hours before NOW — outside windowStart = NOW - 2×windowMs = NOW - 60min
      makeClaim('larry', 'telegram_claim', -5 * 3_600_000, 'all done'),
    ];
    const actions: ActionSignal[] = [];
    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.total).toBe(0);
  });

  it('receipt from a different agent does not satisfy the claim', () => {
    const claims: ClaimSignal[] = [
      makeClaim('larry', 'telegram_claim', -5 * 60_000, 'deployed and verified'),
    ];
    const actions: ActionSignal[] = [
      makeAction('frank2', 'receipt', -5 * 60_000, 'build'), // different agent
    ];
    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.claim_without_action).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: silent_cron
// ---------------------------------------------------------------------------

describe('correlateActivity — Rule 2: silent_cron', () => {
  it('declared cron, last_fire > 2×interval, no exec entry → one silent_cron', () => {
    // Cron with 6h interval: fire expected within last 12h.
    // Signal shows it last fired 15 hours ago (older than 2×6h = 12h).
    const cronFireTs = NOW - 15 * 3_600_000;
    const actions: ActionSignal[] = [
      makeAction('larry', 'cron_fire', cronFireTs - NOW, 'fleet-reconcile'), // negative offset trick
    ];
    // Actually, let's make the action with absolute ts:
    const absActions: ActionSignal[] = [
      { agent: 'larry', kind: 'cron_fire', ts: NOW - 15 * 3_600_000, ref: 'fleet-reconcile' },
    ];
    const crons: DeclaredCron[] = [makeCron('larry', 'fleet-reconcile', '6h')];

    const report = correlateActivity({
      claims: [],
      actions: absActions,
      declaredCrons: crons,
      now: NOW,
      windowMs: WINDOW_MS,
    });

    expect(report.total).toBe(1);
    expect(report.counts.silent_cron).toBe(1);
    expect(report.findings[0].kind).toBe('silent_cron');
    expect(report.findings[0].agent).toBe('larry');
    expect(report.findings[0].detail).toBe('fleet-reconcile');
  });

  it('cron fired recently (within 2×interval) → 0 silent_cron findings', () => {
    // Cron with 6h interval, last fired 8 hours ago — within 2×6h = 12h.
    const crons: DeclaredCron[] = [makeCron('larry', 'fleet-reconcile', '6h')];
    const actions: ActionSignal[] = [
      { agent: 'larry', kind: 'cron_fire', ts: NOW - 8 * 3_600_000, ref: 'fleet-reconcile' },
    ];

    const report = correlateActivity({ claims: [], actions, declaredCrons: crons, now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.silent_cron).toBe(0);
    expect(report.clean).toBe(true);
  });

  it('no cron_fire but exec_log entry exists within 2×interval → 0 silent_cron', () => {
    // cron-state.json missing but exec-log has a fired entry recently.
    const crons: DeclaredCron[] = [makeCron('larry', 'fleet-reconcile', '6h')];
    const actions: ActionSignal[] = [
      // cron_exec with ref=name:fired
      { agent: 'larry', kind: 'cron_exec', ts: NOW - 4 * 3_600_000, ref: 'fleet-reconcile:fired' },
    ];

    const report = correlateActivity({ claims: [], actions, declaredCrons: crons, now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.silent_cron).toBe(0);
  });

  it('cron with non-parseable interval (cron expression) → skipped (no silent_cron)', () => {
    // "0 8 * * *" is a cron expression — parseDurationMs returns NaN → skipped.
    const crons: DeclaredCron[] = [{ agent: 'larry', name: 'daily-brief', interval: '0 8 * * *' }];
    const report = correlateActivity({ claims: [], actions: [], declaredCrons: crons, now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.silent_cron).toBe(0);
    expect(report.clean).toBe(true);
  });

  it('declared cron with no fire records at all → one silent_cron', () => {
    // Cron is declared and has never fired (no cron_fire or cron_exec signals).
    const crons: DeclaredCron[] = [makeCron('muse', 'morning-brief', '24h')];
    const report = correlateActivity({ claims: [], actions: [], declaredCrons: crons, now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.silent_cron).toBe(1);
    expect(report.findings[0].agent).toBe('muse');
    expect(report.findings[0].detail).toBe('morning-brief');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: cron_error_unreported
// ---------------------------------------------------------------------------

describe('correlateActivity — Rule 3: cron_error_unreported', () => {
  it('cron exec failed, no surfacing event after → one cron_error_unreported', () => {
    // A failed exec log entry with no subsequent receipt or message.
    const actions: ActionSignal[] = [
      { agent: 'larry', kind: 'cron_exec', ts: NOW - 10 * 60_000, ref: 'fleet-reconcile:failed' },
    ];

    const report = correlateActivity({ claims: [], actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.cron_error_unreported).toBe(1);
    expect(report.findings[0].kind).toBe('cron_error_unreported');
    expect(report.findings[0].agent).toBe('larry');
    expect(report.findings[0].detail).toBe('fleet-reconcile');
  });

  it('cron exec failed but was followed by a receipt → 0 cron_error_unreported (surfaced)', () => {
    const actions: ActionSignal[] = [
      { agent: 'larry', kind: 'cron_exec', ts: NOW - 10 * 60_000, ref: 'fleet-reconcile:failed' },
      // A receipt AFTER the failure shows the agent is aware
      { agent: 'larry', kind: 'receipt', ts: NOW - 5 * 60_000, ref: 'build' },
    ];

    const report = correlateActivity({ claims: [], actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.cron_error_unreported).toBe(0);
    expect(report.clean).toBe(true);
  });

  it('cron exec status:fired (not failed) → no cron_error_unreported', () => {
    const actions: ActionSignal[] = [
      { agent: 'larry', kind: 'cron_exec', ts: NOW - 10 * 60_000, ref: 'fleet-reconcile:fired' },
    ];

    const report = correlateActivity({ claims: [], actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.cron_error_unreported).toBe(0);
  });

  it('failed exec followed by a telegram claim → 0 cron_error_unreported (agent was active)', () => {
    const actions: ActionSignal[] = [
      { agent: 'frank2', kind: 'cron_exec', ts: NOW - 20 * 60_000, ref: 'daily-check:failed' },
    ];
    const claims: ClaimSignal[] = [
      // A completion claim AFTER the failure — agent was active and aware
      { agent: 'frank2', kind: 'telegram_claim', ts: NOW - 5 * 60_000, ref: 'all done' },
    ];

    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.cron_error_unreported).toBe(0);
  });

  it('failed exec outside window → not counted', () => {
    const actions: ActionSignal[] = [
      // 5 hours ago, outside the windowStart = NOW - 2×windowMs = NOW - 60min
      { agent: 'larry', kind: 'cron_exec', ts: NOW - 5 * 3_600_000, ref: 'fleet-reconcile:failed' },
    ];

    const report = correlateActivity({ claims: [], actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });

    expect(report.counts.cron_error_unreported).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Purity and combined scenarios
// ---------------------------------------------------------------------------

describe('correlateActivity — purity and combined scenarios', () => {
  it('pure: identical inputs → identical output (no fs/env side effects)', () => {
    const input = {
      claims: [makeClaim('larry', 'telegram_claim' as const, -5 * 60_000, 'shipped and live')],
      actions: [] as ActionSignal[],
      declaredCrons: [makeCron('larry', 'fleet-reconcile', '6h')],
      now: NOW,
      windowMs: WINDOW_MS,
    };
    const r1 = correlateActivity(input);
    const r2 = correlateActivity(input);

    expect(r1).toEqual(r2);
  });

  it('multiple agents, findings attributed to the right agents', () => {
    // larry: has a claim without receipt
    // frank2: has a silent cron
    const claims: ClaimSignal[] = [
      { agent: 'larry', kind: 'telegram_claim', ts: NOW - 5 * 60_000, ref: 'merged and deployed' },
    ];
    const actions: ActionSignal[] = [
      // larry: no receipt within window (40min before)
      { agent: 'larry', kind: 'receipt', ts: NOW - 40 * 60_000, ref: 'build' },
      // frank2: cron last fired 25 hours ago (beyond 2×24h = 48h — WITHIN — so no finding)
      // Let's do 50 hours to trigger it
      { agent: 'frank2', kind: 'cron_fire', ts: NOW - 50 * 3_600_000, ref: 'morning-brief' },
    ];
    const crons: DeclaredCron[] = [
      makeCron('frank2', 'morning-brief', '24h'),
    ];

    const report = correlateActivity({ claims, actions, declaredCrons: crons, now: NOW, windowMs: WINDOW_MS });

    expect(report.total).toBe(2);
    const claimFindings = report.findings.filter(f => f.kind === 'claim_without_action');
    const cronFindings = report.findings.filter(f => f.kind === 'silent_cron');
    expect(claimFindings).toHaveLength(1);
    expect(claimFindings[0].agent).toBe('larry');
    expect(cronFindings).toHaveLength(1);
    expect(cronFindings[0].agent).toBe('frank2');
  });

  it('empty inputs → clean report with zero findings', () => {
    const report = correlateActivity({
      claims: [],
      actions: [],
      declaredCrons: [],
      now: NOW,
      windowMs: WINDOW_MS,
    });
    expect(report.clean).toBe(true);
    expect(report.total).toBe(0);
    expect(report.counts).toEqual({ claim_without_action: 0, silent_cron: 0, cron_error_unreported: 0 });
  });

  it('ledgerFindings flattens all findings from the report', () => {
    const claims: ClaimSignal[] = [
      { agent: 'larry', kind: 'claim_without_receipt', ts: NOW - 5 * 60_000, ref: 'done' },
    ];
    const actions: ActionSignal[] = [
      { agent: 'frank2', kind: 'cron_exec', ts: NOW - 10 * 60_000, ref: 'fleet-reconcile:failed' },
    ];

    const report = correlateActivity({ claims, actions, declaredCrons: [], now: NOW, windowMs: WINDOW_MS });
    const flat = ledgerFindings(report);

    expect(flat).toHaveLength(report.total);
    expect(flat.every(f => 'kind' in f && 'agent' in f && 'message' in f)).toBe(true);
  });
});
