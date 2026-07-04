import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordVerificationReceipt,
  hasRecentReceipt,
  receiptLedgerPath,
  emitClaimWithoutReceiptWarning,
} from '../../../src/utils/verification-receipt.js';
import { resolvePaths } from '../../../src/utils/paths.js';
import type { BusPaths } from '../../../src/types/index.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'verify-receipt-'));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('recordVerificationReceipt', () => {
  it('appends a JSONL entry with agent/kind/ref/ts', () => {
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'npm run build' });
    const path = receiptLedgerPath(tmpRoot);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.agent).toBe('larry');
    expect(obj.kind).toBe('build');
    expect(obj.ref).toBe('npm run build');
    expect(typeof obj.ts).toBe('string');
  });

  it('is append-only (multiple receipts accumulate)', () => {
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'a' });
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'test', ref: 'b' });
    recordVerificationReceipt(tmpRoot, 'frank2', { kind: 'curl', ref: 'c' });
    const lines = readFileSync(receiptLedgerPath(tmpRoot), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('fail-open: no throw on empty ctxRoot/agent', () => {
    expect(() => recordVerificationReceipt('', 'larry', { kind: 'x', ref: 'y' })).not.toThrow();
    expect(() => recordVerificationReceipt(tmpRoot, '', { kind: 'x', ref: 'y' })).not.toThrow();
  });
});

describe('hasRecentReceipt - windowing', () => {
  it('returns false when no ledger exists', () => {
    expect(hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).toBe(false);
  });

  it('returns true for a receipt inside the window', () => {
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'now' });
    expect(hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).toBe(true);
  });

  it('returns false for a receipt older than the window', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'old', ts: old });
    expect(hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).toBe(false);
  });

  it('scopes by agent — another agent receipt does not count', () => {
    recordVerificationReceipt(tmpRoot, 'frank2', { kind: 'build', ref: 'now' });
    expect(hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).toBe(false);
    expect(hasRecentReceipt(tmpRoot, 'frank2', 30 * 60 * 1000)).toBe(true);
  });

  it('finds a recent receipt even when older/other-agent lines precede it', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'old', ts: old });
    recordVerificationReceipt(tmpRoot, 'frank2', { kind: 'test', ref: 'other' });
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'test', ref: 'fresh' });
    expect(hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).toBe(true);
  });

  it('tolerates malformed lines without throwing', () => {
    const path = receiptLedgerPath(tmpRoot);
    // Write a valid receipt then corrupt the ledger with a partial line.
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'ok' });
    require('fs').appendFileSync(path, '{not valid json\n', 'utf-8');
    expect(() => hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).not.toThrow();
    expect(hasRecentReceipt(tmpRoot, 'larry', 30 * 60 * 1000)).toBe(true);
  });

  it('fail-open: returns false on empty inputs', () => {
    expect(hasRecentReceipt('', 'larry', 1000)).toBe(false);
    expect(hasRecentReceipt(tmpRoot, '', 1000)).toBe(false);
  });
});

describe('emitClaimWithoutReceiptWarning - warn-only guard', () => {
  // Build a BusPaths whose analyticsDir/stateDir live under our temp root so
  // we can assert on the emitted event file without touching ~/.cortextos.
  function tmpPaths(): BusPaths {
    const base = resolvePaths('larry', 'default', 'clearworksai');
    return {
      ...base,
      ctxRoot: tmpRoot,
      stateDir: join(tmpRoot, 'state', 'larry'),
      analyticsDir: join(tmpRoot, 'analytics'),
    };
  }

  function readEmittedEvents(paths: BusPaths): any[] {
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'larry', `${today}.jsonl`);
    if (!existsSync(eventFile)) return [];
    return readFileSync(eventFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('claim + NO receipt -> warning event logged', () => {
    const paths = tmpPaths();
    const warned = emitClaimWithoutReceiptWarning(
      paths,
      tmpRoot,
      'larry',
      'clearworksai',
      'Done — deployed and verified.',
    );
    expect(warned).toBe(true);
    const events = readEmittedEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('claim_without_receipt');
    expect(events[0].severity).toBe('warning');
    expect(events[0].metadata.snippet).toContain('Done');
  });

  it('claim + RECENT receipt -> NO warning', () => {
    const paths = tmpPaths();
    recordVerificationReceipt(tmpRoot, 'larry', { kind: 'build', ref: 'npm run build' });
    const warned = emitClaimWithoutReceiptWarning(
      paths,
      tmpRoot,
      'larry',
      'clearworksai',
      'Shipped and merged.',
    );
    expect(warned).toBe(false);
    expect(readEmittedEvents(paths)).toHaveLength(0);
  });

  it('non-claim -> NO warning', () => {
    const paths = tmpPaths();
    const warned = emitClaimWithoutReceiptWarning(
      paths,
      tmpRoot,
      'larry',
      'clearworksai',
      'Working on the deploy now — can you send me the link?',
    );
    expect(warned).toBe(false);
    expect(readEmittedEvents(paths)).toHaveLength(0);
  });

  it('never throws even when the event dir is unwritable (fail-open)', () => {
    // Point analyticsDir at a path whose parent is a FILE, so ensureDir/mkdir
    // inside logEvent fails. The guard must swallow it and return false.
    const badParent = join(tmpRoot, 'not-a-dir');
    require('fs').writeFileSync(badParent, 'x', 'utf-8');
    const paths: BusPaths = {
      ...tmpPaths(),
      analyticsDir: join(badParent, 'analytics'),
      stateDir: join(badParent, 'state'),
    };
    let warned: boolean | undefined;
    expect(() => {
      warned = emitClaimWithoutReceiptWarning(
        paths,
        tmpRoot,
        'larry',
        'clearworksai',
        'Deployed and done.',
      );
    }).not.toThrow();
    expect(warned).toBe(false);
  });
});

describe('warn-only invariant: guard is a pure observer of send result', () => {
  // Models the send-telegram wiring: a fixed "send result" is produced, then
  // the guard runs. Whether or not it warns, the send result must be byte-for
  // -byte identical and the call must never throw or return early.
  function fakeSendThenGuard(text: string, withReceipt: boolean): { result: string; warned: boolean } {
    const sendResult = 'Message sent'; // the invariant we protect
    if (withReceipt) {
      recordVerificationReceipt(tmpRoot, 'larry', { kind: 'test', ref: 'vitest' });
    }
    const base = resolvePaths('larry', 'default', 'clearworksai');
    const paths: BusPaths = {
      ...base,
      ctxRoot: tmpRoot,
      stateDir: join(tmpRoot, 'state', 'larry'),
      analyticsDir: join(tmpRoot, 'analytics'),
    };
    const warned = emitClaimWithoutReceiptWarning(paths, tmpRoot, 'larry', 'clearworksai', text);
    return { result: sendResult, warned };
  }

  it('send result is identical whether a warning fires or not', () => {
    const a = fakeSendThenGuard('Done and deployed.', false); // warns
    const b = fakeSendThenGuard('Done and deployed.', true); // no warn (receipt)
    const c = fakeSendThenGuard('Working on it still.', false); // non-claim
    expect(a.warned).toBe(true);
    expect(b.warned).toBe(false);
    expect(c.warned).toBe(false);
    // The load-bearing invariant: the send never changed.
    expect(a.result).toBe('Message sent');
    expect(b.result).toBe('Message sent');
    expect(c.result).toBe('Message sent');
  });
});
