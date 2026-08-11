/**
 * tests/unit/daemon/cron-parser-live-fleet.test.ts
 *
 * FR-C4 VERIFICATION (spec: event-driven-and-cron-modernization-spec-2026-08-10.md,
 * SUBSYSTEM 3). The spec claims the daemon step-value cron parser is "broken"
 * and that crm comms-ingest + calendar-ingest crons "died at daemon level".
 *
 * This test is the reproduction / regression harness. It runs EVERY unique
 * cron-expression form present in the LIVE fleet (snapshotted 2026-08-11 from
 * ~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json) through
 * the real parser and asserts none is mis-parsed.
 *
 * VERDICT (see cron-scheduler.ts nextFireFromCron / expandField):
 *   - The parser supports  *  ·  a  ·  a,b,c  ·  a-b  ·  every N minutes/hours (star-slash-N).
 *   - The ONLY unsupported form is a RANGE WITH STEP (e.g. "0-30/5" or "8-18/2").
 *     It does NOT return NaN — it SILENTLY MIS-PARSES. expandField hits the
 *     `part.includes('-')` branch first: "0-30/5".split('-') => ['0','30/5'],
 *     parseInt('30/5',10) => 30, so the "/5" step is dropped and the field
 *     expands to the whole range 0..30 (fires every minute 0-30 instead of every
 *     5th). This is worse than NaN but still affects ZERO live crons.
 *   - NO live cron uses range-with-step. The claimed comms-ingest / calendar-ingest
 *     crons DO NOT EXIST in the live fleet (crm's inbound is piggybacked on the
 *     heartbeat). => CONFIRMED NON-ISSUE for production; the range-with-step gap
 *     is LATENT and affects zero live workloads.
 *
 * If a future cron introduces "a-b/N", the "none of the live expressions uses
 * range-with-step" test below flips to failing — that is the trigger to fix
 * expandField (add a proper range/step branch).
 */

import { describe, it, expect } from 'vitest';
import { nextFireFromCron } from '../../../src/daemon/cron-scheduler';
import { parseDurationMs } from '../../../src/bus/cron-state';

/**
 * Every DISTINCT schedule string across all enabled live crons, snapshotted
 * 2026-08-11. Interval shorthands (4h/15m/…) are parsed by parseDurationMs;
 * the rest are 5-field cron expressions parsed by nextFireFromCron.
 */
const LIVE_CRON_EXPRESSIONS: readonly string[] = [
  // interval shorthands
  '4h', '6h', '2h', '8h', '5m', '15m', '24h', '7d',
  // 5-field cron expressions actually in the fleet
  '0 8 * * 1-5',
  '0 9 * * 1',
  '0 2 * * 2-6',
  '0 17 * * 5',
  '0 16 1,15 * *',
  '0 20 * * 0',
  '30 16 * * 1-5',
  '3 18 * * 5',
  '7 14 * * 6',
  '3 16 * * 5',
  '3 10 * * 0',
  '2 10 * * 1,3,5',
  '4 9 * * 3',
  '3 15 * * 4',
  '3 2 * * *',
  '5 15 * * *',
  '0 17 * * 0',
  '7 2 * * *',
  '*/15 7-19 * * 1-5',
  '0 17 * * 1-5',
  '0 9 * * *',
  '0 18 * * *',
  '0 12 * * 5',
  '15 6,18 * * *',
  '0 6 * * 1-5',
  '0 11 * * 4',
  '7 23 * * *',
  '7 6 * * *',
  '30 2 * * *',
  '7 3 * * 3',
  '52 2 * * *',
  '37 3 * * *',
  '12 3 * * *',
  '0 */2 * * *',
  '0 15 * * 1-5',
  '30 7 * * *',
  '3 8 * * 1-5',
  '2 17 * * 1-5',
  '0 */4 * * *',
  '0 8 * * 1',
  '0 9 * * 0',
  '0 7 * * 1-5',
  '0 6 * * 1',
  '0 18 * * 5',
];

describe('FR-C4: live-fleet cron parser reproduction', () => {
  const from = Date.parse('2026-08-11T00:00:00Z');

  it('parses EVERY distinct live schedule string (no NaN)', () => {
    const failures: string[] = [];
    for (const expr of LIVE_CRON_EXPRESSIONS) {
      const dur = parseDurationMs(expr);
      if (!Number.isNaN(dur)) {
        // interval shorthand — must be a positive duration
        if (dur <= 0) failures.push(`${expr} -> non-positive shorthand ${dur}`);
        continue;
      }
      const next = nextFireFromCron(expr, from);
      if (Number.isNaN(next)) {
        failures.push(`${expr} -> NaN (unparseable)`);
      } else if (next <= from) {
        failures.push(`${expr} -> next fire ${new Date(next).toISOString()} not after fromMs`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('correctly parses star-slash-N minute steps (the "step-value" form the spec worried about)', () => {
    // */15 within an hour window, weekdays — this is pre-meeting-brief-page, a live cron.
    const next = nextFireFromCron('*/15 7-19 * * 1-5', from);
    expect(next).not.toBeNaN();
    const d = new Date(next);
    expect(d.getMinutes() % 15).toBe(0);
  });

  it('correctly parses every-N-hours steps (0 */2 / 0 */4)', () => {
    for (const expr of ['0 */2 * * *', '0 */4 * * *']) {
      const next = nextFireFromCron(expr, from);
      expect(next, expr).not.toBeNaN();
      expect(new Date(next).getMinutes(), expr).toBe(0);
    }
  });

  it('correctly parses comma-lists and ranges in the dow/dom fields', () => {
    for (const expr of ['2 10 * * 1,3,5', '0 8 * * 1-5', '0 16 1,15 * *']) {
      expect(nextFireFromCron(expr, from), expr).not.toBeNaN();
    }
  });
});

describe('FR-C4: LATENT range-with-step gap (affects ZERO live crons)', () => {
  const from = Date.parse('2026-08-11T00:00:00Z');

  it('documents that "a-b/N" SILENTLY mis-parses (drops the step, does not NaN)', () => {
    // "0-30/5" intends minutes {0,5,10,15,20,25,30}. The parser drops "/5" and
    // expands 0..30 (every minute in the range). We assert the mis-parse is
    // observable: a step-5 expression fires at a minute that a correct parser
    // would SKIP (e.g. minute 1), proving the step was ignored.
    // 0-30/5 at 00:00 -> correct next fire is 00:05; mis-parse gives 00:01.
    const next = nextFireFromCron('0-30/5 * * * *', from);
    expect(next, 'range-with-step should not NaN with current parser').not.toBeNaN();
    expect(new Date(next).getMinutes()).toBe(1); // proves "/5" was dropped
  });

  it('none of the live expressions uses the range-with-step form', () => {
    const usesRangeStep = LIVE_CRON_EXPRESSIONS.some((e) =>
      e.split(/\s+/).some((field) => /-\d+\/\d+/.test(field)),
    );
    expect(usesRangeStep).toBe(false);
  });
});
