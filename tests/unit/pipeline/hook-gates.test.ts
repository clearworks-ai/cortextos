import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { describeArtifact, emitLedgerRow } from '../../../src/pipeline/ledger';

// The gate shell hooks are per-agent, gitignored, defense-in-depth artifacts —
// they are NOT part of the repo, so they are absent in CI and on other machines.
// Derive the repo root from this test's location and only run the hook suite when
// the hooks are actually present locally. The authoritative sink + ledger +
// provenance behaviour is covered independently by message.test.ts / ledger.test.ts.
const repoRoot = process.env.CTX_FRAMEWORK_ROOT || resolve(__dirname, '../../..');
const gateCodexer = join(repoRoot, 'orgs/clearworksai/agents/larry/.claude/hooks/gate-codexer-planning.sh');
const blockDirectCoding = join(repoRoot, 'orgs/clearworksai/agents/larry/.claude/hooks/block-direct-coding.sh');
const hooksPresent = existsSync(gateCodexer) && existsSync(blockDirectCoding);
const describeHooks = hooksPresent ? describe : describe.skip;

function transcriptLine(sessionId: string, block: Record<string, unknown>, type: 'assistant' | 'user' = 'assistant'): string {
  return JSON.stringify({
    type,
    timestamp: '2026-07-12T01:00:00.000Z',
    sessionId,
    isSidechain: true,
    message: {
      role: type,
      content: [block],
    },
  });
}

function runHook(scriptPath: string, payload: unknown, env: Record<string, string>, cwd: string) {
  return spawnSync('bash', [scriptPath], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
}

describeHooks('hard-spec gate hooks', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  let secretPath: string;
  let ledgerPath: string;
  let slugDir: string;
  let researchPath: string;
  let planPath: string;
  let specsDir: string;
  let specPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hook-gates-'));
    projectRoot = join(root, 'repo');
    projectsRoot = join(root, 'projects');
    secretPath = join(root, '.pipeline-secret');
    ledgerPath = join(projectRoot, 'state', 'pipeline-ledger.jsonl');
    slugDir = join(projectRoot, '.agent', 'one-big-feature', 'hard-spec-gate');
    researchPath = join(slugDir, '01-research.md');
    planPath = join(slugDir, '02-master-plan.md');
    specsDir = join(slugDir, '03-specs');
    specPath = join(specsDir, '01-signed-stage-ledger.md');

    mkdirSync(specsDir, { recursive: true });
    writeFileSync(secretPath, `${'ab'.repeat(32)}\n`, 'utf-8');
    writeFileSync(researchPath, '# research\n', 'utf-8');
    writeFileSync(planPath, '# master plan\n', 'utf-8');
    writeFileSync(specPath, '# signed spec\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks ungated build dispatches with NO_ROWS', () => {
    const result = runHook(gateCodexer, {
      tool_name: 'Bash',
      tool_input: {
        command: `cortextos bus send-message codexer normal 'GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${'a'.repeat(64)}'`,
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain('NO_ROWS');
  });

  it('passes a valid build dispatch', () => {
    const planSession = 'plan-session';
    const specsSession = 'specs-session';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    const nowSeconds = Math.floor(Date.now() / 1000);

    mkdirSync(dirname(planTranscript), { recursive: true });
    mkdirSync(dirname(specsTranscript), { recursive: true });
    writeFileSync(planTranscript, [
      transcriptLine(planSession, {
        type: 'tool_use',
        id: 'toolu_plan_write',
        name: 'Write',
        input: { file_path: planPath, content: '# master plan\n' },
      }),
      transcriptLine(planSession, {
        type: 'tool_result',
        tool_use_id: 'toolu_plan_write',
        content: 'ok',
      }, 'user'),
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(specsTranscript, [
      transcriptLine(specsSession, {
        type: 'tool_use',
        id: 'toolu_specs_write',
        name: 'Write',
        input: { file_path: specPath, content: '# signed spec\n' },
      }),
      transcriptLine(specsSession, {
        type: 'tool_result',
        tool_use_id: 'toolu_specs_write',
        content: 'ok',
      }, 'user'),
    ].join('\n') + '\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: nowSeconds - 30,
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
      nowSeconds: nowSeconds - 20,
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
      nowSeconds: nowSeconds - 10,
    });

    const result = runHook(gateCodexer, {
      tool_name: 'Bash',
      tool_input: {
        command: `cortextos bus send-message codexer normal 'GATE: build framework=one-big-feature slug=hard-spec-gate repo=${projectRoot} scope-sha=${describeArtifact(specsDir).sha256}'`,
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('blocks secret reads and forbidden state writes through Bash', () => {
    const secretRead = runHook(blockDirectCoding, {
      tool_name: 'Bash',
      tool_input: {
        command: 'cat ~/.pipeline-secret',
      },
    }, {}, repoRoot);
    expect(secretRead.stdout).toContain('decision');
    expect(secretRead.stdout).toContain('.pipeline-secret');

    const ledgerWrite = runHook(blockDirectCoding, {
      tool_name: 'Bash',
      tool_input: {
        command: 'echo hi >> state/pipeline-ledger.jsonl',
      },
    }, {}, repoRoot);
    expect(ledgerWrite.stdout).toContain('pipeline-ledger.jsonl');
  });

  it('blocks direct Write access to runtime state but allows current mission', () => {
    const blocked = runHook(blockDirectCoding, {
      tool_name: 'Write',
      tool_input: {
        file_path: join(projectRoot, 'state', 'pipeline-run.json'),
      },
    }, {}, repoRoot);
    expect(blocked.stdout).toContain('decision');
    expect(blocked.stdout).toContain('pipeline-run.json');

    const allowed = runHook(blockDirectCoding, {
      tool_name: 'Write',
      tool_input: {
        file_path: join(projectRoot, 'state', 'current-mission.txt'),
      },
    }, {}, repoRoot);
    expect(allowed.stdout).toBe('');
  });
});
