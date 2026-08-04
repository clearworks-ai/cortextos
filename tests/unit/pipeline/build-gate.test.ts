import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The phase-sequencing check sits at the END of enforceBuildDispatchGate, behind the
// full signed-provenance chain (verifyChainDetailed) and OBF artifact checks. Those
// require a signing secret, an HMAC-chained specs row, and a real transcript on disk —
// out of scope for a phase-gate unit test. Stub just those two so the dispatch reaches
// the phase check; readLedgerRows/defaultLedgerPath/defaultPhaseLockPath stay REAL and
// read the fixtures written under the canonical (CTX-resolved) ledger location below.
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
  // canonicalDir = the framework root where the ONE real ledger lives (CTX_PROJECT_ROOT).
  // repoDir      = the dispatch's repo= value — a SEPARATE, real worktree path. Keeping
  //               these two distinct is the whole point: the phase check MUST read the
  //               canonical ledger, never a repo=-derived one (regression for the
  //               build-gate.ts ledger-path divergence bug).
  let canonicalDir: string;
  let repoDir: string;
  let ledgerPath: string;
  let lockPath: string;

  beforeEach(() => {
    canonicalDir = mkdtempSync(join(tmpdir(), 'build-gate-canonical-'));
    repoDir = mkdtempSync(join(tmpdir(), 'build-gate-repo-'));
    mkdirSync(join(canonicalDir, 'state'), { recursive: true });
    // defaultLedgerPath() === CTX_PROJECT_ROOT/state/pipeline-ledger.jsonl
    // defaultPhaseLockPath(ledgerPath) === dirname(ledgerPath)/build-phase-lock.json
    ledgerPath = join(canonicalDir, 'state', 'pipeline-ledger.jsonl');
    lockPath = join(canonicalDir, 'state', 'build-phase-lock.json');
    vi.stubEnv('CTX_PROJECT_ROOT', canonicalDir);
    vi.stubEnv('CTX_FRAMEWORK_ROOT', canonicalDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(canonicalDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('blocks p2- dispatch when phase 1 is unsatisfied', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

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
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('p2-some-feature');
  });

  it('does NOT allow p2- dispatch via a completed_phases lock (override removed 2026-08-03)', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    writeFileSync(
      lockPath,
      JSON.stringify({ current_phase: 2, completed_phases: [1], history: [] }),
      'utf-8',
    );
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

    // A hand-written/legacy completed_phases entry no longer satisfies phase 1 —
    // only a real p1- true-verify ledger row does.
    expect(() => enforceBuildDispatchGate('codexer', message)).toThrow(/phase\(s\) 1 unsatisfied/);
  });

  it('allows p1 dispatch without phase checks', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=p1-some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('p1-some-feature');
  });

  it('allows non-p<N- slugs without phase checks', () => {
    writeFileSync(ledgerPath, '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('some-feature');
  });

  // --- Regression: ledger-path divergence (build-gate.ts CRITICAL) ------------------
  // Before the fix, the phase check resolved defaultLedgerPath(directive.repo) — a
  // DIFFERENT path than the chain check's canonical ledger. These two tests pin the
  // fix: the phase gate reads ONLY the canonical ledger, never the repo=-derived one.

  it('reads the CANONICAL ledger, not the repo= worktree ledger (false-block direction)', () => {
    // Canonical ledger satisfies phase 1.
    writeFileSync(ledgerPath, ledgerRow('p1-some-phase', 'true-verify') + '\n', 'utf-8');
    // A STALE/empty snapshot living inside the repo= worktree would, under the old bug,
    // be read instead — and would false-block. Prove it is ignored.
    mkdirSync(join(repoDir, 'state'), { recursive: true });
    writeFileSync(join(repoDir, 'state', 'pipeline-ledger.jsonl'), '', 'utf-8');
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

    const result = enforceBuildDispatchGate('codexer', message);
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('p2-some-feature');
  });

  it('does NOT trust a fabricated ledger planted in repo= (bypass direction)', () => {
    // Canonical ledger is empty — phase 1 genuinely unsatisfied.
    writeFileSync(ledgerPath, '', 'utf-8');
    // Attacker-writable repo= dir carries a hand-crafted "satisfied" ledger. Under the
    // old bug this bypassed the gate; the fix must still BLOCK.
    mkdirSync(join(repoDir, 'state'), { recursive: true });
    writeFileSync(
      join(repoDir, 'state', 'pipeline-ledger.jsonl'),
      ledgerRow('p1-some-phase', 'true-verify') + '\n',
      'utf-8',
    );
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${repoDir} scope-sha=${SCOPE_SHA}`;

    try {
      enforceBuildDispatchGate('codexer', message);
      throw new Error('Expected BuildGateError — fabricated repo ledger must not satisfy the gate');
    } catch (error) {
      expect(error).toBeInstanceOf(BuildGateError);
      expect((error as BuildGateError).code).toBe('PHASE_SKIPPED');
      expect((error as BuildGateError).message).toContain('phase(s) 1 unsatisfied');
    }
  });

  // --- Exempt path cannot skip the phase gate (MAJOR coverage gap) -------------------

  it('exempt=true dispatch is STILL phase-gated (exempt cannot skip a phase)', () => {
    writeFileSync(ledgerPath, '', 'utf-8'); // phase 1 unsatisfied
    // exempt=true → no scope-sha required; chain verify is stubbed ok. Phase check must
    // still fire and block, since the exempt escape hatch must not bypass sequencing.
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${repoDir} exempt=true`;

    try {
      enforceBuildDispatchGate('codexer', message);
      throw new Error('Expected BuildGateError — exempt dispatch must not skip the phase gate');
    } catch (error) {
      expect(error).toBeInstanceOf(BuildGateError);
      expect((error as BuildGateError).code).toBe('PHASE_SKIPPED');
      expect((error as BuildGateError).message).toContain('phase(s) 1 unsatisfied');
    }
  });

  // --- repo= existence guard (MINOR hardening, mirrors shell hook's [ -d "$REPO" ]) --

  it('rejects a one-big-feature dispatch whose repo= does not exist on disk', () => {
    writeFileSync(ledgerPath, ledgerRow('p1-some-phase', 'true-verify') + '\n', 'utf-8');
    const missing = join(repoDir, 'does-not-exist-subdir');
    const message = `GATE: build framework=one-big-feature slug=p2-some-feature repo=${missing} scope-sha=${SCOPE_SHA}`;

    try {
      enforceBuildDispatchGate('codexer', message);
      throw new Error('Expected BuildGateError for a non-existent repo path');
    } catch (error) {
      expect(error).toBeInstanceOf(BuildGateError);
      expect((error as BuildGateError).code).toBe('INVALID_DIRECTIVE');
    }
  });
});
