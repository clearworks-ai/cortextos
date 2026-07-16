import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_MEETING_TTL_SEC,
  deriveMeetingKey,
  evaluateMeetingAlert,
  normalizeMeetingSubject,
} from '../../../src/utils/meeting-alert-gate.js';
import { isValidSourceKey } from '../../../src/utils/event-dedup.js';

describe('meeting-alert-gate', () => {
  let ctxRoot: string;
  let nowMs: number;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'meeting-alert-gate-'));
    nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function ledgerPath(): string {
    return join(ctxRoot, 'state', 'comms-event-dedup.json');
  }

  function readLedger(): Record<string, { firstSeenAt: number; fireOnce: boolean }> {
    return JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as Record<
      string,
      { firstSeenAt: number; fireOnce: boolean }
    >;
  }

  function seedLedger(entries: Record<string, { firstSeenAt: number; fireOnce: boolean }>): void {
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify(entries), 'utf-8');
  }

  function nowSec(): number {
    return Math.floor(nowMs / 1000);
  }

  it('surfaces the first event-id meeting alert and records the derived key', () => {
    const result = evaluateMeetingAlert(ctxRoot, { eventId: 'abc123@google.com' });

    expect(result).toEqual({
      surface: true,
      reason: 'surface: first alert for this meeting',
      key: 'meeting:evt-abc123@google.com',
    });
    expect(isValidSourceKey(result.key ?? '')).toBe(true);
    expect(readLedger()).toEqual({
      'meeting:evt-abc123@google.com': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });

  it('suppresses the same eventId on the second alert and reports the prior age', () => {
    evaluateMeetingAlert(ctxRoot, { eventId: 'abc123@google.com' });

    nowMs += 10_000;
    const result = evaluateMeetingAlert(ctxRoot, { eventId: 'abc123@google.com' });

    expect(result).toEqual({
      surface: false,
      reason: 'skip: meeting already alerted (10s ago)',
      key: 'meeting:evt-abc123@google.com',
    });
  });

  it('suppresses fallback-title rewordings that normalize to the same meeting key', () => {
    const first = evaluateMeetingAlert(ctxRoot, {
      subject: 'E-Rate for Scholarship Prep',
      date: '2026-07-16',
    });
    nowMs += 1_000;
    const second = evaluateMeetingAlert(ctxRoot, {
      subject: 'Re: E-rate for scholarship prep!',
      date: '2026-07-16',
    });
    nowMs += 1_000;
    const third = evaluateMeetingAlert(ctxRoot, {
      subject: 'FWD: e rate for scholarship prep',
      date: '2026-07-16',
    });

    expect(first.key).toBe('meeting:subj-erateforscholarshipprep-2026-07-16');
    expect(second.key).toBe(first.key);
    expect(third.key).toBe(first.key);
    expect(second.surface).toBe(false);
    expect(third.surface).toBe(false);
  });

  it('surfaces distinct meetings independently across eventId, title, and date boundaries', () => {
    const eventA = evaluateMeetingAlert(ctxRoot, { eventId: 'event-a@google.com' });
    const eventB = evaluateMeetingAlert(ctxRoot, { eventId: 'event-b@google.com' });
    const titleA = evaluateMeetingAlert(ctxRoot, {
      subject: 'Scholarship Prep',
      date: '2026-07-16',
    });
    const titleB = evaluateMeetingAlert(ctxRoot, {
      subject: 'Budget Review',
      date: '2026-07-16',
    });
    const recurringA = evaluateMeetingAlert(ctxRoot, {
      subject: 'Board Sync',
      date: '2026-07-16',
    });
    const recurringB = evaluateMeetingAlert(ctxRoot, {
      subject: 'Board Sync',
      date: '2026-07-23',
    });

    expect(eventA.surface).toBe(true);
    expect(eventB.surface).toBe(true);
    expect(titleA.surface).toBe(true);
    expect(titleB.surface).toBe(true);
    expect(recurringA.surface).toBe(true);
    expect(recurringB.surface).toBe(true);
  });

  it('derives and gates subject-plus-date meetings when no eventId exists', () => {
    const first = evaluateMeetingAlert(ctxRoot, {
      subject: 'Vendor Check-In',
      date: '2026-07-18',
    });
    const second = evaluateMeetingAlert(ctxRoot, {
      subject: 'Vendor Check-In',
      date: '2026-07-18',
    });

    expect(first.key).toBe('meeting:subj-vendorcheckin-2026-07-18');
    expect(first.surface).toBe(true);
    expect(second.surface).toBe(false);
  });

  it('implements the derivation edge table exactly', () => {
    expect(normalizeMeetingSubject(' Re: FWD: E-Rate for Scholarship Prep! ')).toBe(
      'erateforscholarshipprep',
    );
    expect(deriveMeetingKey({ eventId: ' abc:123?@google.com ' })).toBe(
      'meeting:evt-abc123@google.com',
    );
    expect(deriveMeetingKey({
      eventId: ':::',
      subject: 'Re: Demo Meeting',
      date: '2026-07-16',
    })).toBe('meeting:subj-demomeeting-2026-07-16');
    expect(deriveMeetingKey({ subject: 'Demo Meeting', date: '7/16/2026' })).toBeNull();
    expect(deriveMeetingKey({ subject: 'Demo Meeting', date: '2026-7-16' })).toBeNull();
    expect(deriveMeetingKey({ subject: '!!!', date: '2026-07-16' })).toBeNull();
    expect(deriveMeetingKey({})).toBeNull();
  });

  it('fails open when no meeting key can be derived and writes nothing to the ledger', () => {
    const result = evaluateMeetingAlert(ctxRoot, {});

    expect(result.surface).toBe(true);
    expect(result.reason).toContain('fail-open');
    expect(result.key).toBeNull();
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('re-surfaces after ttl expiry and refreshes the ledger timestamp', () => {
    const key = 'meeting:evt-abc123@google.com';
    seedLedger({
      [key]: {
        firstSeenAt: nowSec() - DEFAULT_MEETING_TTL_SEC - 1,
        fireOnce: false,
      },
    });

    const result = evaluateMeetingAlert(ctxRoot, { eventId: 'abc123@google.com' });

    expect(result).toEqual({
      surface: true,
      reason: 'surface: first alert for this meeting',
      key,
    });
    expect(readLedger()).toEqual({
      [key]: { firstSeenAt: nowSec(), fireOnce: false },
    });
  });
});
