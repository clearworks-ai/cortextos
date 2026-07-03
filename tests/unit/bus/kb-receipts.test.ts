/**
 * tests/unit/bus/kb-receipts.test.ts — WS5b fail-loud ingest receipts.
 *
 * Uses REAL fs against a per-test tempdir: HOME is pointed at the tempdir so
 * os.homedir() (which the module uses for its state paths) resolves inside
 * it. vi.resetModules() + dynamic import per test follows the crons-io.test.ts
 * pattern so path resolution always picks up the fresh HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Per-test tempdir wiring (HOME redirect)
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kb-receipts-test-'));
  process.env.HOME = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

async function importReceipts() {
  return import('../../../src/bus/kb-receipts.js');
}

function makeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    run_at: '2026-07-03T12:00:00.000Z',
    collection: 'shared-TestOrg',
    added: 3,
    updated: 1,
    skipped: 0,
    errored: 0,
    duration_ms: 4200,
    exit_code: 0,
    status: 'ok' as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseMmragReceiptLine
// ---------------------------------------------------------------------------

describe('parseMmragReceiptLine', () => {
  it('returns null when no receipt line is present', async () => {
    const { parseMmragReceiptLine } = await importReceipts();
    expect(parseMmragReceiptLine('just some\nplain output\n')).toBeNull();
    expect(parseMmragReceiptLine('')).toBeNull();
  });

  it('parses counts from a valid receipt line', async () => {
    const { parseMmragReceiptLine } = await importReceipts();
    const out = 'Ingesting...\nMMRAG_INGEST_RECEIPT {"added":3,"updated":1,"skipped":2,"errored":0}\ndone\n';
    expect(parseMmragReceiptLine(out)).toEqual({ added: 3, updated: 1, skipped: 2, errored: 0 });
  });

  it('picks the LAST receipt line when several are present', async () => {
    const { parseMmragReceiptLine } = await importReceipts();
    const out =
      'MMRAG_INGEST_RECEIPT {"added":1,"updated":0,"skipped":0,"errored":0}\n' +
      'more output\n' +
      'MMRAG_INGEST_RECEIPT {"added":9,"updated":2,"skipped":1,"errored":3}\n';
    expect(parseMmragReceiptLine(out)).toEqual({ added: 9, updated: 2, skipped: 1, errored: 3 });
  });

  it('rejects malformed JSON on the receipt line (returns null)', async () => {
    const { parseMmragReceiptLine } = await importReceipts();
    expect(parseMmragReceiptLine('MMRAG_INGEST_RECEIPT {not json at all\n')).toBeNull();
  });

  it('does NOT fall back to an earlier valid line when the last one is malformed', async () => {
    const { parseMmragReceiptLine } = await importReceipts();
    const out =
      'MMRAG_INGEST_RECEIPT {"added":1,"updated":0,"skipped":0,"errored":0}\n' +
      'MMRAG_INGEST_RECEIPT {broken\n';
    expect(parseMmragReceiptLine(out)).toBeNull();
  });

  it('non-numeric or missing count fields become null (partial counts tolerated)', async () => {
    const { parseMmragReceiptLine } = await importReceipts();
    const out = 'MMRAG_INGEST_RECEIPT {"added":"3","errored":2}\n';
    expect(parseMmragReceiptLine(out)).toEqual({ added: null, updated: null, skipped: null, errored: 2 });
  });
});

// ---------------------------------------------------------------------------
// writeKBIngestReceipt + readLastKBIngestReceipt
// ---------------------------------------------------------------------------

describe('writeKBIngestReceipt / readLastKBIngestReceipt', () => {
  it('writes last-ingest-receipt.json under ~/.cortextos/<instance>/state/kb/ with exact counts', async () => {
    const { writeKBIngestReceipt } = await importReceipts();

    writeKBIngestReceipt('inst1', 'TestOrg', makeReceipt());

    const path = join(tmpRoot, '.cortextos', 'inst1', 'state', 'kb', 'last-ingest-receipt.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed).toMatchObject({
      org: 'TestOrg',
      collection: 'shared-TestOrg',
      added: 3,
      updated: 1,
      errored: 0,
      exit_code: 0,
      status: 'ok',
    });
  });

  it('appends one JSON line per write to ingest-receipts.jsonl (history preserved)', async () => {
    const { writeKBIngestReceipt } = await importReceipts();

    writeKBIngestReceipt('inst1', 'TestOrg', makeReceipt());
    writeKBIngestReceipt('inst1', 'TestOrg', makeReceipt({ status: 'error', exit_code: 2, errored: 4 }));

    const jsonlPath = join(tmpRoot, '.cortextos', 'inst1', 'state', 'kb', 'ingest-receipts.jsonl');
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).status).toBe('ok');
    expect(JSON.parse(lines[1])).toMatchObject({ status: 'error', exit_code: 2, errored: 4 });
  });

  it('roundtrips via readLastKBIngestReceipt (latest write wins)', async () => {
    const { writeKBIngestReceipt, readLastKBIngestReceipt } = await importReceipts();

    writeKBIngestReceipt('inst1', 'TestOrg', makeReceipt());
    writeKBIngestReceipt('inst1', 'TestOrg', makeReceipt({ status: 'timeout', exit_code: -1, error: 'ETIMEDOUT' }));

    const last = readLastKBIngestReceipt('inst1');
    expect(last).not.toBeNull();
    expect(last).toMatchObject({ status: 'timeout', exit_code: -1, error: 'ETIMEDOUT' });
  });

  it('readLastKBIngestReceipt returns null when no receipt has ever been written', async () => {
    const { readLastKBIngestReceipt } = await importReceipts();
    expect(readLastKBIngestReceipt('ghost-instance')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through ingestKnowledgeBase (child_process mocked, fs REAL)
// ---------------------------------------------------------------------------

const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

describe('ingestKnowledgeBase → receipt files on disk (real fs)', () => {
  async function setupConfiguredKb(instanceId: string, org: string) {
    // Real files: create the MMRAG config so kbConfigured() passes.
    const { mkdirSync, writeFileSync } = await import('fs');
    const kbRoot = join(tmpRoot, '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
    mkdirSync(kbRoot, { recursive: true });
    writeFileSync(join(kbRoot, 'config.json'), '{}', 'utf-8');
  }

  const options = {
    org: 'TestOrg',
    agent: 'tester',
    frameworkRoot: join(tmpdir(), 'no-such-framework-root'),
    instanceId: 'e2e',
  };

  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('mocked success with a receipt line lands exact counts in last-ingest-receipt.json + a jsonl line', async () => {
    await setupConfiguredKb('e2e', 'TestOrg');
    execFileSyncMock.mockReturnValue(
      'MMRAG_INGEST_RECEIPT {"added":7,"updated":2,"skipped":1,"errored":0}\n',
    );

    const { ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      ingestKnowledgeBase(['/some/file.md'], options);
    } finally {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
    }

    const receiptPath = join(tmpRoot, '.cortextos', 'e2e', 'state', 'kb', 'last-ingest-receipt.json');
    expect(existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(receiptPath, 'utf-8'))).toMatchObject({
      added: 7,
      updated: 2,
      skipped: 1,
      errored: 0,
      exit_code: 0,
      status: 'ok',
    });

    const jsonlPath = join(tmpRoot, '.cortextos', 'e2e', 'state', 'kb', 'ingest-receipts.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    expect(readFileSync(jsonlPath, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('mocked timeout produces a status:timeout receipt on disk AND a re-thrown error', async () => {
    await setupConfiguredKb('e2e', 'TestOrg');
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync python3 ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
        status: null,
        stdout: '',
        stderr: '',
      });
    });

    const { ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => ingestKnowledgeBase(['/some/file.md'], options)).toThrow(/ETIMEDOUT/);
    } finally {
      logSpy.mockRestore();
    }

    const receiptPath = join(tmpRoot, '.cortextos', 'e2e', 'state', 'kb', 'last-ingest-receipt.json');
    expect(JSON.parse(readFileSync(receiptPath, 'utf-8'))).toMatchObject({
      status: 'timeout',
      added: null,
      errored: null,
    });
  });
});
