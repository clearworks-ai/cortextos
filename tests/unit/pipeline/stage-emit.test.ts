import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { emitLedgerRow } from '../../../src/pipeline/ledger';
import { main } from '../../../src/pipeline/stage-emit';

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run main(argv) capturing the exit code and the printed line. printAndExit writes
 * to stderr on failure, stdout on success — we capture both and return whichever
 * fired.
 */
function run(argv: string[]): { code: number; out: string } {
  let out = '';
  const log = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    out = String(m ?? '');
  });
  const err = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
    out = String(m ?? '');
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  try {
    main(argv);
    throw new Error('main() returned without calling process.exit');
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    return { code: e.code, out };
  } finally {
    log.mockRestore();
    err.mockRestore();
    exit.mockRestore();
  }
}

describe('stage-emit main() — phase-sequencing gate', () => {
  let root: string;
  let ledgerPath: string;
  let secretPath: string;

  function emitResearch(slug: string): void {
    const artifact = join(root, `${slug}-research.md`);
    writeFileSync(artifact, `# research ${slug}\n`, 'utf-8');
    emitLedgerRow({ slug, stage: 'research', artifactPath: artifact, ledgerPath, secretPath });
  }

  function verifyArgs(slug: string, extra: string[] = []): string[] {
    return [
      '--verify',
      '--slug', slug,
      '--through', 'research',
      '--max-age', '999999999',
      '--ledger', ledgerPath,
      '--secret', secretPath,
      ...extra,
    ];
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stage-emit-'));
    ledgerPath = join(root, 'state', 'pipeline-ledger.jsonl');
    secretPath = join(root, '.pipeline-secret');
    writeFileSync(secretPath, `${'ab'.repeat(32)}\n`, 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks a p2 dispatch when phase 1 is unsatisfied (no evidence, no lock)', () => {
    emitResearch('p2-gate-test');
    const { code, out } = run(verifyArgs('p2-gate-test'));
    expect(code).toBe(1);
    expect(out.startsWith('PHASE_SKIPPED:')).toBe(true);
    expect(out).toContain('phase 2');
    expect(out).toContain('p2-gate-test');
    expect(out).toContain('1'); // unsatisfied phase 1
  });

  it('passes once a p1 true-verify evidence row exists in the ledger', () => {
    emitResearch('p2-gate-test');
    // cross-slug phase-1 evidence — raw JSONL, dummy sig (phase scan verifies no sigs)
    appendFileSync(
      ledgerPath,
      `${JSON.stringify({
        slug: 'p1-x-anything',
        stage: 'true-verify',
        ts: Math.floor(Date.now() / 1000),
        artifact_sha256: 'a'.repeat(64),
        prev_sha256: '',
        sig: 'dummy',
      })}\n`,
      'utf-8',
    );
    const { code, out } = run(verifyArgs('p2-gate-test'));
    expect(code).toBe(0);
    expect(out).toContain('"slug":"p2-gate-test"');
    expect(out).toContain('"stage":"research"');
  });

  it('the removed --mark-phase-complete override cannot unblock a phase dispatch', () => {
    emitResearch('p2-gate-test');
    // The flag no longer marks anything — it falls through to the normal emit
    // path, which requires --slug/--stage and fails closed. No lock is written.
    const mark = run([
      '--mark-phase-complete', '1',
      '--by', 'larry',
      '--ledger', ledgerPath,
    ]);
    expect(mark.code).not.toBe(0);
    expect(existsSync(join(dirname(ledgerPath), 'build-phase-lock.json'))).toBe(false);

    // p2 dispatch stays blocked — the only way to satisfy phase 1 is a real
    // p1- true-verify row, which does not exist here.
    expect(run(verifyArgs('p2-gate-test')).code).toBe(1);
  });

  it('leaves a non-phase slug untouched and creates no lock file', () => {
    emitResearch('plain-gate-test');
    const { code } = run(verifyArgs('plain-gate-test'));
    expect(code).toBe(0);
    expect(existsSync(join(dirname(ledgerPath), 'build-phase-lock.json'))).toBe(false);
  });

  // Removed 2026-08-03 with the --mark-phase-complete flag:
  //  - 'rejects invalid --mark-phase-complete values with exit 5'
  //  - 'honors an explicit --phase-lock override on both branches' (mark branch)
  // Phase completion is now earned only by a p<M>- true-verify row; there is no
  // mark branch and no completed_phases/lock override to exercise.
});
