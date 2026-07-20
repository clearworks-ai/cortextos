import { spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { describeArtifact, emitLedgerRow, type LedgerRow } from '../../../src/pipeline/ledger';

// The gate shell hooks are per-agent, gitignored, defense-in-depth artifacts —
// they are NOT part of the repo, so they are absent in CI and on other machines.
// Derive the repo root from this test's location and only run the hook suite when
// the hooks are actually present locally. The authoritative sink + ledger +
// provenance behaviour is covered independently by message.test.ts / ledger.test.ts.
const repoRoot = process.env.CTX_FRAMEWORK_ROOT || resolve(__dirname, '../../..');
const gateCodexer = join(repoRoot, 'orgs/clearworksai/agents/larry/.claude/hooks/gate-codexer-planning.sh');
const blockDirectCoding = join(repoRoot, 'orgs/clearworksai/agents/larry/.claude/hooks/block-direct-coding.sh');
const gatePrPush = join(repoRoot, 'orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh');
const hooksPresent = existsSync(gateCodexer) && existsSync(blockDirectCoding);
const prHookPresent = existsSync(gatePrPush);
const describeHooks = hooksPresent ? describe : describe.skip;
const describePrHook = prHookPresent ? describe : describe.skip;

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

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
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

describePrHook('pr push gate hook', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  let secretPath: string;
  let ledgerPath: string;
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

  function writeAuthoredTranscript(path: string, sessionId: string, filePath: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      transcriptLine(sessionId, {
        type: 'tool_use',
        id: `toolu_${sessionId}`,
        name: 'Write',
        input: { file_path: filePath, content },
      }),
      transcriptLine(sessionId, {
        type: 'tool_result',
        tool_use_id: `toolu_${sessionId}`,
        content: 'ok',
      }, 'user'),
    ].join('\n') + '\n', 'utf-8');
  }

  function setOrigin(url: string): void {
    runGit(['remote', 'set-url', 'origin', url], projectRoot);
  }

  function seedReviewChain(nowSeconds: number): LedgerRow {
    const planSession = 'plan-session';
    const planTranscript = join(projectsRoot, 'larry', planSession, 'subagents', 'agent-plan.jsonl');
    writeAuthoredTranscript(planTranscript, planSession, planPath, '# master plan\n');
    writeFileSync(planPath, '# master plan\n', 'utf-8');

    const specsSession = 'specs-session';
    const specsTranscript = join(projectsRoot, 'larry', specsSession, 'subagents', 'agent-specs.jsonl');
    writeAuthoredTranscript(specsTranscript, specsSession, specPath, '# signed spec\n');
    writeFileSync(specPath, '# signed spec\n', 'utf-8');

    const reviewSession = 'review-session';
    const reviewTranscript = join(projectsRoot, 'larry', reviewSession, 'subagents', 'agent-review.jsonl');
    writeAuthoredTranscript(reviewTranscript, reviewSession, reviewPath, '# review\n');
    writeFileSync(reviewPath, '# review\n', 'utf-8');

    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'research',
      artifactPath: researchPath,
      ledgerPath,
      secretPath,
      nowSeconds: nowSeconds - 40,
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
      nowSeconds: nowSeconds - 30,
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
      nowSeconds: nowSeconds - 20,
    });
    return emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'review',
      artifactPath: reviewPath,
      runner: 'larry',
      sessionId: reviewSession,
      transcriptPath: reviewTranscript,
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: nowSeconds - 15,
    });
  }

  function emitStagingRow(nowSeconds: number): void {
    writeFileSync(stagingArtifactPath, `staging build ${nowSeconds}\n`, 'utf-8');
    writeFileSync(stagingEvidencePath, 'staging ok\n', 'utf-8');
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'staging-verify',
      artifactPath: stagingArtifactPath,
      evidencePath: stagingEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds,
    });
  }

  function emitTrueVerifyRow(nowSeconds: number): void {
    writeFileSync(trueVerifyArtifactPath, `true verify build ${nowSeconds}\n`, 'utf-8');
    writeFileSync(trueVerifyEvidencePath, 'true verify ok\n', 'utf-8');
    emitLedgerRow({
      slug: 'hard-spec-gate',
      stage: 'true-verify',
      artifactPath: trueVerifyArtifactPath,
      evidencePath: trueVerifyEvidencePath,
      ledgerPath,
      secretPath,
      nowSeconds,
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pr-hook-gates-'));
    projectRoot = join(root, 'repo');
    projectsRoot = join(root, 'projects');
    secretPath = join(root, '.pipeline-secret');
    ledgerPath = join(projectRoot, 'state', 'pipeline-ledger.jsonl');
    secret = 'ab'.repeat(32);
    slugDir = join(projectRoot, '.agent', 'one-big-feature', 'hard-spec-gate');
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
    writeFileSync(secretPath, `${secret}\n`, 'utf-8');
    writeFileSync(researchPath, '# research\n', 'utf-8');
    writeFileSync(planPath, '# master plan\n', 'utf-8');
    writeFileSync(specPath, '# signed spec\n', 'utf-8');
    writeFileSync(reviewPath, '# review\n', 'utf-8');
    writeFileSync(stagingArtifactPath, 'staging build\n', 'utf-8');
    writeFileSync(stagingEvidencePath, 'staging ok\n', 'utf-8');
    writeFileSync(trueVerifyArtifactPath, 'true verify build\n', 'utf-8');
    writeFileSync(trueVerifyEvidencePath, 'true verify ok\n', 'utf-8');

    runGit(['init'], projectRoot);
    runGit(['checkout', '-b', 'feature/hard-spec-gate'], projectRoot);
    runGit(['config', 'user.email', 'tests@example.com'], projectRoot);
    runGit(['config', 'user.name', 'Pipeline Tests'], projectRoot);
    runGit(['commit', '--allow-empty', '-m', 'init'], projectRoot);
    runGit(['remote', 'add', 'origin', 'git@github.com:joshweiss/cortextos.git'], projectRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks prod-repo PRs without a fresh staging-verify row', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    setOrigin('git@github.com:clearworks/clearpath.git');
    seedReviewChain(nowSeconds);
    emitTrueVerifyRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain('Staging-First');
  });

  it('passes prod-repo PRs with a fresh staging-verify row', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    setOrigin('git@github.com:clearworks/clearpath.git');
    seedReviewChain(nowSeconds);
    emitStagingRow(nowSeconds - 10);
    emitTrueVerifyRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('blocks stale staging-verify rows for prod-repo PRs', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const staleTerminalTs = nowSeconds - 90_000;
    setOrigin('git@github.com:clearworks/clearpath.git');
    seedReviewChain(staleTerminalTs);
    emitStagingRow(staleTerminalTs);
    emitTrueVerifyRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain('older than 86400s');
  });

  it('blocks empty staging evidence for prod-repo PRs', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    setOrigin('git@github.com:clearworks/clearpath.git');
    const reviewRow = seedReviewChain(nowSeconds);
    writeFileSync(stagingEvidencePath, '', 'utf-8');
    const stagingRow = signRow(secret, {
      slug: 'hard-spec-gate',
      stage: 'staging-verify',
      ts: nowSeconds - 10,
      artifact_sha256: describeArtifact(stagingArtifactPath).sha256,
      prev_sha256: reviewRow.artifact_sha256,
      evidence_path: resolve(stagingEvidencePath),
    });
    appendFileSync(ledgerPath, `${JSON.stringify(stagingRow)}\n`, 'utf-8');
    emitTrueVerifyRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain('missing or empty');
  });

  it('skips the staging gate for cortextos-origin PRs', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    setOrigin('git@github.com:joshweiss/cortextos.git');
    seedReviewChain(nowSeconds);
    emitTrueVerifyRow(nowSeconds - 5);

    const result = runHook(gatePrPush, {
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --fill',
      },
    }, {
      CTX_PROJECT_ROOT: projectRoot,
      PIPELINE_SECRET_PATH: secretPath,
      PIPELINE_TRANSCRIPT_ROOT_OVERRIDE: projectsRoot,
    }, projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
