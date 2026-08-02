import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The phase-sequencing check sits at the END of enforceBuildDispatchGate, behind the
// full signed-provenance chain (verifyChainDetailed) and OBF artifact checks. Those
// require a signing secret, an HMAC-chained specs row, and a real transcript on disk —
// out of scope for a phase-gate unit test. Stub just those two so the dispatch reaches
// the phase check; readLedgerRows/defaultLedgerPath/defaultPhaseLockPath stay REAL and
// read the fixtures written under repo/state below.
vi.mock('../../../src/pipeline/ledger.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/pipeline/ledger.js')>();
  return {
    ...actual,
    verifyChainDetailed: () => ({ ok: true, rows: [] }),
    verifyOneBigFeatureArtifacts: () => ({ ok: true }),
  };
});

import { enforceBuildDispatchGate, BuildGateError } from '../../../src/pipeline/build-gate';

const SCOPE_SHA = '3e4036e2f1e496c121e7b7825ffe729adf238841466e7238ee848e9c37d2b847';

/** A ledger line that survives parseLedgerLine (needs ts + the sha/sig fields). */
function ledgerRow(slug: string, stage: string): string {
  return JSON.stringify({
    slug,
    stage,
    ts: 1_700_000_000,
    artifact_sha256: 'a'.repeat(64),
    prev_sha256: '0'.repeat(64),
    sig: 'test-sig',
  });
}

describe('enforceBuildDispatchGate - phase sequencing', () => {
  let testDir: string;
  let ledgerPath: string;
  let lockPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'build-gate-test-'));
    // defaultLedgerPath(repo) === repo/state/pipeline-ledger.jsonl
    // defaultPhaseLockPath(ledgerPath) === dirname(ledgerPath)/build-phase-lock.json
    mkdirSync(join(testDir, 'state'), { recursive: true });
    ledgerPath = join(testDir, 'state', 'pipeline-ledger.jsonl');
    lockPath = join(testDir, 'state', 'build-phase-lock.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('blocks p2- dispatch when phase 1 is unsatisfied', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${testDir} scope-sha=${SCOPE_SHA}`;

    expect(() => enforceBuildDispatchGate('codexer', message)).toThrow(BuildGateError);
    try {
      enforceBuildDispatchGate('codexer', message);
      throw new Error('Expected BuildGateError');
    } catch (error) {
      expect(error).toBeInstanceOf(BuildGateError);
      const gateError = error as BuildGateError;
      expect(gateError.code).toBe('PHASE_SKIPPED');
      expect(gateError.message).toContain('phase(s) 1 unsatisfied');
    }
  });

  it('allows p2- dispatch when phase 1 is satisfied via true-verify', () => {
    writeFileSync(ledgerPath, ledgerRow('p1-some-phase', 'true-verify') + '\n', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${testDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('p2-some-feature');
  });

  it('allows p2- dispatch when phase 1 is marked complete', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    writeFileSync(
      lockPath,
      JSON.stringify({ current_phase: 2, completed_phases: [1], history: [] }),
      'utf-8',
    );
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${testDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('p2-some-feature');
  });

  it('allows p1 dispatch without phase checks', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=p1-some-feature repo=${testDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('p1-some-feature');
  });

  it('allows non-p<N- slugs without phase checks', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=some-feature repo=${testDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('some-feature');
  });
});
