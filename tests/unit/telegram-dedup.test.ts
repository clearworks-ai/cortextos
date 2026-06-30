import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkAndRecord, dedupKey } from '../../src/telegram/dedup';

describe('telegram dedup', () => {
  let ctxRoot: string;
  let nowMs: number;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-tg-dedup-'));
    nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function ledgerPath(): string {
    return join(ctxRoot, 'state', 'telegram-dedup.json');
  }

  function seedLedgerFile(contents: string): void {
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    writeFileSync(ledgerPath(), contents, 'utf-8');
  }

  function readLedger(): Record<string, number> {
    return JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as Record<string, number>;
  }

  it('records the first send as new', () => {
    const result = checkAndRecord(ctxRoot, '123', 'hello world', 300);

    expect(result).toEqual({ duplicate: false });
    expect(readLedger()).toEqual({
      [dedupKey('123', 'hello world')]: Math.floor(nowMs / 1000),
    });
  });

  it('suppresses an identical body within the window without mutating the ledger', () => {
    checkAndRecord(ctxRoot, '123', 'hello world', 300);
    const before = readLedger();

    nowMs += 120_000;
    const result = checkAndRecord(ctxRoot, '123', 'hello world', 300);

    expect(result).toEqual({ duplicate: true, ageSec: 120 });
    expect(readLedger()).toEqual(before);
  });

  it('treats whitespace-only body differences as duplicates', () => {
    checkAndRecord(ctxRoot, '123', 'a  b\n', 300);

    nowMs += 10_000;
    const result = checkAndRecord(ctxRoot, '123', '  a b  ', 300);

    expect(result).toEqual({ duplicate: true, ageSec: 10 });
  });

  it('records a different body as a new ledger entry', () => {
    checkAndRecord(ctxRoot, '123', 'hello world', 300);

    nowMs += 30_000;
    const result = checkAndRecord(ctxRoot, '123', 'different body', 300);

    expect(result).toEqual({ duplicate: false });
    expect(Object.keys(readLedger())).toHaveLength(2);
  });

  it('re-anchors an expired entry to the current send time', () => {
    const expiredTs = Math.floor(nowMs / 1000) - 301;
    seedLedgerFile(
      JSON.stringify({ [dedupKey('123', 'hello world')]: expiredTs }),
    );

    const result = checkAndRecord(ctxRoot, '123', 'hello world', 300);

    expect(result).toEqual({ duplicate: false });
    expect(readLedger()).toEqual({
      [dedupKey('123', 'hello world')]: Math.floor(nowMs / 1000),
    });
  });

  it('tolerates a corrupt ledger file and rewrites it from scratch', () => {
    seedLedgerFile('{not json');

    const result = checkAndRecord(ctxRoot, '123', 'hello world', 300);

    expect(result).toEqual({ duplicate: false });
    expect(readLedger()).toEqual({
      [dedupKey('123', 'hello world')]: Math.floor(nowMs / 1000),
    });
  });

  it('produces stable dedup keys that vary by chat id', () => {
    expect(dedupKey('123', 'a  b')).toBe(dedupKey('123', 'a b'));
    expect(dedupKey('123', 'a b')).not.toBe(dedupKey('456', 'a b'));
  });
});
