import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  STAGES,
  describeArtifact,
  emitLedgerRow,
  readLedgerRows,
  verifyChainDetailed,
  verifyOneBigFeatureArtifacts,
  type LedgerRow,
} from '../../../src/pipeline/ledger';

function transcriptLine(sessionId: string, block: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T01:00:00.000Z',
    sessionId,
    isSidechain: true,
    message: {
      role: 'assistant',
      content: [block],
    },
  });
}

function writeWriteTranscript(path: string, sessionId: string, writes: Array<{ filePath: string; content: string }>): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = writes.map((write, index) => transcriptLine(sessionId, {
    type: 'tool_use',
    id: `toolu_write_${index}`,
    name: 'Write',
    input: {
      file_path: write.filePath,
      content: write.content,
    },
  }));
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

function writeWriteEditTranscript(path: string, sessionId: string, filePath: string, initial: string, oldString: string, newString: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    transcriptLine(sessionId, {
      type: 'tool_use',
      id: 'toolu_write',
      name: 'Write',
      input: {
        file_path: filePath,
        content: initial,
      },
    }),
    transcriptLine(sessionId, {
      type: 'tool_use',
      id: 'toolu_edit',
      name: 'Edit',
      input: {
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
        replace_all: false,
      },
    }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

function signRow(secret: string, row: Omit<LedgerRow, 'sig'>): LedgerRow {
  const parts = [
    row.slug,
    row.stage,
    String(row.ts),
    row.artifact_sha256,
    row.prev_sha256,
  ];
  if (row.runner) parts.push(row.runner);
  if (row.session_id) parts.push(row.session_id);
  if (row.transcript_path) parts.push(row.transcript_path);
  if (row.transcript_sha256) parts.push(row.transcript_sha256);
  if (row.reason) parts.push(row.reason);
  if (row.evidence_path) parts.push(row.evidence_path);
  if (row.provenance_mode) parts.push(row.provenance_mode);
  return {
    ...row,
    sig: createHmac('sha256', secret).update(parts.join('|')).digest('hex'),
  };
}

describe('pipeline ledger', () => {
  let root: string;
  let repoRoot: string;
  let projectsRoot: string;
  let ledgerPath: string;
  let secretPath: string;
  let secret: string;
  let slugDir: string;
  let researchPath: string;
  let planPath: string;
  let specsDir: string;
  let specPath: string;
  let reviewPath: string;
  let stagingArtifactPath: string;
  let stagingEvidencePath: string;
  let trueVerifyArtifactPath: string;
  let trueVerifyEvidencePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hard-spec-gate-'));
    repoRoot = join(root, 'repo');
    projectsRoot = join(root, 'projects');
    ledgerPath = join(root, 'state', 'pipeline-ledger.jsonl');
    secretPath = join(root, '.pipeline-secret');
    secret = 'ab'.repeat(32);
    writeFileSync(secretPath, `${secret}\n`, 'utf-8');

    slugDir = join(repoRoot, '.agent', 'one-big-feature', 'hard-spec-gate');
    researchPath = join(slugDir, '01-research.md');
    planPath = join(slugDir, '02-master-plan.md');
    specsDir = join(slugDir, '03-specs');
    specPath = join(specsDir, '01-signed-stage-ledger.md');
    reviewPath = join(slugDir, '04-review.md');
    stagingArtifactPath = join(slugDir, '05-staging-build.txt');
    stagingEvidencePath = join(slugDir, '05-staging-evidence.log');
    trueVerifyArtifactPath = join(slugDir, '06-true-verify-build.txt');
    trueVerifyEvidencePath = join(slugDir, '06-true-verify-evidence.log');

    mkdirSync(specsDir, { recursive: true });
    writeFileSync(researchPath, '# research\n', 'utf-8');
    writeFileSync(planPath, '# draft\n', 'utf-8');
    writeFileSync(specPath, '# spec\n', 'utf-8');
    writeFileSync(reviewPath, '# review\n', 'utf-8');
    writeFileSync(stagingArtifactPath, 'staging build\n', 'utf-8');
    writeFileSync(stagingEvidencePath, 'staging ok\n', 'utf-8');
    writeFileSync(trueVerifyArtifactPath, 'true verify build\n', 'utf-8');
    writeFileSync(trueVerifyEvidencePath, 'true verify ok\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits and verifies a research -> plan -> specs chain', () => {
    const planSession = 'plan-session-1';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeWriteEditTranscript(planTranscript, planSession, planPath, '# draft\n', '# draft\n', '# master plan\n');
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session-1';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(specsTranscript, specsSession, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: planSession,
      transcriptPath: planTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 300,
    });

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'specs',
      maxAgeSeconds: 86_400,
      scopeSha: describeArtifact(specsDir).sha256,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 350,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.rows.map((row) => row.stage)).toEqual(['research', 'plan', 'specs']);

    const artifactCheck = verifyOneBigFeatureArtifacts({
      projectRoot: repoRoot,
      slug: 'hard-spec-gate',
      rows: verified.rows,
    });
    expect(artifactCheck.ok).toBe(true);
  });

  it('lists staging-verify between review and true-verify', () => {
    expect(STAGES).toEqual([
      'research',
      'synthesize',
      'plan',
      'specs',
      'implement',
      'review',
      'staging-verify',
      'true-verify',
      'exempt',
    ]);
  });

  it('emits and verifies a research -> plan -> specs -> review -> staging-verify chain', () => {
    const planSession = 'plan-session-staging';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(planTranscript, planSession, [
      { filePath: planPath, content: '# master plan\n' },
    ]);
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session-staging';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(specsTranscript, specsSession, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    const reviewSession = 'review-session-staging';
    const reviewTranscript = join(projectsRoot, 'larry', reviewSession, 'subagents', 'agent-review.jsonl');
    writeWriteTranscript(reviewTranscript, reviewSession, [
      { filePath: reviewPath, content: '# review\n' },
    ]);
    writeFileSync(reviewPath, '# review\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: planSession,
      transcriptPath: planTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 300,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'review',
      artifactPath: reviewPath,
      runner: 'larry',
      sessionId: reviewSession,
      transcriptPath: reviewTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 400,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'staging-verify',
      artifactPath: stagingArtifactPath,
      evidencePath: stagingEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds: 500,
    });

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'staging-verify',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 550,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.terminal.stage).toBe('staging-verify');
    expect(verified.terminal.evidence_path).toBe(stagingEvidencePath);
    expect(verified.rows.map((row) => row.stage)).toEqual([
      'research',
      'plan',
      'specs',
      'review',
      'staging-verify',
    ]);
  });

  it('requires non-empty evidence for staging-verify like true-verify', () => {
    const planSession = 'plan-session-staging-evidence';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(planTranscript, planSession, [
      { filePath: planPath, content: '# master plan\n' },
    ]);
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session-staging-evidence';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(specsTranscript, specsSession, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    const reviewSession = 'review-session-staging-evidence';
    const reviewTranscript = join(projectsRoot, 'larry', reviewSession, 'subagents', 'agent-review.jsonl');
    writeWriteTranscript(reviewTranscript, reviewSession, [
      { filePath: reviewPath, content: '# review\n' },
    ]);
    writeFileSync(reviewPath, '# review\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: planSession,
      transcriptPath: planTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 300,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'review',
      artifactPath: reviewPath,
      runner: 'larry',
      sessionId: reviewSession,
      transcriptPath: reviewTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 400,
    });

    writeFileSync(stagingEvidencePath, '', 'utf-8');
    expect(() => emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'staging-verify',
      artifactPath: stagingArtifactPath,
      evidencePath: stagingEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds: 500,
    })).toThrow(/Artifact\/evidence missing or empty for staging-verify/);
  });

  it('allows true-verify directly after review for backward compatibility', () => {
    const planSession = 'plan-session-direct-true-verify';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(planTranscript, planSession, [
      { filePath: planPath, content: '# master plan\n' },
    ]);
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session-direct-true-verify';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(specsTranscript, specsSession, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    const reviewSession = 'review-session-direct-true-verify';
    const reviewTranscript = join(projectsRoot, 'larry', reviewSession, 'subagents', 'agent-review.jsonl');
    writeWriteTranscript(reviewTranscript, reviewSession, [
      { filePath: reviewPath, content: '# review\n' },
    ]);
    writeFileSync(reviewPath, '# review\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: planSession,
      transcriptPath: planTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 300,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'review',
      artifactPath: reviewPath,
      runner: 'larry',
      sessionId: reviewSession,
      transcriptPath: reviewTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 400,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'true-verify',
      artifactPath: trueVerifyArtifactPath,
      evidencePath: trueVerifyEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds: 500,
    });

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'true-verify',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 550,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.rows.map((row) => row.stage)).toEqual([
      'research',
      'plan',
      'specs',
      'review',
      'true-verify',
    ]);
  });

  it('allows true-verify after staging-verify without authored provenance', () => {
    const planSession = 'plan-session-staged-true-verify';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(planTranscript, planSession, [
      { filePath: planPath, content: '# master plan\n' },
    ]);
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session-staged-true-verify';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(specsTranscript, specsSession, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    const reviewSession = 'review-session-staged-true-verify';
    const reviewTranscript = join(projectsRoot, 'larry', reviewSession, 'subagents', 'agent-review.jsonl');
    writeWriteTranscript(reviewTranscript, reviewSession, [
      { filePath: reviewPath, content: '# review\n' },
    ]);
    writeFileSync(reviewPath, '# review\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: planSession,
      transcriptPath: planTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 300,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'review',
      artifactPath: reviewPath,
      runner: 'larry',
      sessionId: reviewSession,
      transcriptPath: reviewTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 400,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'staging-verify',
      artifactPath: stagingArtifactPath,
      evidencePath: stagingEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds: 500,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'true-verify',
      artifactPath: trueVerifyArtifactPath,
      evidencePath: trueVerifyEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds: 600,
    });

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'true-verify',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 650,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.rows.map((row) => row.stage)).toEqual([
      'research',
      'plan',
      'specs',
      'review',
      'staging-verify',
      'true-verify',
    ]);
  });

  it('fails emit when an authored stage lacks provenance flags', () => {
    expect(() => emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      ledgerPath,
      secretPath,
    })).toThrow(/requires --runner, --session, and --transcript/);
  });

  it('fails emit when the transcript does not author the artifact bytes', () => {
    const sessionId = 'plan-session-bad';
    const transcript = join(projectsRoot, 'larry', sessionId, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(transcript, sessionId, [
      { filePath: planPath, content: '# wrong plan\n' },
    ]);
    writeFileSync(planPath, '# actual plan\n', 'utf-8');

    expect(() => emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId,
      transcriptPath: transcript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
    })).toThrow(/PROVENANCE_MISMATCH/);
  });

  it('fails emit when a specs directory contains a file the transcript never wrote', () => {
    const extraPath = join(specsDir, '02-gate-rewrites.md');
    const sessionId = 'specs-session-partial';
    const transcript = join(projectsRoot, 'larry', sessionId, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(transcript, sessionId, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');
    writeFileSync(extraPath, '# unwritten\n', 'utf-8');

    expect(() => emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId,
      transcriptPath: transcript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
    })).toThrow(/Transcript did not author/);
  });

  it('detects a forged terminal row as BAD_SIG', () => {
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });

    const forged = signRow('cd'.repeat(32), {
      slug: 'hard-spec-gate',
      stage: 'research',
      ts: 101,
      artifact_sha256: describeArtifact(researchPath).sha256,
      prev_sha256: 'GENESIS',
    });
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify(forged)}\n`, 'utf-8');

    const result = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'research',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      nowSeconds: 150,
    });
    expect(result).toMatchObject({ ok: false, code: 'BAD_SIG' });
  });

  it('returns NO_PROVENANCE for a validly signed authored row with stripped provenance fields', () => {
    const researchRow = emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const unsignedPlan: Omit<LedgerRow, 'sig'> = {
      slug: 'hard-spec-gate',
      stage: 'plan',
      ts: 200,
      artifact_sha256: describeArtifact(planPath).sha256,
      prev_sha256: researchRow.artifact_sha256,
    };
    const planRow = signRow(secret, unsignedPlan);
    writeFileSync(ledgerPath, `${readLedgerRows(ledgerPath).map((row) => JSON.stringify(row)).join('\n')}\n${JSON.stringify(planRow)}\n`, 'utf-8');

    const result = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'plan',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 300,
    });
    expect(result).toMatchObject({ ok: false, code: 'NO_PROVENANCE' });
  });

  it('detects transcript tampering and deletion at verify time', () => {
    const sessionId = 'plan-session-verify';
    const transcript = join(projectsRoot, 'larry', sessionId, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(transcript, sessionId, [
      { filePath: planPath, content: '# master plan\n' },
    ]);
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId,
      transcriptPath: transcript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });

    writeFileSync(transcript, `${transcriptLine(sessionId, {
      type: 'tool_use',
      id: 'toolu_write_0',
      name: 'Write',
      input: {
        file_path: planPath,
        content: '# tampered plan\n',
      },
    })}\n`, 'utf-8');

    const tampered = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'plan',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 300,
    });
    expect(tampered).toMatchObject({ ok: false, code: 'TRANSCRIPT_TAMPERED' });

    unlinkSync(transcript);
    const missing = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'plan',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 300,
    });
    expect(missing).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISSING' });
  });

  it('returns STALE for an expired terminal row', () => {
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });

    const result = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'research',
      maxAgeSeconds: 10,
      ledgerPath,
      secretPath,
      nowSeconds: 111,
    });
    expect(result).toMatchObject({ ok: false, code: 'STALE' });
  });

  it('flags plan-before-research as ORDERING and drifted specs as SCOPE_SHA_MISMATCH', () => {
    const planSession = 'plan-session-order';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(planTranscript, planSession, [
      { filePath: planPath, content: '# master plan\n' },
    ]);
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session-order';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeWriteTranscript(specsTranscript, specsSession, [
      { filePath: specPath, content: '# signed spec\n' },
    ]);
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: 100,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: planSession,
      transcriptPath: planTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 300,
    });

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'specs',
      maxAgeSeconds: 86_400,
      scopeSha: describeArtifact(specsDir).sha256,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 350,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    utimesSync(planPath, new Date(1), new Date(1));
    const ordering = verifyOneBigFeatureArtifacts({
      projectRoot: repoRoot,
      slug: 'hard-spec-gate',
      rows: verified.rows,
    });
    expect(ordering).toMatchObject({ ok: false, code: 'ORDERING' });

    utimesSync(researchPath, new Date(2_000), new Date(2_000));
    utimesSync(planPath, new Date(5_000), new Date(5_000));
    writeFileSync(specPath, '# drifted spec\n', 'utf-8');
    const drift = verifyOneBigFeatureArtifacts({
      projectRoot: repoRoot,
      slug: 'hard-spec-gate',
      rows: verified.rows,
    });
    expect(drift).toMatchObject({ ok: false, code: 'SCOPE_SHA_MISMATCH' });
  });
});
