import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  describeArtifact,
  emitLedgerRow,
} from '../../../src/pipeline/ledger';
import {
  formatBatchedPage,
  runBypassAudit,
} from '../../../src/pipeline/bypass-audit';

function transcriptLine(sessionId: string, timestamp: string, block: Record<string, unknown>, type: 'assistant' | 'user' = 'assistant'): string {
  return JSON.stringify({
    type,
    timestamp,
    sessionId,
    isSidechain: true,
    message: {
      role: type,
      content: [block],
    },
  });
}

function writeTranscript(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

function appendTranscript(path: string, lines: string[]): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8').trim() : '';
  writeTranscript(path, [
    ...(existing ? existing.split('\n') : []),
    ...lines,
  ]);
}

function busSign(key: string, id: string, from: string, to: string, text: string): string {
  return createHmac('sha256', key).update(`${id}:${from}:${to}:${text}`).digest('hex');
}

function writeBusMessage(dir: string, msg: {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  reply_to?: string | null;
  busKey?: string;
  sig?: string;
}): string {
  mkdirSync(dir, { recursive: true });
  const sig = msg.sig ?? (msg.busKey ? busSign(msg.busKey, msg.id, msg.from, msg.to, msg.text) : undefined);
  const path = join(dir, `2-${msg.id}.json`);
  writeFileSync(path, JSON.stringify({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    priority: 'normal',
    timestamp: msg.timestamp,
    text: msg.text,
    reply_to: msg.reply_to ?? null,
    ...(sig ? { sig } : {}),
  }), 'utf-8');
  return path;
}

describe('pipeline bypass audit', () => {
  let root: string;
  let ctxRoot: string;
  let projectRoot: string;
  let parentTranscriptRoot: string;
  let projectsRoot: string;
  let ledgerPath: string;
  let secretPath: string;
  let secret: string;
  let busKey: string;
  let nowMs: number;
  let slugDir: string;
  let researchPath: string;
  let planPath: string;
  let specsDir: string;
  let specPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pipeline-bypass-audit-'));
    ctxRoot = join(root, 'ctx');
    projectRoot = join(root, 'repo');
    parentTranscriptRoot = join(root, 'parent-transcripts');
    projectsRoot = join(root, 'projects');
    ledgerPath = join(projectRoot, 'state', 'pipeline-ledger.jsonl');
    secretPath = join(root, '.pipeline-secret');
    secret = 'ab'.repeat(32);
    busKey = 'bk'.repeat(20);
    nowMs = Date.UTC(2026, 6, 12, 2, 30, 0);
    slugDir = join(projectRoot, '.agent', 'one-big-feature', 'hard-spec-gate');
    researchPath = join(slugDir, '01-research.md');
    planPath = join(slugDir, '02-master-plan.md');
    specsDir = join(slugDir, '03-specs');
    specPath = join(specsDir, '01-signed-stage-ledger.md');

    mkdirSync(specsDir, { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(ctxRoot, 'processed', 'codexer'), { recursive: true });
    writeFileSync(secretPath, `${secret}\n`, 'utf-8');
    writeFileSync(join(ctxRoot, 'config', 'bus-signing-key'), `${busKey}\n`, 'utf-8');
    writeFileSync(researchPath, '# research\n', 'utf-8');
    writeFileSync(planPath, '# master plan\n', 'utf-8');
    writeFileSync(specPath, '# signed spec\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runAudit() {
    return runBypassAudit({
      ctxRoot,
      projectRoot,
      parentTranscriptRoot,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
      nowMs,
    });
  }

  it('flags a seeded dispatch with no signed chain', () => {
    const sessionId = 'parent-session';
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    writeTranscript(parentTranscript, [
      transcriptLine(sessionId, new Date(nowMs - 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_dispatch',
        name: 'Bash',
        input: {
          command: `cortextos bus send-message codexer normal 'GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${'a'.repeat(64)}'`,
        },
      }),
    ]);

    const report = runAudit();
    expect(report.bypasses).toHaveLength(1);
    expect(report.bypasses[0]).toMatchObject({
      kind: 'dispatch-no-chain',
      slug: 'hard-spec-gate',
      code: 'NO_ROWS',
    });
  });

  it('passes a clean window with valid chain and matching spawn records', () => {
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    const planSession = 'plan-session';
    const specsSession = 'specs-session';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');

    writeTranscript(planTranscript, [
      transcriptLine(planSession, new Date(nowMs - 20 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_write',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
      transcriptLine(planSession, new Date(nowMs - 19 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_write',
        content: 'ok',
      }, 'user'),
    ]);
    writeTranscript(specsTranscript, [
      transcriptLine(specsSession, new Date(nowMs - 15 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_specs_write',
        name: 'Write',
        input: { file_path: specPath, content: '# signed spec\n' },
      }),
      transcriptLine(specsSession, new Date(nowMs - 14 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_specs_write',
        content: 'ok',
      }, 'user'),
    ]);
    writeTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 24 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_spawn',
        name: 'Agent',
        input: {
          description: 'Plan hard-spec-gate',
          subagent_type: 'fable-lean',
          prompt: `Work on ${projectRoot}/.agent/one-big-feature/hard-spec-gate/02-master-plan.md`,
        },
      }),
      transcriptLine('parent', new Date(nowMs - 23 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_spawn',
        content: 'done',
      }, 'user'),
      transcriptLine('parent', new Date(nowMs - 18 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_specs_spawn',
        name: 'Agent',
        input: {
          description: 'Specs hard-spec-gate',
          subagent_type: 'architect',
          prompt: `Write specs for ${projectRoot}/.agent/one-big-feature/hard-spec-gate/03-specs/`,
        },
      }),
      transcriptLine('parent', new Date(nowMs - 17 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_specs_spawn',
        content: 'done',
      }, 'user'),
    ]);

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
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
      nowSeconds: Math.floor((nowMs - 21 * 60_000) / 1000),
    });
    const specsRow = emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 16 * 60_000) / 1000),
    });

    appendTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 12 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_dispatch_ok',
        name: 'Bash',
        input: {
          command: `cortextos bus send-message codexer normal 'GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${specsRow.artifact_sha256}'`,
        },
      }),
    ]);

    const report = runAudit();
    expect(report.bypasses).toEqual([]);
    expect(report.provenance_rows_checked).toBe(2);
  });

  it('flags ordering violations via the artifact check', () => {
    const planSession = 'plan-order';
    const specsSession = 'specs-order';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');

    writeTranscript(planTranscript, [
      transcriptLine(planSession, new Date(nowMs - 20 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
      transcriptLine(planSession, new Date(nowMs - 19 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan',
        content: 'ok',
      }, 'user'),
    ]);
    writeTranscript(specsTranscript, [
      transcriptLine(specsSession, new Date(nowMs - 17 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_specs',
        name: 'Write',
        input: { file_path: specPath, content: '# signed spec\n' },
      }),
      transcriptLine(specsSession, new Date(nowMs - 16 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_specs',
        content: 'ok',
      }, 'user'),
    ]);
    writeTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 22 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_spawn',
        name: 'Agent',
        input: { description: 'Plan hard-spec-gate', prompt: 'hard-spec-gate plan' },
      }),
      transcriptLine('parent', new Date(nowMs - 21 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_spawn',
        content: 'done',
      }, 'user'),
      transcriptLine('parent', new Date(nowMs - 18 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_specs_spawn',
        name: 'Agent',
        input: { description: 'Specs hard-spec-gate', prompt: 'hard-spec-gate specs' },
      }),
      transcriptLine('parent', new Date(nowMs - 17 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_specs_spawn',
        content: 'done',
      }, 'user'),
    ]);

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
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
      nowSeconds: Math.floor((nowMs - 20 * 60_000) / 1000),
    });
    const specsRow = emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: specsSession,
      transcriptPath: specsTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 15 * 60_000) / 1000),
    });

    utimesSync(researchPath, (nowMs - 5 * 60_000) / 1000, (nowMs - 5 * 60_000) / 1000);
    utimesSync(planPath, (nowMs - 50 * 60_000) / 1000, (nowMs - 50 * 60_000) / 1000);

    appendTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 10 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_dispatch_order',
        name: 'Bash',
        input: {
          command: `cortextos bus send-message codexer normal 'GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${specsRow.artifact_sha256}'`,
        },
      }),
    ]);

    const report = runAudit();
    expect(report.bypasses.some(finding => finding.code === 'ORDERING')).toBe(true);
  });

  it('flags bus-store dispatches that have no matching transcript command', () => {
    const busPath = join(ctxRoot, 'processed', 'codexer', '2-123-from-larry-abcd1.json');
    writeFileSync(busPath, JSON.stringify({
      id: '1783820251610-larry-jl7uv',
      from: 'larry',
      to: 'codexer',
      priority: 'normal',
      timestamp: new Date(nowMs - 5 * 60_000).toISOString(),
      text: `GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${'a'.repeat(64)}`,
      reply_to: null,
    }), 'utf-8');

    const report = runAudit();
    expect(report.bypasses).toMatchObject([
      { kind: 'bus-store-bypass', slug: 'hard-spec-gate' },
    ]);
  });

  it('flags authored rows with no parent spawn record', () => {
    const planSession = 'plan-no-spawn';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeTranscript(planTranscript, [
      transcriptLine(planSession, new Date(nowMs - 20 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
      transcriptLine(planSession, new Date(nowMs - 19 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan',
        content: 'ok',
      }, 'user'),
    ]);

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
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
      nowSeconds: Math.floor((nowMs - 20 * 60_000) / 1000),
    });

    const report = runAudit();
    expect(report.bypasses).toMatchObject([
      { kind: 'hole3-no-spawn', slug: 'hard-spec-gate' },
    ]);
  });

  it('flags deep-authorship tampering after emit', () => {
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    const planSession = 'plan-tampered';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeTranscript(planTranscript, [
      transcriptLine(planSession, new Date(nowMs - 20 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
      transcriptLine(planSession, new Date(nowMs - 19 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan',
        content: 'ok',
      }, 'user'),
    ]);
    writeTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 22 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_spawn',
        name: 'Agent',
        input: { description: 'Plan hard-spec-gate', prompt: 'hard-spec-gate plan' },
      }),
      transcriptLine('parent', new Date(nowMs - 21 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_spawn',
        content: 'done',
      }, 'user'),
    ]);

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
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
      nowSeconds: Math.floor((nowMs - 20 * 60_000) / 1000),
    });

    writeFileSync(planTranscript, `${readFileSync(planTranscript, 'utf-8')}${transcriptLine(planSession, new Date(nowMs - 18 * 60_000).toISOString(), {
      type: 'tool_use',
      id: 'toolu_plan_tamper',
      name: 'Write',
      input: { file_path: planPath, content: '# tampered plan\n' },
    })}\n`, 'utf-8');

    const report = runAudit();
    expect(report.bypasses.some(finding => finding.kind === 'hole3-deep-authorship')).toBe(true);
  });

  it('flags the hand-authoring combo even when spawn and transcript exist', () => {
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    const planSession = 'plan-hand-author';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeTranscript(planTranscript, [
      transcriptLine(planSession, new Date(nowMs - 20 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
      transcriptLine(planSession, new Date(nowMs - 19 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan',
        content: 'ok',
      }, 'user'),
    ]);
    writeTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 24 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_spawn',
        name: 'Agent',
        input: { description: 'Plan hard-spec-gate', prompt: 'hard-spec-gate plan' },
      }),
      transcriptLine('parent', new Date(nowMs - 23 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_spawn',
        content: 'done',
      }, 'user'),
      transcriptLine('parent', new Date(nowMs - 22 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_hand_write',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
    ]);

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
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
      nowSeconds: Math.floor((nowMs - 20 * 60_000) / 1000),
    });

    const report = runAudit();
    expect(report.bypasses.some(finding => finding.kind === 'hole3-hand-authoring')).toBe(true);
  });

  it('flags an unbacked worker dispatch with dispatch-no-chain', () => {
    const sessionId = 'parent-worker-dispatch';
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    writeTranscript(parentTranscript, [
      transcriptLine(sessionId, new Date(nowMs - 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_dispatch_worker',
        name: 'Bash',
        input: {
          command: `cortextos bus send-message opencode normal 'GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${'a'.repeat(64)}'`,
        },
      }),
    ]);

    const report = runAudit();
    expect(report.bypasses).toContainEqual(expect.objectContaining({
      kind: 'dispatch-no-chain',
      slug: 'hard-spec-gate',
      code: 'NO_ROWS',
    }));
  });

  it('accepts a valid worker-dispatch row without hole3-structure findings', () => {
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    const dispatchTimestamp = new Date(nowMs - 12 * 60_000).toISOString();
    const dispatchText = `GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${describeArtifact(specsDir).sha256}`;
    writeTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 24 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_spawn',
        name: 'Agent',
        input: {
          description: 'Plan hard-spec-gate',
          subagent_type: 'opencode',
          prompt: `Plan ${projectRoot}/.agent/one-big-feature/hard-spec-gate/02-master-plan.md`,
        },
      }),
      transcriptLine('parent', new Date(nowMs - 23 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_spawn',
        content: 'done',
      }, 'user'),
      transcriptLine('parent', new Date(nowMs - 18 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_specs_spawn',
        name: 'Agent',
        input: {
          description: 'Specs hard-spec-gate',
          subagent_type: 'opencode',
          prompt: `Write specs for ${projectRoot}/.agent/one-big-feature/hard-spec-gate/03-specs/`,
        },
      }),
      transcriptLine('parent', new Date(nowMs - 17 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_specs_spawn',
        content: 'done',
      }, 'user'),
      transcriptLine('parent', dispatchTimestamp, {
        type: 'tool_use',
        id: 'toolu_dispatch_worker_ok',
        name: 'Bash',
        input: {
          command: `cortextos bus send-message opencode normal '${dispatchText}'`,
        },
      }),
    ]);

    writeBusMessage(join(ctxRoot, 'processed', 'opencode'), {
      id: 'D1',
      from: 'larry',
      to: 'opencode',
      text: dispatchText,
      timestamp: dispatchTimestamp,
      busKey,
    });
    const planReturnPath = writeBusMessage(join(ctxRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      timestamp: new Date(nowMs - 11 * 60_000).toISOString(),
      reply_to: 'D1',
      busKey,
    });
    const specsReturnPath = writeBusMessage(join(ctxRoot, 'processed', 'larry'), {
      id: 'R2',
      from: 'opencode',
      to: 'larry',
      text: `done\nPROVENANCE: stage=specs slug=hard-spec-gate artifact-sha256=${describeArtifact(specsDir).sha256}`,
      timestamp: new Date(nowMs - 10 * 60_000).toISOString(),
      reply_to: 'D1',
      busKey,
    });

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'opencode',
      sessionId: 'R1',
      transcriptPath: planReturnPath,
      provenanceMode: 'worker-dispatch',
      busStoreRoot: ctxRoot,
      busKeyCtxRoot: ctxRoot,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 11 * 60_000) / 1000),
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'opencode',
      sessionId: 'R2',
      transcriptPath: specsReturnPath,
      provenanceMode: 'worker-dispatch',
      busStoreRoot: ctxRoot,
      busKeyCtxRoot: ctxRoot,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 10 * 60_000) / 1000),
    });

    const report = runAudit();
    expect(report.bypasses).toEqual([]);
    expect(report.bypasses.some(finding => finding.kind === 'hole3-structure')).toBe(false);
  });

  it('flags worker-dispatch return-message tampering as hole3-deep-authorship', () => {
    const parentTranscript = join(parentTranscriptRoot, 'main.jsonl');
    writeTranscript(parentTranscript, [
      transcriptLine('parent', new Date(nowMs - 24 * 60_000).toISOString(), {
        type: 'tool_use',
        id: 'toolu_plan_spawn',
        name: 'Agent',
        input: {
          description: 'Plan hard-spec-gate',
          subagent_type: 'opencode',
          prompt: `Plan ${projectRoot}/.agent/one-big-feature/hard-spec-gate/02-master-plan.md`,
        },
      }),
      transcriptLine('parent', new Date(nowMs - 23 * 60_000).toISOString(), {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_spawn',
        content: 'done',
      }, 'user'),
    ]);

    writeBusMessage(join(ctxRoot, 'processed', 'opencode'), {
      id: 'D1',
      from: 'larry',
      to: 'opencode',
      text: `GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${'a'.repeat(64)}`,
      timestamp: new Date(nowMs - 12 * 60_000).toISOString(),
      busKey,
    });
    const planReturnPath = writeBusMessage(join(ctxRoot, 'processed', 'larry'), {
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      timestamp: new Date(nowMs - 11 * 60_000).toISOString(),
      reply_to: 'D1',
      busKey,
    });

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 25 * 60_000) / 1000),
    });
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'opencode',
      sessionId: 'R1',
      transcriptPath: planReturnPath,
      provenanceMode: 'worker-dispatch',
      busStoreRoot: ctxRoot,
      busKeyCtxRoot: ctxRoot,
      ledgerPath,
      secretPath,
      nowSeconds: Math.floor((nowMs - 11 * 60_000) / 1000),
    });

    writeFileSync(planReturnPath, JSON.stringify({
      id: 'R1',
      from: 'opencode',
      to: 'larry',
      priority: 'normal',
      timestamp: new Date(nowMs - 11 * 60_000).toISOString(),
      text: `done\nPROVENANCE: stage=plan slug=hard-spec-gate artifact-sha256=${describeArtifact(planPath).sha256}`,
      reply_to: 'D1',
      sig: '00'.repeat(32),
    }), 'utf-8');

    const report = runAudit();
    expect(report.bypasses).toContainEqual(expect.objectContaining({
      kind: 'hole3-deep-authorship',
      slug: 'hard-spec-gate',
      code: 'TRANSCRIPT_TAMPERED',
    }));
  });

  it('batches multiple findings into one page body', () => {
    const body = formatBatchedPage({
      window: { start_ms: 1, end_ms: 2 },
      dispatches_found: 3,
      prs_found: 0,
      chains_verified: 0,
      provenance_rows_checked: 0,
      advisories: [],
      exempt_count_7d: 0,
      bypasses: [
        { kind: 'dispatch-no-chain', slug: 'a', code: 'NO_ROWS', detail: 'missing', evidence: [] },
        { kind: 'bus-store-bypass', slug: 'b', detail: 'ghost', evidence: [] },
        { kind: 'hole3-no-spawn', slug: 'c', detail: 'forgery', evidence: [] },
      ],
    });

    expect(body).toContain('Pipeline bypass audit found 3 issue(s)');
    expect(body.split('\n').filter(line => line.startsWith('- '))).toHaveLength(3);
  });

  it('adds an exemption-threshold advisory after 11 signed exempts in 7 days', () => {
    for (let index = 0; index < 11; index += 1) {
      const exemptPath = join(slugDir, `exempt-${index}.md`);
      writeFileSync(exemptPath, `# exempt ${index}\n`, 'utf-8');
      emitLedgerRow({
        slug: 'hard-spec-gate',
        stage: 'exempt',
        artifactPath: exemptPath,
        reason: 'seed',
        ledgerPath,
        secretPath,
        nowSeconds: Math.floor((nowMs - (index * 60 * 60 * 1000)) / 1000),
      });
    }

    const report = runAudit();
    expect(report.advisories.some(advisory => advisory.kind === 'exempt-threshold')).toBe(true);
  });
});
