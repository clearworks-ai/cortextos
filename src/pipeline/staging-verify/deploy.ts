import { createHash } from 'crypto';
import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { RailwayCli, defaultExec, type ExecFn, type ExecResult } from './railway.js';
import type { RepoConfig, RunContext, StageOutcome } from './types.js';

interface StageDeps {
  exec?: ExecFn;
  railway?: RailwayCli;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function normalizePathPart(value: string): string {
  return value.replace(/\\/g, '/');
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstInterestingLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

function transportLike(text: string): boolean {
  return /timed out|etimedout|econn|502|503|504|temporar|network|abort/i.test(text);
}

function ensureRailway(ctx: RunContext, deps: StageDeps): RailwayCli {
  return deps.railway ?? new RailwayCli({ exec: deps.exec, repo: ctx.repo });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(exec: ExecFn, cwd: string, cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return exec(cmd, args, { cwd, timeoutMs });
}

async function runGit(repoPath: string, args: string[], exec: ExecFn): Promise<ExecResult> {
  return runCommand(exec, repoPath, 'git', args, 120_000);
}

async function revParse(repoPath: string, ref: string, exec: ExecFn): Promise<string> {
  const result = await runGit(repoPath, ['rev-parse', '--verify', ref], exec);
  if (result.code !== 0) {
    throw new Error(firstInterestingLine(result.stderr || result.stdout) || `Unknown git ref: ${ref}`);
  }
  return result.stdout.trim();
}

function appendUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

function coerceUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function extractUrlCandidates(value: unknown, acc: Set<string>): void {
  if (typeof value === 'string') {
    if (value.includes('railway.app') || /^https?:\/\//i.test(value)) {
      acc.add(coerceUrl(value.trim()));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) extractUrlCandidates(entry, acc);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /(url|domain)/i.test(key)) {
      acc.add(coerceUrl(child.trim()));
      continue;
    }
    extractUrlCandidates(child, acc);
  }
}

function extractStagingUrl(status: unknown): string | undefined {
  const candidates = new Set<string>();
  extractUrlCandidates(status, candidates);
  return Array.from(candidates)[0];
}

async function computeTreeDigest(repoPath: string, sha: string, exec: ExecFn): Promise<string> {
  const list = await runGit(repoPath, ['ls-tree', '-r', '-z', '--name-only', sha], exec);
  if (list.code !== 0) {
    throw new Error(firstInterestingLine(list.stderr || list.stdout) || `Failed to list tree for ${sha}`);
  }
  const files = list.stdout.split('\0').filter((item) => item.length > 0);
  const lines: string[] = [];
  for (const file of files) {
    const show = await runGit(repoPath, ['show', `${sha}:${file}`], exec);
    if (show.code !== 0) {
      throw new Error(firstInterestingLine(show.stderr || show.stdout) || `Failed to read ${file} at ${sha}`);
    }
    const fileSha = createHash('sha256').update(show.stdout).digest('hex');
    lines.push(`${fileSha}  ${normalizePathPart(file)}`);
  }
  return createHash('sha256')
    .update(sha)
    .update('\n')
    .update(lines.join('\n'))
    .digest('hex');
}

function buildOutputExistsOnDisk(buildOutputPath: string): boolean {
  return existsSync(buildOutputPath);
}

function buildOutputIsDirectory(buildOutputPath: string): { isDirectory: boolean; error?: string } {
  if (!buildOutputExistsOnDisk(buildOutputPath)) {
    return { isDirectory: false };
  }
  try {
    return { isDirectory: statSync(buildOutputPath).isDirectory() };
  } catch (error) {
    return {
      isDirectory: false,
      error: `unable to inspect build-output path ${buildOutputPath}: ${toMessage(error)}`,
    };
  }
}

export async function computeGitRefArtifactSha256(
  repo: RepoConfig,
  buildOutputPath: string,
  exec: ExecFn = defaultExec(),
): Promise<{ gitSha: string; sha256: string }> {
  const buildOutputType = buildOutputIsDirectory(buildOutputPath);
  if (buildOutputType.error) {
    throw new Error(buildOutputType.error);
  }
  if (buildOutputType.isDirectory) {
    throw new Error('build-output must be a git ref/branch of the target repo');
  }
  const gitSha = await revParse(repo.localPath, buildOutputPath, exec);
  const sha256 = await computeTreeDigest(repo.localPath, gitSha, exec);
  return { gitSha, sha256 };
}

export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export async function applyBuildOutput(ctx: RunContext, deps: StageDeps = {}): Promise<StageOutcome> {
  const exec = deps.exec ?? defaultExec();
  try {
    const buildOutputType = buildOutputIsDirectory(ctx.buildOutputPath);
    if (buildOutputType.error) {
      return { kind: 'fatal', detail: buildOutputType.error };
    }
    if (buildOutputType.isDirectory) {
      return { kind: 'fatal', detail: 'build-output must be a git ref/branch of the target repo' };
    }
    const gitSha = await revParse(ctx.repo.localPath, ctx.buildOutputPath, exec);
    const worktreeRoot = resolve(dirname(ctx.repo.localPath), '.staging-verify-worktrees');
    const worktreePath = join(worktreeRoot, ctx.slug);
    mkdirSync(worktreeRoot, { recursive: true });

    if (existsSync(worktreePath)) {
      const checkout = await runGit(worktreePath, ['checkout', '--force', '--detach', gitSha], exec);
      if (checkout.code !== 0) {
        return { kind: 'fatal', detail: firstInterestingLine(checkout.stderr || checkout.stdout) || `git checkout failed for ${gitSha}` };
      }
      const reset = await runGit(worktreePath, ['reset', '--hard', gitSha], exec);
      if (reset.code !== 0) {
        return { kind: 'fatal', detail: firstInterestingLine(reset.stderr || reset.stdout) || `git reset failed for ${gitSha}` };
      }
      await runGit(worktreePath, ['clean', '-fd'], exec);
    } else {
      const add = await runGit(ctx.repo.localPath, ['worktree', 'add', '--force', '--detach', worktreePath, gitSha], exec);
      if (add.code !== 0) {
        return { kind: 'fatal', detail: firstInterestingLine(add.stderr || add.stdout) || `git worktree add failed for ${gitSha}` };
      }
    }

    const appliedSha = await revParse(worktreePath, 'HEAD', exec);
    ctx.appliedGitSha = appliedSha;
    ctx.appliedArtifactPath = worktreePath;
    return { kind: 'ok', detail: `applied ${appliedSha}` };
  } catch (error) {
    return { kind: 'fatal', detail: toMessage(error) };
  }
}

export async function deployToStaging(ctx: RunContext, deps: StageDeps = {}): Promise<StageOutcome> {
  const railway = ensureRailway(ctx, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleeper = deps.sleep ?? sleep;
  const worktree = ctx.appliedArtifactPath;
  if (!worktree) {
    return { kind: 'fatal', detail: 'apply stage did not produce a worktree' };
  }

  try {
    const environments = await railway.environmentList(worktree);
    if (!environments.includes(ctx.repo.stagingEnv)) {
      return {
        kind: 'fatal',
        detail: `staging env missing — see PIPELINE-STAGING.md, create via railway environment new`,
      };
    }

    const up = await railway.up(worktree, ctx.repo.stagingEnv);
    if (!up.ok) {
      return {
        kind: transportLike(up.detail) ? 'transient' : 'fatal',
        detail: up.detail || 'railway up failed',
      };
    }

    let stagingUrl: string | undefined;
    try {
      stagingUrl = extractStagingUrl(await railway.statusJson(worktree, ctx.repo.stagingEnv));
    } catch {
      stagingUrl = undefined;
    }
    if (!stagingUrl) {
      await railway.domain(worktree, ctx.repo.stagingEnv);
      try {
        stagingUrl = extractStagingUrl(await railway.statusJson(worktree, ctx.repo.stagingEnv));
      } catch {
        stagingUrl = undefined;
      }
    }
    if (!stagingUrl) {
      return { kind: 'transient', detail: 'staging URL not available yet' };
    }

    const healthUrl = appendUrl(stagingUrl, ctx.repo.healthPath);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetchImpl(healthUrl, {
          headers: {
            accept: 'application/json',
          },
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (response.status === 200 && contentType.includes('application/json')) {
          await response.json();
          ctx.stagingUrl = stagingUrl;
          return { kind: 'ok', detail: stagingUrl };
        }
      } catch {
        // Poll exhaustion classifies the run.
      }
      await sleeper(10_000);
    }

    return { kind: 'transient', detail: `health poll exhausted for ${healthUrl}` };
  } catch (error) {
    const detail = toMessage(error);
    return {
      kind: transportLike(detail) ? 'transient' : 'fatal',
      detail,
    };
  }
}

export async function runMigrateStage(ctx: RunContext, deps: StageDeps = {}): Promise<StageOutcome> {
  if (!ctx.repo.migrateCommand) {
    return { kind: 'ok', detail: 'skipped: no migrateCommand' };
  }
  const railway = ensureRailway(ctx, deps);
  const worktree = ctx.appliedArtifactPath;
  if (!worktree) return { kind: 'fatal', detail: 'apply stage did not produce a worktree' };

  try {
    const result = await railway.run(worktree, ctx.repo.stagingEnv, splitCommand(ctx.repo.migrateCommand));
    if (result.code !== 0) {
      return {
        kind: 'fatal',
        detail: firstInterestingLine(result.stderr || result.stdout) || `migrate failed with exit ${result.code}`,
      };
    }
    return { kind: 'ok' };
  } catch (error) {
    return { kind: 'fatal', detail: toMessage(error) };
  }
}

export async function runSeedStage(ctx: RunContext, deps: StageDeps = {}): Promise<StageOutcome> {
  if (!ctx.repo.seedCommand) {
    return { kind: 'ok', detail: 'skipped: no seedCommand' };
  }
  if (/(prod|production|dump|restore)/i.test(ctx.repo.seedCommand)) {
    return { kind: 'fatal', detail: 'seed command is not synthetic-fixture safe' };
  }
  const railway = ensureRailway(ctx, deps);
  const worktree = ctx.appliedArtifactPath;
  if (!worktree) return { kind: 'fatal', detail: 'apply stage did not produce a worktree' };

  try {
    const result = await railway.run(worktree, ctx.repo.stagingEnv, splitCommand(ctx.repo.seedCommand));
    if (result.code !== 0) {
      return {
        kind: 'fatal',
        detail: firstInterestingLine(result.stderr || result.stdout) || `seed failed with exit ${result.code}`,
      };
    }
    return { kind: 'ok' };
  } catch (error) {
    return { kind: 'fatal', detail: toMessage(error) };
  }
}

export async function teardownDeployment(ctx: RunContext, deps: StageDeps = {}): Promise<void> {
  const worktree = ctx.appliedArtifactPath;
  if (!worktree) return;
  const railway = ensureRailway(ctx, deps);
  const exec = deps.exec ?? defaultExec();

  try {
    await railway.serviceDelete(worktree, ctx.repo.stagingEnv);
  } catch {
    // Best effort only.
  }

  try {
    await runGit(ctx.repo.localPath, ['worktree', 'remove', '--force', worktree], exec);
  } catch {
    // Best effort only.
  }
}
