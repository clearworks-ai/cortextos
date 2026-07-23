import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  applyBuildOutput,
  computeGitRefArtifactSha256,
  deployToStaging,
  runMigrateStage,
  runSeedStage,
  teardownDeployment,
} from './deploy.js';
import { CookieJar, loadScenario, runDrive, type DriveState } from './drive.js';
import { currentToolVersion, evidencePath as resolvedEvidencePath, redact, writeEvidence } from './evidence.js';
import { emitStagingVerify, preflightReviewRow } from './emit.js';
import { RailwayCli, defaultExec } from './railway.js';
import { defaultRepoRegistry, loadRepoRegistry, resolveRepo } from './repos.js';
import { runLoop } from './runner.js';
import { readEndState } from './state-read.js';
import type {
  AssertionResult,
  RepoConfig,
  RunContext,
  Scenario,
  StageName,
  StageRecord,
  StagingVerifyEvidence,
} from './types.js';
import { runVerifyCommand } from './verify.js';

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

interface RuntimeState {
  scenario?: Scenario;
  driveState: DriveState;
  assertionResults: AssertionResult[];
  verifyExitCode: number;
  verifyOutputTail: string;
  worktree?: string;
  startedAt: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (!rawKey) continue;
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[rawKey] = true;
      continue;
    }
    flags[rawKey] = next;
    index += 1;
  }

  return { flags, positional };
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function requireString(flags: Record<string, string | boolean>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage:',
    '  staging-verify --slug <slug> --repo <name|path> --build-output <path>',
    '                 [--staging-env <name=staging>] [--scenario <path>]',
    '                 [--max-attempts <n=3>] [--runner <name=staging-verify-loop>]',
    '                 [--config <repos.json>] [--ledger <path>] [--secret <path>]',
    '                 [--evidence-dir <dir>] [--keep-deploy] [--dry-run] [--json]',
  ].join('\n');
}

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function stdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printAndExit(message: string, code: number, toStderr = true): never {
  (toStderr ? stderr : stdout)(message);
  process.exit(code);
}

function evidenceDir(flagValue: string | undefined): string {
  if (flagValue) return resolve(flagValue);
  if (process.env.CTX_AGENT_DIR) {
    return resolve(process.env.CTX_AGENT_DIR, 'state', 'staging-verify');
  }
  return resolve(process.cwd(), 'state', 'staging-verify');
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseMaxAttempts(value: string | undefined): number {
  if (!value) return 3;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid --max-attempts: ${value}`);
  }
  return Math.min(Math.max(parsed, 1), 5);
}

function buildContext(repo: RepoConfig, flags: Record<string, string | boolean>): RunContext {
  return {
    slug: requireString(flags, 'slug'),
    repo,
    buildOutputPath: requireString(flags, 'build-output'),
    buildOutputSha256: '',
    attempt: 1,
    maxAttempts: parseMaxAttempts(stringFlag(flags, 'max-attempts')),
    runner: stringFlag(flags, 'runner') ?? 'staging-verify-loop',
    evidenceDir: evidenceDir(stringFlag(flags, 'evidence-dir')),
    ledgerPath: stringFlag(flags, 'ledger'),
    secretPath: stringFlag(flags, 'secret'),
    keepDeploy: Boolean(flags['keep-deploy']),
    log: stderr,
    startedAt: new Date().toISOString(),
  };
}

function resolveRepoConfig(flags: Record<string, string | boolean>): RepoConfig {
  const registry = stringFlag(flags, 'config')
    ? loadRepoRegistry(stringFlag(flags, 'config'))
    : defaultRepoRegistry();
  const repo = resolveRepo(registry, requireString(flags, 'repo'));
  const stagingEnv = stringFlag(flags, 'staging-env');
  const scenario = stringFlag(flags, 'scenario');
  return {
    ...repo,
    stagingEnv: stagingEnv ?? repo.stagingEnv,
    scenarioPath: scenario ? resolve(scenario) : repo.scenarioPath,
  };
}

function buildPlan(ctx: RunContext, runtime: RuntimeState): Record<string, unknown> {
  return {
    slug: ctx.slug,
    repo: ctx.repo.key,
    localPath: ctx.repo.localPath,
    railwayProject: ctx.repo.railwayProject,
    stagingEnv: ctx.repo.stagingEnv,
    buildOutput: ctx.buildOutputPath,
    buildOutputSha256: ctx.buildOutputSha256,
    runner: ctx.runner,
    maxAttempts: ctx.maxAttempts,
    evidenceDir: ctx.evidenceDir,
    scenarioPath: ctx.repo.scenarioPath,
    scenarioExists: ctx.repo.scenarioPath ? existsSync(ctx.repo.scenarioPath) : false,
    startedAt: runtime.startedAt,
  };
}

function finalFailureStage(stages: StageRecord[]): { stage: StageName; detail: string } | undefined {
  const failed = [...stages].reverse().find((stage) => stage.outcome !== 'ok' && stage.stage !== 'teardown');
  if (!failed) return undefined;
  return {
    stage: failed.stage,
    detail: failed.detail ?? failed.outcome,
  };
}

function buildEvidence(ctx: RunContext, runtime: RuntimeState, failure?: { stage: StageName; detail: string }): StagingVerifyEvidence {
  const stages = (ctx.stageRecords ?? []).map((stage) => ({
    ...stage,
    detail: stage.detail ? redact(stage.detail) : undefined,
  }));
  return {
    schema: 'staging-verify-evidence/v1',
    slug: ctx.slug,
    ok: !failure,
    repo: ctx.repo.localPath,
    staging_url: ctx.stagingUrl ?? '',
    verify_command: ctx.repo.verifyCommand,
    exit_code: runtime.verifyExitCode,
    build_output_sha256: ctx.buildOutputSha256,
    assertions: runtime.assertionResults,
    build_output_kind: 'git-ref',
    applied_git_sha: ctx.appliedGitSha ?? '',
    railway_project: ctx.repo.railwayProject,
    staging_env: ctx.repo.stagingEnv,
    attempts: ctx.attempt,
    max_attempts: ctx.maxAttempts,
    scenario: runtime.scenario?.name ?? 'minimal',
    stages,
    verify_output_tail: redact(runtime.verifyOutputTail),
    failure: failure ? { stage: failure.stage, detail: redact(failure.detail) } : undefined,
    started_at: runtime.startedAt,
    finished_at: new Date().toISOString(),
    runner: ctx.runner,
    tool_version: currentToolVersion(),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || flags.h || positional.includes('help')) {
    printAndExit(usage(), 0, false);
  }

  try {
    const repo = resolveRepoConfig(flags);
    const ctx = buildContext(repo, flags);
    const runtime: RuntimeState = {
      driveState: {
        jar: new CookieJar(),
        captures: {},
      },
      assertionResults: [],
      verifyExitCode: -1,
      verifyOutputTail: '',
      startedAt: ctx.startedAt ?? new Date().toISOString(),
    };
    const exec = defaultExec();
    const railway = new RailwayCli({ exec, repo: ctx.repo });

    const preflight = async (): Promise<ReturnType<typeof preflightReviewRow> extends Promise<infer T> ? T : never> => {
      try {
        const review = await preflightReviewRow(ctx, { exec });
        if (review.kind !== 'ok') return review;
        const environments = await railway.environmentList(ctx.repo.localPath);
        if (!environments.includes(ctx.repo.stagingEnv)) {
          return {
            kind: 'fatal',
            detail: 'staging env missing — see PIPELINE-STAGING.md, create via railway environment new',
          };
        }
        const artifact = await computeGitRefArtifactSha256(ctx.repo, ctx.buildOutputPath, exec);
        ctx.buildOutputSha256 = artifact.sha256;
        ctx.appliedGitSha = artifact.gitSha;
        return { kind: 'ok' };
      } catch (error) {
        return {
          kind: 'fatal',
          detail: toMessage(error),
        };
      }
    };

    if (flags['dry-run']) {
      const outcome = await preflight();
      if (outcome.kind !== 'ok') {
        throw new Error(outcome.detail);
      }
      stdout(JSON.stringify(buildPlan(ctx, runtime)));
      process.exit(0);
    }

    const result = await runLoop(ctx, {
      preflight,
      apply: async (currentCtx) => {
        const outcome = await applyBuildOutput(currentCtx, { exec });
        runtime.worktree = currentCtx.appliedArtifactPath;
        return outcome;
      },
      deploy: (currentCtx) => deployToStaging(currentCtx, { exec, railway }),
      migrate: (currentCtx) => runMigrateStage(currentCtx, { exec, railway }),
      seed: (currentCtx) => runSeedStage(currentCtx, { exec, railway }),
      drive: async (currentCtx) => {
        try {
          runtime.scenario = loadScenario(currentCtx.repo);
          runtime.driveState = { jar: new CookieJar(), captures: {} };
          return runDrive(currentCtx, runtime.scenario, fetch, runtime.driveState);
        } catch (error) {
          return {
            kind: 'fatal',
            detail: toMessage(error),
          };
        }
      },
      readState: async (currentCtx) => {
        try {
          runtime.scenario = runtime.scenario ?? loadScenario(currentCtx.repo);
          const read = await readEndState(currentCtx, runtime.scenario, {
            fetchImpl: fetch,
            jar: runtime.driveState.jar,
            railway,
            worktree: runtime.worktree ?? currentCtx.appliedArtifactPath ?? currentCtx.repo.localPath,
          });
          runtime.assertionResults = read.results;
          return read.outcome;
        } catch (error) {
          return {
            kind: 'fatal',
            detail: toMessage(error),
          };
        }
      },
      verify: async (currentCtx) => {
        const verify = await runVerifyCommand(currentCtx, {
          exec,
          worktree: runtime.worktree ?? currentCtx.appliedArtifactPath ?? currentCtx.repo.localPath,
        });
        runtime.verifyExitCode = verify.exitCode;
        runtime.verifyOutputTail = verify.tailOutput;
        return verify.outcome;
      },
      evidence: async (currentCtx, failure) => {
        const evidence = buildEvidence(currentCtx, runtime, failure);
        return writeEvidence(currentCtx, evidence);
      },
      emit: async (currentCtx, evidenceFile) => emitStagingVerify(currentCtx, evidenceFile, { exec }),
      teardown: async (currentCtx) => {
        await teardownDeployment(currentCtx, { exec, railway });
      },
    });

    if (flags.json) {
      stdout(JSON.stringify(result));
    } else {
      stderr(`staging-verify ${result.ok ? 'succeeded' : 'failed'} for ${ctx.slug}`);
      if (result.evidencePath) stderr(`evidence: ${result.evidencePath}`);
    }

    process.exit(result.exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(message);
    process.exit(/Missing required --|Invalid --|Unknown --repo|build-output must be a git ref/.test(message) ? 2 : 1);
  }
}

if (require.main === module) {
  void main();
}
