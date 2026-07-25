/**
 * cron-liveness.ts — overdue detector for FastChecker (cron-register-reliability Phase 6).
 * Pure helpers; FastChecker owns restart/circuit escalation.
 */

import { parseDurationMs } from '../bus/cron-state.js';
import type { CronDefinition } from '../types/index.js';
import { CronScheduler } from './cron-scheduler.js';

export interface CronLivenessInput {
  cron: CronDefinition;
  /** ISO last fire from cron-state.json if any */
  stateLastFire?: string;
  nowMs: number;
  /** Previous pollCycle time — used for wake-skip when gap is huge */
  lastCheckMs?: number;
}

export interface CronLivenessResult {
  overdue: boolean;
  reason?: string;
  wakeSkip?: boolean;
}

const GRACE_MS = Math.max(2 * CronScheduler.TICK_INTERVAL_MS, 5 * 60_000);

function parseIsoMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Compute interval length for interval schedules ("6h") or approximate for 5-field
 * by using previous scheduled slot distance from now via nextFireFromCron helpers.
 */
export function scheduleIntervalMs(cron: CronDefinition, nowMs: number): number | null {
  const s = (cron.schedule || '').trim();
  if (/^\d+[smhdw]$/i.test(s)) {
    try {
      return parseDurationMs(s);
    } catch {
      return null;
    }
  }
  // 5-field: use 24h as conservative interval for overdue threshold
  if (s.split(/\s+/).length === 5) {
    void nowMs;
    return 24 * 60 * 60_000;
  }
  return null;
}

export function evaluateCronLiveness(input: CronLivenessInput): CronLivenessResult {
  const { cron, stateLastFire, nowMs, lastCheckMs } = input;
  if (cron.enabled === false) return { overdue: false };

  if (lastCheckMs !== undefined && nowMs - lastCheckMs > 10 * 60_000) {
    return { overdue: false, wakeSkip: true };
  }

  const interval = scheduleIntervalMs(cron, nowMs);
  if (interval === null) return { overdue: false };

  const candidates = [
    parseIsoMs(cron.last_fired_at),
    parseIsoMs(cron.last_fire_attempted_at),
    parseIsoMs(stateLastFire),
  ].filter((n): n is number => n !== null);

  let baseline: number;
  if (candidates.length === 0) {
    const created = parseIsoMs(cron.created_at);
    if (created === null) return { overdue: false };
    baseline = created;
    // brand-new cron: only overdue if past first expected interval + grace
  } else {
    baseline = Math.max(...candidates);
  }

  const limit = interval + GRACE_MS;
  if (nowMs - baseline > limit) {
    return {
      overdue: true,
      reason: `cron '${cron.name}' overdue by ${Math.round((nowMs - baseline - interval) / 60000)}m`,
    };
  }
  return { overdue: false };
}
