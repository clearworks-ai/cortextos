/**
 * tests/unit/bus/activity-ledger.test.ts — WS10 correlated did-vs-claimed ledger.
 *
 * Each test uses a fresh CTX_ROOT-style tempdir passed explicitly as ctxRoot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ActivityLedgerEntry } from '../../../src/bus/activity-ledger';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'activity-ledger-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

async function importLedger() {
  return import('../../../src/bus/activity-ledger.js');
}

function makeEntry(overrides: Partial<ActivityLedgerEntry> = {}): ActivityLedgerEntry {
  return {
    ts: '2026-07-03T10:00:00.000Z',
    agent: 'larry',
    claimed_action: 'deployed the briefs fix',
    verification: {
      command: 'curl -s -o /dev/null -w %{http_code} <briefs-url>',
      output_excerpt: '200',
      checked_at: '2026-07-03T10:00:05.000Z',
    },
    verified: true,
    correlation_id: 'corr_test_1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// append + read
// ---------------------------------------------------------------------------

describe('appendLedgerEntry / readLedger', () => {
  it('creates state/activity-ledger.jsonl and round-trips one entry', async () => {
    const { appendLedgerEntry, readLedger } = await importLedger();

    const entry = makeEntry();
    appendLedgerEntry(tmpRoot, entry);

    const path = join(tmpRoot, 'state', 'activity-ledger.jsonl');
    expect(existsSync(path)).toBe(true);

    const entries = readLedger(tmpRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it('returns [] for a missing ledger file', async () => {
    const { readLedger } = await importLedger();
    expect(readLedger(tmpRoot)).toEqual([]);
  });

  it('concurrent-ish double append yields 2 intact JSONL lines', async () => {
    const { appendLedgerEntry, readLedger } = await importLedger();

    const a = makeEntry({ correlation_id: 'corr_a' });
    const b = makeEntry({ correlation_id: 'corr_b', agent: 'frank2', verified: false, verification: null });

    // Fire both appends back-to-back without awaiting between them —
    // the lock in appendLedgerEntry must serialize the file writes.
    await Promise.all([
      Promise.resolve().then(() => appendLedgerEntry(tmpRoot, a)),
      Promise.resolve().then(() => appendLedgerEntry(tmpRoot, b)),
    ]);

    const raw = readFileSync(join(tmpRoot, 'state', 'activity-ledger.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');
    expect(lines).toHaveLength(2);
    // Every line must be independently parseable — no interleaved partial writes.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const entries = readLedger(tmpRoot);
    expect(entries.map(e => e.correlation_id).sort()).toEqual(['corr_a', 'corr_b']);
  });

  it('filters by agent, since, and limit', async () => {
    const { appendLedgerEntry, readLedger } = await importLedger();

    appendLedgerEntry(tmpRoot, makeEntry({ ts: '2026-07-01T00:00:00.000Z', agent: 'larry', correlation_id: 'c1' }));
    appendLedgerEntry(tmpRoot, makeEntry({ ts: '2026-07-02T00:00:00.000Z', agent: 'frank2', correlation_id: 'c2' }));
    appendLedgerEntry(tmpRoot, makeEntry({ ts: '2026-07-03T00:00:00.000Z', agent: 'larry', correlation_id: 'c3' }));

    expect(readLedger(tmpRoot, { agent: 'larry' }).map(e => e.correlation_id)).toEqual(['c1', 'c3']);
    expect(readLedger(tmpRoot, { since: '2026-07-02T00:00:00.000Z' }).map(e => e.correlation_id)).toEqual(['c2', 'c3']);
    expect(readLedger(tmpRoot, { limit: 1 }).map(e => e.correlation_id)).toEqual(['c3']);
  });

  it('skips torn/corrupt lines instead of failing the whole read', async () => {
    const { appendLedgerEntry, readLedger } = await importLedger();
    const { appendFileSync } = await import('fs');

    appendLedgerEntry(tmpRoot, makeEntry({ correlation_id: 'good' }));
    appendFileSync(join(tmpRoot, 'state', 'activity-ledger.jsonl'), '{"ts": "torn-line', 'utf-8');

    const entries = readLedger(tmpRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].correlation_id).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// correlate — the did-vs-claimed report
// ---------------------------------------------------------------------------

describe('correlate', () => {
  it('flags claimed-but-unverified entries and counts verified ones', async () => {
    const { appendLedgerEntry, correlate } = await importLedger();

    // Verified claim (has evidence + verified=true).
    appendLedgerEntry(tmpRoot, makeEntry({ correlation_id: 'ok' }));

    // Claimed with NO verification at all — the classic "fix is live" ping.
    appendLedgerEntry(tmpRoot, makeEntry({
      correlation_id: 'no_check',
      claimed_action: 'restarted sage after fleet restart',
      verification: null,
      verified: false,
    }));

    // Checked but the check did not confirm (verified=false with evidence).
    appendLedgerEntry(tmpRoot, makeEntry({
      correlation_id: 'check_failed',
      claimed_action: 'briefs dashboard link works',
      verification: {
        command: 'curl -s -o /dev/null -w %{http_code} <link>',
        output_excerpt: '404',
        checked_at: '2026-07-03T10:00:05.000Z',
      },
      verified: false,
    }));

    const report = correlate(tmpRoot);

    expect(report.verified).toBe(1);
    expect(report.claimed_unverified).toHaveLength(2);
    expect(report.claimed_unverified.map(e => e.correlation_id).sort()).toEqual(['check_failed', 'no_check']);
  });

  it('treats verification=null as unverified even if verified flag is true', async () => {
    const { appendLedgerEntry, correlate } = await importLedger();

    // A claim marked verified without evidence is still unverified — no
    // evidence means no verification, regardless of the flag.
    appendLedgerEntry(tmpRoot, makeEntry({
      correlation_id: 'flag_without_evidence',
      verification: null,
      verified: true,
    }));

    const report = correlate(tmpRoot);
    expect(report.verified).toBe(0);
    expect(report.claimed_unverified.map(e => e.correlation_id)).toEqual(['flag_without_evidence']);
  });

  it('returns an empty report for an empty ledger', async () => {
    const { correlate } = await importLedger();
    expect(correlate(tmpRoot)).toEqual({ claimed_unverified: [], verified: 0 });
  });
});
