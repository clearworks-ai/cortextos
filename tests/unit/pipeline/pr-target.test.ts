import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  derivePrTarget,
  isProdRepoTarget,
  normalizeHeadBranch,
  parseCdPrefix,
  parseGhFlag,
  slugFallbackCandidate,
  slugFromBranch,
} from '../../../src/pipeline/pr-target';

const repoRoot = process.env.CTX_FRAMEWORK_ROOT || resolve(__dirname, '../../..');

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

describe('pr-target', () => {
  let root: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pr-target-'));
    repoDir = join(root, 'client-checkout');
    mkdirSync(repoDir, { recursive: true });
    runGit(['init'], repoDir);
    runGit(['checkout', '-b', 'feature/hard-spec-gate'], repoDir);
    runGit(['config', 'user.email', 'tests@example.com'], repoDir);
    runGit(['config', 'user.name', 'Pipeline Tests'], repoDir);
    runGit(['commit', '--allow-empty', '-m', 'init'], repoDir);
    runGit(['remote', 'add', 'origin', 'git@github.com:joshweiss/cortextos.git'], repoDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('derives client-repo slug from --head (PRD acceptance)', () => {
    const target = derivePrTarget(
      'gh pr create --repo alloius/JobTread-Automation --base main --head feat/slack-todo-jobtread --title "x"',
      { cwd: repoDir },
    );
    expect(target.slug).toBe('slack-todo-jobtread');
    expect(target.slugSource).toBe('head');
    expect(target.targetRepo).toBe('alloius/JobTread-Automation');
    expect(target.isProdRepo).toBe(false);
    expect(target.error).toBeUndefined();
  });

  it('handles inline and short flag forms', () => {
    expect(
      derivePrTarget('gh pr create --head=feat/x-y --fill', { cwd: repoDir }).slug,
    ).toBe('x-y');
    expect(
      derivePrTarget('gh pr create -H feat/x-y --fill', { cwd: repoDir }).slug,
    ).toBe('x-y');
    expect(
      derivePrTarget('gh pr create -R alloius/JobTread-Automation --head feat/x', { cwd: repoDir })
        .targetRepo,
    ).toBe('alloius/JobTread-Automation');
  });

  it('normalizes fork head form owner:branch', () => {
    expect(normalizeHeadBranch('o:b')).toBe('b');
    expect(normalizeHeadBranch('b')).toBe('b');
    const target = derivePrTarget(
      'gh pr create --head alloius:feat/slack-todo-jobtread --fill',
      { cwd: repoDir },
    );
    expect(target.slug).toBe('slack-todo-jobtread');
  });

  it('strips quoted --head values', () => {
    expect(
      derivePrTarget("gh pr create --head 'feat/slack-todo-jobtread' --fill", { cwd: repoDir })
        .slug,
    ).toBe('slack-todo-jobtread');
    expect(
      derivePrTarget('gh pr create --head "feat/slack-todo-jobtread" --fill', { cwd: repoDir })
        .slug,
    ).toBe('slack-todo-jobtread');
  });

  it('falls back to cwd branch when --head absent', () => {
    const target = derivePrTarget('gh pr create --fill', { cwd: repoDir });
    expect(target.slug).toBe('hard-spec-gate');
    expect(target.slugSource).toBe('branch');
    expect(target.originUrl).toContain('cortextos');
    expect(target.isProdRepo).toBe(false);
    expect(target.error).toBeUndefined();
  });

  it('falls back via cd prefix', () => {
    const target = derivePrTarget(`cd ${repoDir} && gh pr create --fill`, { cwd: root });
    expect(target.slug).toBe('hard-spec-gate');
    expect(target.cdDir).toBe(repoDir);
    expect(target.error).toBeUndefined();
  });

  it('expands tilde in cd prefix', () => {
    expect(parseCdPrefix('cd ~/code/x && gh pr create', '/Users/fake')).toBe(
      '/Users/fake/code/x',
    );
    expect(parseCdPrefix('cd ~ && gh pr create', '/Users/fake')).toBe('/Users/fake');
    expect(parseCdPrefix('gh pr create --fill')).toBeNull();
  });

  it('classifies prod via --repo overriding origin', () => {
    const target = derivePrTarget(
      'gh pr create --repo clearworks-ai/clearpath --head fix/thing',
      { cwd: repoDir },
    );
    expect(target.isProdRepo).toBe(true);
    expect(target.slug).toBe('thing');
  });

  it('classifies prod via origin (regression)', () => {
    runGit(['remote', 'set-url', 'origin', 'git@github.com:clearworks/clearpath.git'], repoDir);
    const target = derivePrTarget('gh pr create --fill', { cwd: repoDir });
    expect(target.isProdRepo).toBe(true);
  });

  it('blocks cross-repo without --head', () => {
    runGit(['remote', 'set-url', 'origin', 'git@github.com:joshweiss/cortextos.git'], repoDir);
    const target = derivePrTarget(
      'gh pr create --repo alloius/JobTread-Automation --base main',
      { cwd: repoDir },
    );
    expect(target.errorCode).toBe('CROSS_REPO_NO_HEAD');
    expect(target.error).toContain('alloius/JobTread-Automation');
  });

  it('allows --repo matching origin without --head', () => {
    const target = derivePrTarget(
      'gh pr create --repo joshweiss/cortextos --fill',
      { cwd: repoDir },
    );
    expect(target.error).toBeUndefined();
    expect(target.slug).toBe('hard-spec-gate');
  });

  it('returns NO_BRANCH when no git and no --head', () => {
    const target = derivePrTarget('gh pr create --fill', { cwd: root });
    expect(target.errorCode).toBe('NO_BRANCH');
    expect(target.slug).toBe('');
  });

  it('slugFromBranch takes last path segment', () => {
    expect(slugFromBranch('feat/slack-todo-jobtread')).toBe('slack-todo-jobtread');
    expect(slugFromBranch('main')).toBe('main');
    expect(slugFromBranch('a/b/c')).toBe('c');
  });

  it('slugFallbackCandidate strips shard/spec suffixes', () => {
    expect(slugFallbackCandidate('task-bus-management-automation-shard2')).toBe(
      'task-bus-management-automation',
    );
    expect(slugFallbackCandidate('foo-shard10')).toBe('foo');
    expect(slugFallbackCandidate('foo-spec02')).toBe('foo');
    expect(slugFallbackCandidate('foo-spec02-03')).toBe('foo');
    expect(slugFallbackCandidate('foo-SHARD2')).toBe('foo');
    expect(slugFallbackCandidate('foo-Spec02-03')).toBe('foo');
  });

  it('slugFallbackCandidate returns null when there is no shard/spec suffix', () => {
    expect(slugFallbackCandidate('slack-todo-jobtread')).toBeNull();
    expect(slugFallbackCandidate('main')).toBeNull();
    expect(slugFallbackCandidate('my-spec-thing')).toBeNull();
    expect(slugFallbackCandidate('shard2')).toBeNull();
    expect(slugFallbackCandidate('spec02')).toBeNull();
    expect(slugFallbackCandidate('foo-shard')).toBeNull();
    expect(slugFallbackCandidate('foo-specimen2')).toBeNull();
  });

  it('isProdRepoTarget matches owned repos only', () => {
    for (const name of ['clearpath', 'cxportal', 'nonprofit-hub', 'auditos', 'gws-security']) {
      expect(isProdRepoTarget(`owner/${name}`)).toBe(true);
      expect(isProdRepoTarget(`git@github.com:owner/${name}.git`)).toBe(true);
    }
    expect(isProdRepoTarget('alloius/JobTread-Automation')).toBe(false);
    expect(isProdRepoTarget('clearworks-ai/doordash-linker')).toBe(false);
    expect(isProdRepoTarget('joshweiss/cortextos')).toBe(false);
  });

  it('CLI smoke via bin/pr-gate-target', () => {
    const result = spawnSync(
      join(repoRoot, 'bin/pr-gate-target'),
      ['--cwd', repoDir],
      {
        input: 'gh pr create --repo alloius/JobTread-Automation --head feat/slack-todo-jobtread',
        encoding: 'utf-8',
      },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      slug: string;
      slug_fallback: string | null;
      slug_source: string;
      is_prod_repo: boolean;
    };
    expect(parsed.slug).toBe('slack-todo-jobtread');
    expect(parsed.slug_source).toBe('head');
    expect(parsed.is_prod_repo).toBe(false);
  });

  it('parseGhFlag extracts long/short/inline values', () => {
    expect(parseGhFlag('gh pr create --head feat/x', 'head', 'H')).toBe('feat/x');
    expect(parseGhFlag('gh pr create --head=feat/x', 'head', 'H')).toBe('feat/x');
    expect(parseGhFlag('gh pr create -H feat/x', 'head', 'H')).toBe('feat/x');
    expect(parseGhFlag('gh pr create --fill', 'head', 'H')).toBeNull();
  });
});
