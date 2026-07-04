import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkAndRecordSourceEvent, isValidSourceKey } from '../../../src/utils/event-dedup';

const DAY_SEC = 86400;

describe('event dedup', () => {
  let ctxRoot: string;
  let nowMs: number;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-event-dedup-'));
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

  function seedLedgerFile(contents: string): void {
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    writeFileSync(ledgerPath(), contents, 'utf-8');
  }

  function readLedger(): Record<string, { firstSeenAt: number; fireOnce: boolean }> {
    return JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as Record<
      string,
      { firstSeenAt: number; fireOnce: boolean }
    >;
  }

  function nowSec(): number {
    return Math.floor(nowMs / 1000);
  }

  describe('isValidSourceKey', () => {
    it('accepts real-world source keys', () => {
      expect(isValidSourceKey('gmail:18f3c2b1a9')).toBe(true);
      expect(isValidSourceKey('gmail:<abc@mail.gmail.com>')).toBe(true);
      expect(isValidSourceKey('calendar:abc123xyz@google.com')).toBe(true);
      expect(isValidSourceKey('imessage:ABCD-1234')).toBe(true);
    });

    it('rejects malformed source keys', () => {
      expect(isValidSourceKey('18f3c2b1a9')).toBe(false);
      expect(isValidSourceKey('Gmail:18f3c2b1a9')).toBe(false);
      expect(isValidSourceKey('gmail:')).toBe(false);
      expect(isValidSourceKey(':abc')).toBe(false);
      expect(isValidSourceKey('')).toBe(false);
      expect(isValidSourceKey(`gmail:${'x'.repeat(513)}`)).toBe(false);
      expect(isValidSourceKey(`${'a'.repeat(33)}:abc`)).toBe(false);
    });
  });

  it('surfaces the first sighting and writes the ledger entry', () => {
    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    expect(result).toEqual({ surface: true, reason: 'first-seen' });
    expect(readLedger()).toEqual({
      'gmail:18f3c2b1a9': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });

  it('suppresses the same key again without mutating the timestamp', () => {
    checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');
    const before = readLedger();

    nowMs += 120_000;
    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    expect(result).toEqual({ surface: false, reason: 'duplicate', ageSec: 120 });
    expect(readLedger()).toEqual(before);
  });

  it('treats the same id in different namespaces as distinct events', () => {
    const first = checkAndRecordSourceEvent(ctxRoot, 'gmail:abc123');
    const second = checkAndRecordSourceEvent(ctxRoot, 'calendar:abc123');

    expect(first).toEqual({ surface: true, reason: 'first-seen' });
    expect(second).toEqual({ surface: true, reason: 'first-seen' });
    expect(Object.keys(readLedger())).toHaveLength(2);
  });

  it('surfaces again after ttl expiry and refreshes the timestamp', () => {
    checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    nowMs += (30 * DAY_SEC + 1) * 1000;
    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    expect(result).toEqual({ surface: true, reason: 'first-seen' });
    expect(readLedger()).toEqual({
      'gmail:18f3c2b1a9': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });

  it('skips a fireOnce entry even after the ttl window would have expired', () => {
    checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9', { fireOnce: true });

    nowMs += 60 * DAY_SEC * 1000;
    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    expect(result).toEqual({
      surface: false,
      reason: 'duplicate-fire-once',
      ageSec: 60 * DAY_SEC,
    });
  });

  it('prunes a fireOnce entry after 366 days so it surfaces again', () => {
    checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9', { fireOnce: true });

    nowMs += 366 * DAY_SEC * 1000;
    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    expect(result).toEqual({ surface: true, reason: 'first-seen' });
    expect(readLedger()).toEqual({
      'gmail:18f3c2b1a9': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });

  it('prunes old non-fireOnce entries on write but keeps young fireOnce entries', () => {
    const staleTs = nowSec() - 31 * DAY_SEC;
    const fireOnceTs = nowSec() - 100 * DAY_SEC;
    seedLedgerFile(
      JSON.stringify({
        'gmail:stale-old-mail': { firstSeenAt: staleTs, fireOnce: false },
        'imessage:pinned-guid': { firstSeenAt: fireOnceTs, fireOnce: true },
      }),
    );

    const result = checkAndRecordSourceEvent(ctxRoot, 'calendar:fresh@google.com');

    expect(result).toEqual({ surface: true, reason: 'first-seen' });
    expect(readLedger()).toEqual({
      'imessage:pinned-guid': { firstSeenAt: fireOnceTs, fireOnce: true },
      'calendar:fresh@google.com': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });

  it('tolerates a corrupt ledger and repairs it to valid JSON', () => {
    seedLedgerFile('{not json');

    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');

    expect(result).toEqual({ surface: true, reason: 'first-seen' });
    expect(readLedger()).toEqual({
      'gmail:18f3c2b1a9': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });

  it('drops individually malformed ledger entries but keeps valid ones', () => {
    seedLedgerFile(
      JSON.stringify({
        'gmail:valid-entry': { firstSeenAt: nowSec() - 60, fireOnce: false },
        'gmail:bad-entry': { firstSeenAt: 'yesterday', fireOnce: false },
        'gmail:worse-entry': 12345,
      }),
    );

    const result = checkAndRecordSourceEvent(ctxRoot, 'gmail:valid-entry');

    expect(result).toEqual({ surface: false, reason: 'duplicate', ageSec: 60 });
  });

  it('fails open on an invalid key without writing the ledger', () => {
    const result = checkAndRecordSourceEvent(ctxRoot, '18f3c2b1a9');

    expect(result).toEqual({ surface: true, reason: 'invalid-key' });
    expect(() => readLedger()).toThrow();
  });

  it('fails open on an empty ctxRoot without writing anything', () => {
    const result = checkAndRecordSourceEvent('', 'gmail:18f3c2b1a9');

    expect(result).toEqual({ surface: true, reason: 'no-ctx-root' });
    expect(() => readLedger()).toThrow();
  });

  it('upgrades an existing non-fireOnce entry when re-recorded with fireOnce', () => {
    checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');
    const firstSeenAt = nowSec();

    nowMs += 60_000;
    const upgrade = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9', { fireOnce: true });

    expect(upgrade).toEqual({ surface: false, reason: 'duplicate', ageSec: 60 });
    expect(readLedger()).toEqual({
      'gmail:18f3c2b1a9': { firstSeenAt, fireOnce: true },
    });

    nowMs += 45 * DAY_SEC * 1000;
    const afterTtl = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9');
    expect(afterTtl).toEqual({
      surface: false,
      reason: 'duplicate-fire-once',
      ageSec: 45 * DAY_SEC + 60,
    });
  });

  it('respects a custom ttlSec for duplicate detection', () => {
    checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9', { ttlSec: 300 });

    nowMs += 120_000;
    const within = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9', { ttlSec: 300 });
    expect(within).toEqual({ surface: false, reason: 'duplicate', ageSec: 120 });

    nowMs += 200_000;
    const after = checkAndRecordSourceEvent(ctxRoot, 'gmail:18f3c2b1a9', { ttlSec: 300 });
    expect(after).toEqual({ surface: true, reason: 'first-seen' });
    expect(readLedger()).toEqual({
      'gmail:18f3c2b1a9': { firstSeenAt: nowSec(), fireOnce: false },
    });
  });
});
