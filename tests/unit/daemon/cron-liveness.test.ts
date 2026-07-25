import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateCronLiveness, scheduleIntervalMs } from '../../../src/daemon/cron-liveness.js';
import type { CronDefinition } from '../../../src/types/index.js';

describe('cron-liveness', () => {
  const base: CronDefinition = {
    name: 'heartbeat',
    prompt: 'ping',
    schedule: '30m',
    enabled: true,
    created_at: new Date(Date.now() - 90 * 60_000).toISOString(),
  };

  it('flags overdue when last fire is far past interval+grace', () => {
    const now = Date.now();
    const r = evaluateCronLiveness({
      cron: {
        ...base,
        last_fired_at: new Date(now - 90 * 60_000).toISOString(),
      },
      nowMs: now,
      lastCheckMs: now - 60_000,
    });
    expect(r.overdue).toBe(true);
  });

  it('silent when within interval', () => {
    const now = Date.now();
    const r = evaluateCronLiveness({
      cron: {
        ...base,
        last_fired_at: new Date(now - 20 * 60_000).toISOString(),
      },
      nowMs: now,
      lastCheckMs: now - 60_000,
    });
    expect(r.overdue).toBe(false);
  });

  it('silent for never-fired young cron', () => {
    const now = Date.now();
    const r = evaluateCronLiveness({
      cron: {
        ...base,
        created_at: new Date(now - 5 * 60_000).toISOString(),
        last_fired_at: undefined,
      },
      nowMs: now,
    });
    expect(r.overdue).toBe(false);
  });

  it('silent when disabled', () => {
    const now = Date.now();
    const r = evaluateCronLiveness({
      cron: { ...base, enabled: false, last_fired_at: new Date(now - 90 * 60_000).toISOString() },
      nowMs: now,
    });
    expect(r.overdue).toBe(false);
  });

  it('wake-skip when last check gap > 10min', () => {
    const now = Date.now();
    const r = evaluateCronLiveness({
      cron: { ...base, last_fired_at: new Date(now - 90 * 60_000).toISOString() },
      nowMs: now,
      lastCheckMs: now - 30 * 60_000,
    });
    expect(r.wakeSkip).toBe(true);
    expect(r.overdue).toBe(false);
  });

  it('scheduleIntervalMs parses 30m', () => {
    expect(scheduleIntervalMs(base, Date.now())).toBe(30 * 60_000);
  });
});
