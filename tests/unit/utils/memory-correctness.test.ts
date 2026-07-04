import { describe, it, expect } from 'vitest';
import {
  extractClaims,
  verifyClaims,
  formatCorrectnessReport,
  type MemoryClaim,
  type ClaimResolver,
} from '../../../src/utils/memory-correctness';

/**
 * Unit tests for the R8 memory-correctness extractor and verifier (WS10).
 *
 * The governing goal: "A memory that names a specific function, file, or flag
 * is a claim that it existed when written." These tests lock in that:
 * - extractClaims() correctly identifies file paths, symbols, and wikilinks.
 * - extractClaims() skips ambiguous prose without false positives.
 * - verifyClaims() returns resolved/unresolved/skipped correctly via a stub resolver.
 *
 * All tests are pure — no fs, no env, no network.
 */

// ---------------------------------------------------------------------------
// Stub resolver
// ---------------------------------------------------------------------------

function makeResolver(overrides: Partial<ClaimResolver> = {}): ClaimResolver {
  return {
    fileExists: (_path: string) => false,
    symbolExists: (_name: string) => false,
    memoryExists: (_slug: string) => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractClaims — file claims
// ---------------------------------------------------------------------------

describe('extractClaims — file claims', () => {
  it('extracts a src/ path claim', () => {
    const md = 'See `src/bus/reconcile.ts` for the pure logic.';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'file' && c.value === 'src/bus/reconcile.ts')).toBe(true);
  });

  it('extracts an orgs/ path claim', () => {
    const md = 'Config at `orgs/clearworksai/agents/larry/config.json`.';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'file' && c.value === 'orgs/clearworksai/agents/larry/config.json')).toBe(true);
  });

  it('extracts a tests/ path claim', () => {
    const md = 'Tests in `tests/unit/bus/reconcile.test.ts`.';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'file' && c.value === 'tests/unit/bus/reconcile.test.ts')).toBe(true);
  });

  it('does NOT extract a bare filename without slash (ambiguous)', () => {
    const md = 'See `reconcile.ts` for details.';
    const claims = extractClaims(md);
    // "reconcile.ts" alone (no directory prefix) should not be flagged
    // because we can't tell if it's a file path or just a name in prose.
    const fileClaims = claims.filter(c => c.kind === 'file');
    expect(fileClaims.every(c => !c.value.startsWith('reconcile'))).toBe(true);
  });

  it('does NOT extract plain prose words as file claims', () => {
    const md = 'The agent runs the daily check and logs the output.';
    const claims = extractClaims(md);
    expect(claims.filter(c => c.kind === 'file')).toHaveLength(0);
  });

  it('records the correct line number (1-based)', () => {
    const md = 'First line.\n`src/bus/event.ts` is on the second line.';
    const claims = extractClaims(md);
    const fileClaim = claims.find(c => c.kind === 'file' && c.value === 'src/bus/event.ts');
    expect(fileClaim).toBeDefined();
    expect(fileClaim!.line).toBe(2);
  });

  it('extracts multiple file claims from the same file', () => {
    const md = [
      '`src/bus/reconcile.ts` has the pure logic.',
      '`src/cli/bus-reconcile.ts` is the CLI.',
      '`orgs/clearworksai/agents/larry/config.json` is the config.',
    ].join('\n');
    const fileClaims = extractClaims(md).filter(c => c.kind === 'file');
    expect(fileClaims).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// extractClaims — symbol claims
// ---------------------------------------------------------------------------

describe('extractClaims — symbol claims', () => {
  it('extracts a function name with parentheses', () => {
    const md = 'Call `detectsCompletionClaim()` to check a message.';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'symbol' && c.value === 'detectsCompletionClaim()')).toBe(true);
  });

  it('extracts a CLI flag', () => {
    const md = 'Use `--strict` to enable strict mode.';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'symbol' && c.value === '--strict')).toBe(true);
  });

  it('extracts multiple symbols', () => {
    const md = '`reconcile()` and `correlateActivity()` are pure. Use `--json` for JSON output.';
    const symbols = extractClaims(md).filter(c => c.kind === 'symbol');
    const values = symbols.map(s => s.value);
    expect(values).toContain('reconcile()');
    expect(values).toContain('correlateActivity()');
    expect(values).toContain('--json');
  });

  it('does NOT extract bare identifiers without () as symbol claims (too ambiguous)', () => {
    const md = 'The `reconcile` module handles drift.';
    // Without parens, "reconcile" is just a word — skip it.
    const symbols = extractClaims(md).filter(c => c.kind === 'symbol');
    expect(symbols.every(s => s.value !== 'reconcile')).toBe(true);
  });

  it('does NOT flag short words as symbols', () => {
    const md = 'See `it` and `to` in the test.';
    const symbols = extractClaims(md).filter(c => c.kind === 'symbol');
    expect(symbols).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractClaims — wikilinks
// ---------------------------------------------------------------------------

describe('extractClaims — wikilinks', () => {
  it('extracts a [[wikilink]] claim', () => {
    const md = 'See [[project-foo]] for details.';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'wikilink' && c.value === 'project-foo')).toBe(true);
  });

  it('extracts a [[reference_bar]] slug', () => {
    const md = 'Related: [[reference_ocg_is_loan_syndication]]';
    const claims = extractClaims(md);
    expect(claims.some(c => c.kind === 'wikilink' && c.value === 'reference_ocg_is_loan_syndication')).toBe(true);
  });

  it('does NOT extract empty [[]] wikilinks', () => {
    const md = 'See [[]] for details.';
    const claims = extractClaims(md);
    expect(claims.filter(c => c.kind === 'wikilink')).toHaveLength(0);
  });

  it('extracts multiple wikilinks from one file', () => {
    const md = '[[project-foo]] and [[reference-bar]] are both linked.';
    const wikilinks = extractClaims(md).filter(c => c.kind === 'wikilink');
    expect(wikilinks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractClaims — no-op and mixed
// ---------------------------------------------------------------------------

describe('extractClaims — no-op and mixed', () => {
  it('pure prose with no claims → empty array', () => {
    const md = 'The fleet is healthy. Larry owns the knowledge map. Josh works from his phone.';
    expect(extractClaims(md)).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(extractClaims('')).toHaveLength(0);
  });

  it('mixed claim types in a realistic memory entry', () => {
    const md = [
      '- [Verification receipts (WS2)](reference_ws2) — `src/utils/verification-receipt.ts`',
      '  writes `recordVerificationReceipt()` to the ledger.',
      '  CLI: `cortextos bus verify-receipt` (`src/cli/bus.ts:1240`).',
      '  Use `--emit-events` to fan out drift events. See [[feedback_certainty_governing]].',
    ].join('\n');

    const claims = extractClaims(md);
    const kinds = claims.map(c => c.kind);
    expect(kinds).toContain('file');
    expect(kinds).toContain('symbol');
    expect(kinds).toContain('wikilink');
  });
});

// ---------------------------------------------------------------------------
// verifyClaims — stub resolver
// ---------------------------------------------------------------------------

describe('verifyClaims — with stub resolver', () => {
  it('file claim that exists → resolved', () => {
    const claim: MemoryClaim = { kind: 'file', value: 'src/bus/reconcile.ts', line: 1 };
    const resolver = makeResolver({ fileExists: () => true });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('resolved');
    expect(results[0].reason).toContain('exists');
  });

  it('file claim that does NOT exist → unresolved', () => {
    const claim: MemoryClaim = { kind: 'file', value: 'src/bus/nonexistent.ts', line: 1 };
    const resolver = makeResolver({ fileExists: () => false });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('unresolved');
    expect(results[0].reason).toContain('not found');
  });

  it('symbol claim that exists → resolved', () => {
    const claim: MemoryClaim = { kind: 'symbol', value: 'detectsCompletionClaim()', line: 5 };
    const resolver = makeResolver({ symbolExists: () => true });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('resolved');
  });

  it('symbol claim that does NOT exist → skipped (best-effort, not unresolved)', () => {
    const claim: MemoryClaim = { kind: 'symbol', value: 'deletedFunction()', line: 3 };
    const resolver = makeResolver({ symbolExists: () => false });
    const results = verifyClaims([claim], resolver);
    // Symbol checks are best-effort; a miss is skipped, not unresolved, to avoid
    // false positives from obfuscated/minified names or dynamic dispatch.
    expect(results[0].verdict).toBe('skipped');
  });

  it('symbol resolver throws → verdict is skipped (fail-open)', () => {
    const claim: MemoryClaim = { kind: 'symbol', value: 'someFunc()', line: 2 };
    const resolver = makeResolver({ symbolExists: () => { throw new Error('grep failed'); } });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('skipped');
  });

  it('wikilink that exists → resolved', () => {
    const claim: MemoryClaim = { kind: 'wikilink', value: 'project-foo', line: 8 };
    const resolver = makeResolver({ memoryExists: () => true });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('resolved');
  });

  it('wikilink that does NOT exist → unresolved', () => {
    const claim: MemoryClaim = { kind: 'wikilink', value: 'project-deleted', line: 8 };
    const resolver = makeResolver({ memoryExists: () => false });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('unresolved');
  });

  it('resolver throws for file → skipped (fail-open)', () => {
    const claim: MemoryClaim = { kind: 'file', value: 'src/bus/reconcile.ts', line: 1 };
    const resolver = makeResolver({ fileExists: () => { throw new Error('disk error'); } });
    const results = verifyClaims([claim], resolver);
    expect(results[0].verdict).toBe('skipped');
  });

  it('multiple claims: resolved + unresolved + skipped', () => {
    const claims: MemoryClaim[] = [
      { kind: 'file', value: 'src/bus/reconcile.ts', line: 1 },
      { kind: 'file', value: 'src/bus/deleted.ts', line: 2 },
      { kind: 'symbol', value: 'deletedFn()', line: 3 },
    ];
    const resolver = makeResolver({
      fileExists: (p) => p === 'src/bus/reconcile.ts',
      symbolExists: () => false,
    });
    const results = verifyClaims(claims, resolver);
    expect(results[0].verdict).toBe('resolved');
    expect(results[1].verdict).toBe('unresolved');
    expect(results[2].verdict).toBe('skipped'); // symbol
  });
});

// ---------------------------------------------------------------------------
// formatCorrectnessReport
// ---------------------------------------------------------------------------

describe('formatCorrectnessReport', () => {
  it('empty results → no-claims message', () => {
    const out = formatCorrectnessReport([]);
    expect(out).toContain('no memory claims found');
  });

  it('includes sourceLabel in header when provided', () => {
    const claim: MemoryClaim = { kind: 'file', value: 'src/bus/reconcile.ts', line: 1 };
    const results = verifyClaims([claim], makeResolver({ fileExists: () => true }));
    const out = formatCorrectnessReport(results, 'MEMORY.md');
    expect(out).toContain('MEMORY.md');
  });

  it('shows OK for resolved, FAIL for unresolved, SKIP for skipped', () => {
    const claims: MemoryClaim[] = [
      { kind: 'file', value: 'src/bus/reconcile.ts', line: 1 },
      { kind: 'file', value: 'src/bus/gone.ts', line: 2 },
      { kind: 'symbol', value: 'lostFn()', line: 3 },
    ];
    const resolver = makeResolver({
      fileExists: (p) => p === 'src/bus/reconcile.ts',
      symbolExists: () => false,
    });
    const results = verifyClaims(claims, resolver);
    const out = formatCorrectnessReport(results);
    expect(out).toContain('[OK]');
    expect(out).toContain('[FAIL]');
    expect(out).toContain('[SKIP]');
  });

  it('includes summary counts', () => {
    const claim: MemoryClaim = { kind: 'file', value: 'src/bus/gone.ts', line: 1 };
    const results = verifyClaims([claim], makeResolver({ fileExists: () => false }));
    const out = formatCorrectnessReport(results);
    expect(out).toContain('1 claim(s) checked');
    expect(out).toContain('1 unresolved');
  });
});
