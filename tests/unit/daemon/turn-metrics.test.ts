import { describe, it, expect } from 'vitest';
import {
  computeWindowMetrics,
  detectBurnAnomaly,
  type TurnRow,
} from '../../../src/daemon/turn-metrics.js';

/**
 * knox-codex, 2026-09-08 — making a 50x cost step change visible in minutes
 * rather than days.
 *
 * knox sends ~130-144K input tokens on EVERY turn — its standing prompt (system
 * prompt + skills + memory injection), not context growth; the figure is the
 * same on a 3.6-day-old session and a fresh one. So turn RATE is the cost
 * multiplier:
 *
 *     baseline   10 turns/hr  ~=  1.4M input tok/hr
 *     browser   500 turns/hr  ~=   70M input tok/hr
 *
 * When sustained browser automation began at 09-07T23:36Z, knox stepped from a
 * 2-32/hr baseline to 274-500/hr and held it overnight:
 *
 *     09-07 20Z     9
 *     09-07 23Z    69   <-- step change
 *     09-08 00Z   274
 *     09-08 02Z   500   <-- peak
 *
 * Nothing surfaced it. The dashboard tracks daily SPEND, which is a total, not a
 * velocity — a 50x rate change is invisible in it until the day's total lands.
 *
 * `input_tokens` in codex-tokens.jsonl is CUMULATIVE PER SESSION, so per-turn
 * cost is the delta between consecutive rows of the same session, and a session
 * boundary resets it. Treating the raw field as per-turn would report knox's
 * 1.8-billion cumulative total as one turn's cost.
 */

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const rows = (specs: Array<[number, string, number]>): TurnRow[] =>
  specs.map(([atMs, sessionId, inputTokens]) => ({ atMs, sessionId, inputTokens, cacheReadTokens: 0 }));

/** Rows carrying cumulative cache-read alongside cumulative input. */
const cachedRows = (specs: Array<[number, string, number, number]>): TurnRow[] =>
  specs.map(([atMs, sessionId, inputTokens, cacheReadTokens]) =>
    ({ atMs, sessionId, inputTokens, cacheReadTokens }));

describe('computeWindowMetrics', () => {
  it('counts turns inside the window and ignores older ones', () => {
    const m = computeWindowMetrics(rows([
      [NOW - 3 * HOUR, 's1', 1_000],   // outside a 1h window
      [NOW - 30 * 60_000, 's1', 2_000],
      [NOW - 10 * 60_000, 's1', 3_000],
    ]), NOW, HOUR);

    expect(m.turns).toBe(2);
  });

  it('derives per-turn input tokens from the cumulative delta', () => {
    // 1000 -> 3000 -> 6000 means this session spent 2000 then 3000.
    const m = computeWindowMetrics(rows([
      [NOW - 50 * 60_000, 's1', 1_000],
      [NOW - 40 * 60_000, 's1', 3_000],
      [NOW - 30 * 60_000, 's1', 6_000],
    ]), NOW, HOUR);

    expect(m.inputTokens).toBe(5_000);
  });

  it('does NOT treat the cumulative total as one turn cost', () => {
    // The trap: knox's last row carried input_tokens = 1,826,028,101 cumulative.
    // Read naively that is a single turn costing 1.8 billion tokens.
    const m = computeWindowMetrics(rows([
      [NOW - 20 * 60_000, 's1', 1_800_000_000],
      [NOW - 10 * 60_000, 's1', 1_800_140_000],
    ]), NOW, HOUR);

    expect(m.inputTokens).toBe(140_000);
  });

  it('resets the delta at a session boundary instead of going negative', () => {
    // A fresh session restarts the cumulative counter from ~0. Naive
    // subtraction would produce a large negative and corrupt the total.
    const m = computeWindowMetrics(rows([
      [NOW - 30 * 60_000, 's_old', 1_800_000_000],
      [NOW - 20 * 60_000, 's_new', 140_000],
      [NOW - 10 * 60_000, 's_new', 280_000],
    ]), NOW, HOUR);

    expect(m.inputTokens).toBe(140_000);
    expect(m.turns).toBe(3);
  });

  it('scales to a per-hour rate for a sub-hour window', () => {
    const m = computeWindowMetrics(rows([
      [NOW - 20 * 60_000, 's1', 1_000],
      [NOW - 10 * 60_000, 's1', 2_000],
    ]), NOW, 30 * 60_000);

    expect(m.turnsPerHour).toBe(4); // 2 turns in 30min
  });

  it('reports zeroes for an empty window rather than dividing by zero', () => {
    const m = computeWindowMetrics([], NOW, HOUR);
    expect(m).toMatchObject({ turns: 0, inputTokens: 0, turnsPerHour: 0 });
  });
});

describe('detectBurnAnomaly', () => {
  it('flags the knox step change against its own baseline', () => {
    // 32/hr baseline -> 500/hr recent.
    const verdict = detectBurnAnomaly({ recentTurnsPerHour: 500, baselineTurnsPerHour: 32, factor: 3 });
    expect(verdict.anomalous).toBe(true);
    expect(verdict.ratio).toBeCloseTo(15.6, 1);
  });

  it('does not flag ordinary variation', () => {
    expect(detectBurnAnomaly({ recentTurnsPerHour: 60, baselineTurnsPerHour: 32, factor: 3 }).anomalous)
      .toBe(false);
  });

  it('compares each agent against ITSELF, not against the fleet', () => {
    // larry legitimately runs at 50-180/hr. Judged against a fleet-wide average
    // it would alert constantly; judged against its own baseline it is normal.
    expect(detectBurnAnomaly({ recentTurnsPerHour: 180, baselineTurnsPerHour: 120, factor: 3 }).anomalous)
      .toBe(false);
  });

  it('does not flag an idle agent waking up to a trickle of work', () => {
    // A near-zero baseline makes any activity an infinite ratio. A floor keeps
    // "0.5/hr -> 4/hr" from paging anyone.
    expect(detectBurnAnomaly({ recentTurnsPerHour: 4, baselineTurnsPerHour: 0, factor: 3 }).anomalous)
      .toBe(false);
  });

  it('still flags a genuine spike from a quiet baseline', () => {
    expect(detectBurnAnomaly({ recentTurnsPerHour: 300, baselineTurnsPerHour: 0, factor: 3 }).anomalous)
      .toBe(true);
  });
});

describe('computeWindowMetrics — cached vs uncached input', () => {
  it('separates cache reads from genuinely new input', () => {
    // Measured on the real fleet: 83-98.6% of input tokens are cache reads.
    // Reporting raw input as a cost proxy overstates spend by up to ~50x — the
    // builddifferentprod burst spent 11,853,518 input tokens of which
    // 11,798,656 were cache reads (99.5%).
    const m = computeWindowMetrics(cachedRows([
      [NOW - 30 * 60_000, 's1', 1_000_000, 990_000],
      [NOW - 20 * 60_000, 's1', 1_200_000, 1_188_000],
    ]), NOW, HOUR);

    expect(m.inputTokens).toBe(200_000);
    expect(m.cacheReadTokens).toBe(198_000);
    expect(m.uncachedInputTokens).toBe(2_000);
  });

  it('never reports negative uncached input when cache exceeds the input delta', () => {
    // The two counters are reported independently by the runtime and can drift.
    const m = computeWindowMetrics(cachedRows([
      [NOW - 30 * 60_000, 's1', 1_000, 1_000],
      [NOW - 20 * 60_000, 's1', 2_000, 5_000],
    ]), NOW, HOUR);

    expect(m.uncachedInputTokens).toBe(0);
  });

  it('resets cache deltas at a session boundary too', () => {
    const m = computeWindowMetrics(cachedRows([
      [NOW - 30 * 60_000, 's_old', 689_000_000, 680_000_000],
      [NOW - 20 * 60_000, 's_new', 200_000, 190_000],
      [NOW - 10 * 60_000, 's_new', 400_000, 380_000],
    ]), NOW, HOUR);

    expect(m.inputTokens).toBe(200_000);
    expect(m.cacheReadTokens).toBe(190_000);
  });
});
