import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

export const PROD_REPO_PATTERN = /clearpath|cxportal|nonprofit-hub|auditos|gws-security/;

export type SlugSource = 'head' | 'branch';

export interface PrTarget {
  slug: string;
  slugFallback: string | null;
  headBranch: string;
  slugSource: SlugSource;
  targetRepo: string | null;
  originUrl: string | null;
  isProdRepo: boolean;
  cdDir: string | null;
  error?: string;
  errorCode?: 'NO_BRANCH' | 'NO_SLUG' | 'CROSS_REPO_NO_HEAD' | 'BAD_CD_DIR';
}

export interface DeriveOptions {
  cwd: string;
  home?: string;
}

export function parseCdPrefix(command: string, home?: string): string | null {
  const match = command.match(/^\s*cd\s+([^\s;&|]+)/);
  if (!match) return null;
  const dir = match[1];
  const homeDir = home ?? homedir();
  if (dir === '~') return homeDir;
  if (dir.startsWith('~/')) return `${homeDir}/${dir.slice(2)}`;
  return dir;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseGhFlag(
  command: string,
  longName: string,
  shortName?: string,
): string | null {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const longEq = `--${longName}=`;
    if (token.startsWith(longEq)) {
      return stripQuotes(token.slice(longEq.length));
    }
    if (token === `--${longName}`) {
      const next = tokens[i + 1];
      if (!next || next.startsWith('-')) return null;
      return stripQuotes(next);
    }
    if (shortName && token === `-${shortName}`) {
      const next = tokens[i + 1];
      if (!next || next.startsWith('-')) return null;
      return stripQuotes(next);
    }
  }
  return null;
}

export function slugFromBranch(branch: string): string {
  return branch.replace(/^.*\//, '');
}

/**
 * Strip a trailing `-shard<N>` or `-spec<N>[-<M>]` suffix (case-insensitive) to
 * recover the shared base slug under which the pipeline ledger records rows.
 * Shard/spec branches derive a per-branch slug via slugFromBranch that never
 * matches the ledger; this is the fallback the PR gate retries against.
 * Returns null when there is no such suffix or stripping would leave an empty string.
 */
export function slugFallbackCandidate(slug: string): string | null {
  const match = slug.match(/-(?:shard\d+|spec\d+(?:-\d+)?)$/i);
  if (!match || match.index === undefined) return null;
  const stripped = slug.slice(0, match.index);
  return stripped.length > 0 ? stripped : null;
}

export function normalizeHeadBranch(head: string): string {
  const idx = head.indexOf(':');
  if (idx === -1) return head;
  return head.slice(idx + 1);
}

export function isProdRepoTarget(target: string): boolean {
  return PROD_REPO_PATTERN.test(target);
}

function git(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) return null;
  const out = (result.stdout || '').trim();
  return out.length > 0 ? out : null;
}

function repoNameSegment(ownerName: string): string {
  const parts = ownerName.split('/');
  const last = parts[parts.length - 1] || ownerName;
  return last.replace(/\.git$/i, '');
}

function originMatchesTargetRepo(originUrl: string | null, targetRepo: string): boolean {
  if (!originUrl) return false;
  const name = repoNameSegment(targetRepo).toLowerCase();
  const origin = originUrl.toLowerCase().replace(/\.git$/i, '');
  return origin.includes(name);
}

function emptyTarget(
  partial: Partial<PrTarget> & {
    error: string;
    errorCode: NonNullable<PrTarget['errorCode']>;
  },
): PrTarget {
  return {
    slug: '',
    slugFallback: null,
    headBranch: '',
    slugSource: 'branch',
    targetRepo: null,
    originUrl: null,
    isProdRepo: false,
    cdDir: null,
    ...partial,
  };
}

export function derivePrTarget(command: string, opts: DeriveOptions): PrTarget {
  let cdDir = parseCdPrefix(command, opts.home);
  if (cdDir != null) {
    try {
      if (!(existsSync(cdDir) && statSync(cdDir).isDirectory())) {
        cdDir = null;
      }
    } catch {
      cdDir = null;
    }
  }

  const gitCwd = cdDir ?? resolve(opts.cwd);
  const targetRepo = parseGhFlag(command, 'repo', 'R');
  const headFlag = parseGhFlag(command, 'head', 'H');
  const originUrl = git(['remote', 'get-url', 'origin'], gitCwd);

  let headBranch = '';
  let slugSource: SlugSource = 'branch';

  if (headFlag) {
    headBranch = normalizeHeadBranch(headFlag);
    slugSource = 'head';
  } else {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], gitCwd);
    if (!branch) {
      return emptyTarget({
        targetRepo,
        originUrl,
        cdDir,
        isProdRepo: isProdRepoTarget(targetRepo ?? originUrl ?? ''),
        errorCode: 'NO_BRANCH',
        error:
          'could not determine the current branch for PR gate verification (no --head flag and git lookup failed)',
      });
    }
    headBranch = branch;
    slugSource = 'branch';

    if (targetRepo && !originMatchesTargetRepo(originUrl, targetRepo)) {
      return emptyTarget({
        headBranch,
        slugSource,
        targetRepo,
        originUrl,
        cdDir,
        isProdRepo: isProdRepoTarget(targetRepo),
        errorCode: 'CROSS_REPO_NO_HEAD',
        error:
          `gh pr create targets '${targetRepo}' but the local checkout origin is '${originUrl ?? 'none'}'; ` +
          "cannot derive a provenance slug from the local branch. Re-run with an explicit --head <branch> (or a leading 'cd <repo> && ...').",
      });
    }
  }

  const slug = slugFromBranch(headBranch);
  if (!slug) {
    return emptyTarget({
      headBranch,
      slugSource,
      targetRepo,
      originUrl,
      cdDir,
      isProdRepo: isProdRepoTarget(targetRepo ?? originUrl ?? ''),
      errorCode: 'NO_SLUG',
      error: `could not derive slug from branch '${headBranch}'`,
    });
  }

  const slugFallback = slugFallbackCandidate(slug);
  const isProdRepo = isProdRepoTarget(targetRepo ?? originUrl ?? '');
  return {
    slug,
    slugFallback,
    headBranch,
    slugSource,
    targetRepo,
    originUrl,
    isProdRepo,
    cdDir,
  };
}

function toWire(target: PrTarget): Record<string, unknown> {
  return {
    slug: target.slug,
    slug_fallback: target.slugFallback,
    head_branch: target.headBranch,
    slug_source: target.slugSource,
    target_repo: target.targetRepo,
    origin_url: target.originUrl,
    is_prod_repo: target.isProdRepo,
    cd_dir: target.cdDir,
    error: target.error ?? null,
    error_code: target.errorCode ?? null,
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cwd' && argv[i + 1]) {
      cwd = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwd = token.slice('--cwd='.length);
    }
  }

  if (!cwd) {
    process.stdout.write(
      `${JSON.stringify({ error: 'Missing required --cwd', error_code: 'USAGE' })}\n`,
    );
    process.exit(5);
  }

  const command = readFileSync(0, 'utf-8');
  const target = derivePrTarget(command, { cwd });
  process.stdout.write(`${JSON.stringify(toWire(target))}\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}
