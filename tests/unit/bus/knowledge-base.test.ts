import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Path-aware fs mocks. existsSync is the one we actually drive per-test:
// it returns true for any path EXCEPT the MMRAG_CONFIG one (when the test
// wants to simulate a missing config) so loadSecretsEnv and other path
// lookups still work normally inside the module under test.
const fsMocks = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof fsMocks.existsSync>) => fsMocks.existsSync(...args),
    readFileSync: (...args: Parameters<typeof fsMocks.readFileSync>) => fsMocks.readFileSync(...args),
    mkdirSync: (...args: Parameters<typeof fsMocks.mkdirSync>) => fsMocks.mkdirSync(...args),
  };
});

// Mock execFileSync so we can assert whether it was called (and optionally
// simulate a successful python response).
const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

// Mock normalizeOrgName to a passthrough identity — we are not testing org
// normalization here, that has its own dedicated test file.
vi.mock('../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => org,
}));

// Mock the receipt WRITER only (so no real files land under $HOME during
// these fs-mocked tests) while keeping the real parser — the success-path
// tests exercise parseMmragReceiptLine end-to-end through ingest.
const writeKBIngestReceiptMock = vi.fn();
vi.mock('../../../src/bus/kb-receipts.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/bus/kb-receipts.js')>(
    '../../../src/bus/kb-receipts.js',
  );
  return {
    ...actual,
    writeKBIngestReceipt: (...args: unknown[]) => writeKBIngestReceiptMock(...args),
  };
});

const { queryKnowledgeBase, ingestKnowledgeBase } = await import('../../../src/bus/knowledge-base.js');

// Minimal BusPaths stub — knowledge-base.ts doesn't actually USE the paths
// object at call time, just the options/env it constructs.
const dummyPaths = {
  stateDir: '/tmp/agent/state',
  logDir: '/tmp/agent/logs',
  ctxRoot: '/tmp/agent',
  instanceId: 'test',
  agentName: 'tester',
  org: 'TestOrg',
  inboxDir: '/tmp/agent/inbox',
  inflightDir: '/tmp/agent/inflight',
  processedDir: '/tmp/agent/processed',
  outboxDir: '/tmp/agent/outbox',
} as any;

const baseOptions = {
  org: 'TestOrg',
  agent: 'tester',
  frameworkRoot: '/home/test/cortextOS',
  instanceId: 'test',
};

let warnLog: string[] = [];
let originalWarn: typeof console.warn;
let logLog: string[] = [];
let originalLog: typeof console.log;
let errorLog: string[] = [];
let originalError: typeof console.error;
let stdoutWrites: string[] = [];
let stdoutSpy: { mockRestore(): void };
let stderrWrites: string[] = [];
let stderrSpy: { mockRestore(): void };

beforeEach(() => {
  fsMocks.existsSync.mockReset();
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.mkdirSync.mockReset();
  execFileSyncMock.mockReset();
  writeKBIngestReceiptMock.mockReset();

  warnLog = [];
  logLog = [];
  errorLog = [];
  stdoutWrites = [];
  originalWarn = console.warn;
  originalLog = console.log;
  originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logLog.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errorLog.push(args.map((a) => String(a)).join(' '));
  };
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  stderrWrites = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
  console.error = originalError;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

/**
 * Helper: make existsSync return false ONLY for paths that end with
 * knowledge-base/config.json (i.e. the MMRAG_CONFIG file), true for everything
 * else. Simulates a freshly-created agent with no KB configured yet.
 */
function mockMissingKbConfig(): void {
  fsMocks.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.endsWith('/knowledge-base/config.json')) return false;
    return true;
  });
}

/**
 * Helper: make existsSync return true for everything, simulating a fully
 * configured KB with config.json present on disk.
 */
function mockConfiguredKb(): void {
  fsMocks.existsSync.mockImplementation(() => true);
}

describe('ingestKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return cleanly, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    // Must NOT throw. Previously this path threw an unhandled execFileSync
    // error that dumped a Node stack trace on top of the python stderr.
    expect(() =>
      ingestKnowledgeBase(['/some/file.md'], baseOptions),
    ).not.toThrow();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Warn must include the org name AND an actionable hint ("run setup").
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    // Warn must carry the [kb] prefix so operators can filter log lines.
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called with the mmrag ingest args', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('');

    ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    // First positional arg is the python path, second is the argv array.
    const [pythonPath, argv] = execFileSyncMock.mock.calls[0] as [string, string[], object];
    expect(String(pythonPath)).toMatch(/python/);
    expect(argv).toEqual(expect.arrayContaining(['ingest', '/some/file.md']));
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('queryKnowledgeBase — graceful missing-config', () => {
  it('missing config: warn + return empty KBQueryResponse, execFileSync NEVER called', () => {
    mockMissingKbConfig();

    const result = queryKnowledgeBase(dummyPaths, 'what is cortextos?', baseOptions);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [],
      total: 0,
      query: 'what is cortextos?',
      collection: 'shared-TestOrg',
    });
    expect(warnLog.some((m) => m.includes('TestOrg') && /run setup/i.test(m))).toBe(true);
    expect(warnLog.some((m) => m.includes('[kb]'))).toBe(true);
  });

  it('config present: execFileSync IS called, happy-path query returns results', () => {
    mockConfiguredKb();
    // Mock mmrag.py --json output: a JSON blob with one result.
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        results: [
          { content: 'hit', similarity: 0.9, source: 'foo.md', type: 'markdown' },
        ],
      }),
    );

    const result = queryKnowledgeBase(dummyPaths, 'test query', baseOptions);

    expect(execFileSyncMock).toHaveBeenCalled();
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].content).toBe('hit');
    // Happy path emits no [kb] warning.
    expect(warnLog.filter((m) => m.includes('[kb]'))).toHaveLength(0);
  });
});

describe('kb warn messages — UX invariants', () => {
  it('both warn messages name the org and suggest "run setup"', () => {
    // Drive ingest path
    mockMissingKbConfig();
    ingestKnowledgeBase(['/f.md'], { ...baseOptions, org: 'SpecificOrg' });
    // Drive query path
    mockMissingKbConfig();
    queryKnowledgeBase(dummyPaths, 'q', { ...baseOptions, org: 'SpecificOrg' });

    // At least one warn per call site, each containing the org name + hint
    const specificOrgWarns = warnLog.filter((m) => m.includes('SpecificOrg'));
    expect(specificOrgWarns.length).toBeGreaterThanOrEqual(2);
    expect(specificOrgWarns.every((m) => /run setup/i.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-loud ingest receipts (WS5b) — kills the exit-0-on-ETIMEDOUT class
// ---------------------------------------------------------------------------

function lastWrittenReceipt(): Record<string, unknown> {
  expect(writeKBIngestReceiptMock).toHaveBeenCalled();
  const call = writeKBIngestReceiptMock.mock.calls.at(-1) as unknown[];
  return call[2] as Record<string, unknown>;
}

describe('ingestKnowledgeBase — receipts', () => {
  it('success with MMRAG_INGEST_RECEIPT line: receipt has exact parsed counts, status ok, exit_code 0', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue(
      'Ingesting file 1...\n' +
      'MMRAG_INGEST_RECEIPT {"added":3,"updated":1,"skipped":2,"errored":0}\n',
    );

    const receipt = ingestKnowledgeBase(['/some/file.md'], baseOptions);

    expect(writeKBIngestReceiptMock).toHaveBeenCalledTimes(1);
    const [instanceId, org, written] = writeKBIngestReceiptMock.mock.calls[0] as [
      string, string, Record<string, unknown>,
    ];
    expect(instanceId).toBe('test');
    expect(org).toBe('TestOrg');
    expect(written).toMatchObject({
      collection: 'shared-TestOrg',
      added: 3,
      updated: 1,
      skipped: 2,
      errored: 0,
      exit_code: 0,
      status: 'ok',
    });
    expect(typeof written.run_at).toBe('string');
    expect(typeof written.duration_ms).toBe('number');
    // Return value is the same receipt
    expect(receipt).toMatchObject({ added: 3, updated: 1, errored: 0, status: 'ok' });
    // Captured stdout is echoed back so operator UX is preserved
    expect(stdoutWrites.join('')).toContain('Ingesting file 1...');
  });

  it('success WITHOUT a receipt line: counts are null, status ok, no throw', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue('plain output, no receipt line\n');

    expect(() => ingestKnowledgeBase(['/some/file.md'], baseOptions)).not.toThrow();

    const written = lastWrittenReceipt();
    expect(written).toMatchObject({
      added: null,
      updated: null,
      skipped: null,
      errored: null,
      exit_code: 0,
      status: 'ok',
    });
  });

  it('child killed by timeout (ETIMEDOUT/signal/status null): receipt status timeout AND re-throw', () => {
    mockConfiguredKb();
    const timeoutErr = Object.assign(new Error('spawnSync python3 ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      status: null,
      stdout: 'partial output before the kill\n',
      stderr: '',
    });
    execFileSyncMock.mockImplementation(() => { throw timeoutErr; });

    expect(() => ingestKnowledgeBase(['/some/file.md'], baseOptions)).toThrow(/ETIMEDOUT/);

    const written = lastWrittenReceipt();
    expect(written).toMatchObject({
      status: 'timeout',
      added: null,
      errored: null,
    });
    expect(String(written.error)).toContain('ETIMEDOUT');
    // Partial child output is still echoed
    expect(stdoutWrites.join('')).toContain('partial output before the kill');
  });

  it('spawn failure (ENOENT, status null, no signal): receipt status error — NOT timeout — AND re-throw', () => {
    mockConfiguredKb();
    const spawnErr = Object.assign(new Error('spawnSync python3 ENOENT'), {
      code: 'ENOENT',
      signal: null,
      status: null,
      stdout: '',
      stderr: '',
    });
    execFileSyncMock.mockImplementation(() => { throw spawnErr; });

    expect(() => ingestKnowledgeBase(['/some/file.md'], baseOptions)).toThrow(/ENOENT/);

    const written = lastWrittenReceipt();
    expect(written).toMatchObject({
      status: 'error',
      exit_code: -1,
      added: null,
      errored: null,
    });
    expect(String(written.error)).toContain('ENOENT');
  });

  it('child exits non-zero: receipt status error with the REAL exit code AND re-throw', () => {
    mockConfiguredKb();
    const exitErr = Object.assign(new Error('Command failed: python3 mmrag.py ingest'), {
      status: 2,
      signal: null,
      stdout: '',
      stderr: 'Traceback: boom\n',
    });
    execFileSyncMock.mockImplementation(() => { throw exitErr; });

    expect(() => ingestKnowledgeBase(['/some/file.md'], baseOptions)).toThrow(/Command failed/);

    const written = lastWrittenReceipt();
    expect(written).toMatchObject({ status: 'error', exit_code: 2 });
    // Captured child stderr is echoed to the parent's stderr
    expect(stderrWrites.join('')).toContain('Traceback: boom');
  });

  it('errored>0: receipt is written AND the call throws (can never exit 0) with a loud stderr line', () => {
    mockConfiguredKb();
    execFileSyncMock.mockReturnValue(
      'MMRAG_INGEST_RECEIPT {"added":5,"updated":0,"skipped":1,"errored":2}\n',
    );

    expect(() => ingestKnowledgeBase(['/some/file.md'], baseOptions)).toThrow(/2 errored file/);

    // Receipt was written BEFORE the throw, with the real counts on it
    const written = lastWrittenReceipt();
    expect(written).toMatchObject({ added: 5, errored: 2, exit_code: 0 });
    // Loud operator-facing escalation line
    expect(errorLog.some((m) => m.includes('INGEST COMPLETED WITH ERRORS') && m.includes('2'))).toBe(true);
  });

  it('missing config early-return writes NO receipt (skip, not a run)', () => {
    mockMissingKbConfig();
    const result = ingestKnowledgeBase(['/some/file.md'], baseOptions);
    expect(result).toBeUndefined();
    expect(writeKBIngestReceiptMock).not.toHaveBeenCalled();
  });
});
