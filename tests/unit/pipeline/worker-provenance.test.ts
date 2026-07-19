import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  describeArtifact,
  emitLedgerRow,
  readLedgerRows,
  verifyChainDetailed,
  verifyOneBigFeatureArtifacts,
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

function busSign(key: string, id: string, from: string, to: string, text: string): string {
  return createHmac('sha256', key).update(`${id}:${from}:${to}:${text}`).digest('hex');
}

function writeBusMessage(dir: string, msg: {
  id: string;
  from: string;
  to: string;
  text: string;
  reply_to?: string | null;
  timestamp?: string;
  busKey?: string;
  sig?: string;
}): string {
  mkdirSync(dir, { recursive: true });
  const timestamp = msg.timestamp ?? '2026-07-12T01:00:00.000Z';
  const sig = msg.sig ?? (msg.busKey ? busSign(msg.busKey, msg.id, msg.from, msg.to, msg.text) : undefined);
  const path = join(dir, `2-${msg.id}.json`);
  writeFileSync(path, JSON.stringify({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    priority: 'normal',
    timestamp,
    text: msg.text,
    reply_to: msg.reply_to ?? null,
    ...(sig ? { sig } : {}),
  }), 'utf-8');
  return path;
}

describe('worker-dispatch provenance', () => {
  let root: string;
  let repoRoot: string;
  let busStoreRoot: string;
  let projectsRoot: string;
  let ledgerPath: string;
  let secretPath: string;
  let secret: string;
  let busKey: string;
  let slugDir: string;
  let researchPath: string;
  let planPath: string;
  let specsDir: string;
  let specPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'worker-provenance-'));
    repoRoot = join(root, 'repo');
    busStoreRoot = join(root, 'ctx');
    projectsRoot = join(root, 'projects');
    ledgerPath = join(root, 'state', 'pipeline-ledger.jsonl');
    secretPath = join(root, '.pipeline-secret');
    secret = 'ab'.repeat(32);
    busKey = 'bk'.repeat(20);

    slugDir = join(repoRoot, '.agent', 'one-big-feature', 'hard-spec-gate');
    researchPath = join(slugDir, '01-research.md');
    planPath = join(slugDir, '02-master-plan.md');
    specsDir = join(slugDir, '03-specs');
    specPath = join(specsDir, '01-signed-stage-ledger.md');

    mkdirSync(specsDir, { recursive: true });
    mkdirSync(join(busStoreRoot, 'config'), { recursive: true });
    writeFileSync(join(busStoreRoot, 'config', 'bus-signing-key'), `${busKey}\n`, 'utf-8');
    writeFileSync(secretPath, `${secret}\n`, 'utf-8');
    writeFileSync(researchPath, '# research\n', 'utf-8');
    writeFileSync(planPath, '# master plan\n', 'utf-8');
    writeFileSync(specPath, '# signed spec\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function emitResearch(nowSeconds = 100) {
    return emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds,
    });
  }

  function seedDispatch(id = 'D1', slug = 'hard-spec-gate'): string {
    return writeBusMessage(join(busStoreRoot, 'processed', 'opencode'), {
      id,
      from: 'larry',
      to: 'opencode',
      text: `GATE: build framework=one-big-feature slug=${slug} repo=${repoRoot} scope-sha=${'a'.repeat(64)}`,
      busKey,
    });
  }

  function emitWorkerStage(
    stage: 'plan' | 'specs',
    artifactPath: string,
    sessionId: string,
    transcriptPath: string,
    nowSeconds: number,
  ) {
    return emitLedgerRow({
      slug: 'hard-spec-gate',
      stage,
      artifactPath,
      runner: 'opencode',
      sessionId,
      transcriptPath,
      provenanceMode: 'worker-dispatch',
      busStoreRoot,
      busKeyCtxRoot: busStoreRoot,
      ledgerPath,
      secretPath,
      nowSeconds,
    });
  }

  function seedPassingWorkerChain() {
    emitResearch(100);
    seedDispatch('D1');
    const planReturnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });
    const planRow = emitWorkerStage('plan', planPath, 'R1', planReturnPath, 200);

    const specsReturnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R2',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=specs slug=hard-spec-gate artifact-sha256=${describeArtifact(specsDir).sha256}`,
      busKey,
    });
    const specsRow = emitWorkerStage('specs', specsDir, 'R2', specsReturnPath, 300);

    return { planReturnPath, specsReturnPath, planRow, specsRow };
  }

  it('emits and verifies a worker-authored research -> plan -> specs chain', () => {
    seedPassingWorkerChain();

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'specs',
      maxAgeSeconds: 86_400,
      scopeSha: describeArtifact(specsDir).sha256,
      ledgerPath,
      secretPath,
      busStoreRoot,
      nowSeconds: 350,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const artifactCheck = verifyOneBigFeatureArtifacts({
      projectRoot: repoRoot,
      slug: 'hard-spec-gate',
      rows: verified.rows,
    });
    expect(artifactCheck.ok).toBe(true);

    const rows = readLedgerRows(ledgerPath);
    expect(rows.find((row) => row.stage === 'plan')?.provenance_mode).toBe('worker-dispatch');
    expect(rows.find((row) => row.stage === 'specs')?.provenance_mode).toBe('worker-dispatch');
  });

  it('fails emit when the return message is signed from larry instead of a worker', () => {
    emitResearch();
    seedDispatch('D1');
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'larry',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/PROVENANCE_MISMATCH/);
  });

  it('fails emit when the worker return message signature is tampered', () => {
    emitResearch();
    seedDispatch('D1');
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      sig: '00'.repeat(32),
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/TRANSCRIPT_TAMPERED/);
  });

  it('fails emit when the from field is spoofed without re-signing', () => {
    emitResearch();
    seedDispatch('D1');
    const text = `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`;
    const spoofedPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text,
      sig: busSign(busKey, 'R1', 'larry', 'larry', text),
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', spoofedPath, 200)).toThrow(/TRANSCRIPT_TAMPERED/);
  });

  it('fails emit when the artifact bytes drift after attestation', () => {
    emitResearch();
    seedDispatch('D1');
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });
    writeFileSync(planPath, '# drifted plan\n', 'utf-8');

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/PROVENANCE_MISMATCH/);
  });

  it('fails emit when the reply_to dispatch slug mismatches the attested slug', () => {
    emitResearch();
    seedDispatch('D1', 'other-slug');
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/PROVENANCE_MISMATCH/);
  });

  it('fails emit when the reply_to dispatch is missing', () => {
    emitResearch();
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'NOPE',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/TRANSCRIPT_MISSING|PROVENANCE_MISMATCH/);
  });

  it('fails emit when the return message lacks a PROVENANCE line', () => {
    emitResearch();
    seedDispatch('D1');
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: 'done without attestation',
      busKey,
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/PROVENANCE_MISMATCH/);
  });

  it('fails emit when the bus signing key is unreadable', () => {
    emitResearch();
    seedDispatch('D1');
    const returnPath = writeBusMessage(join(busStoreRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });
    rmSync(join(busStoreRoot, 'config'), { recursive: true, force: true });

    expect(() => emitWorkerStage('plan', planPath, 'R1', returnPath, 200)).toThrow(/NO_PROVENANCE/);
  });

  it('fails emit when the return message is outside the bus store root', () => {
    emitResearch();
    seedDispatch('D1');
    const outsidePath = writeBusMessage(join(root, 'outside', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      reply_to: 'D1',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      busKey,
    });

    expect(() => emitWorkerStage('plan', planPath, 'R1', outsidePath, 200)).toThrow(/TRANSCRIPT_MISSING/);
  });

  it('keeps transcript-mode rows unchanged when provenance_mode is absent', () => {
    emitResearch();
    const sessionId = 'plan-session-1';
    const transcriptPath = join(projectsRoot, 'larry', sessionId, 'subagents', 'agent-plan.jsonl');
    writeWriteTranscript(transcriptPath, sessionId, [
      { filePath: planPath, content: '# master plan\n' },
    ]);

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'architect',
      sessionId,
      transcriptPath,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: 200,
    });

    const rows = readLedgerRows(ledgerPath);
    expect(rows.find((row) => row.stage === 'plan')?.provenance_mode).toBeUndefined();

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'plan',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowSeconds: 250,
    });
    expect(verified.ok).toBe(true);
  });

  it('detects verify-time tampering of a worker return message', () => {
    const { specsReturnPath } = seedPassingWorkerChain();
    writeFileSync(specsReturnPath, JSON.stringify({
      id: 'R2',
      from: 'opencode',
      to: 'larry',
      priority: 'normal',
      timestamp: '2026-07-12T01:00:00.000Z',
      text: 'tampered',
      reply_to: 'D1',
      sig: '00'.repeat(32),
    }), 'utf-8');

    const verified = verifyChainDetailed({
      slug: 'hard-spec-gate',
      throughStage: 'specs',
      maxAgeSeconds: 86_400,
      scopeSha: describeArtifact(specsDir).sha256,
      ledgerPath,
      secretPath,
      busStoreRoot,
      nowSeconds: 350,
    });
    expect(verified).toMatchObject({ ok: false, code: 'TRANSCRIPT_TAMPERED' });
  });
});
