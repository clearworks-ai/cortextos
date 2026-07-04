import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { checkScope } from '../utils/scope-guard.js';
import type { ScopeCheckResult } from '../utils/scope-guard.js';

/**
 * CLI layer for SCOPE_GUARD. Handles the impure parts — reading the declared
 * scope and asking git which files actually changed — then delegates the
 * decision to the pure `checkScope` core.
 *
 * Read-only by contract: this REPORTS drift so it can gate a run (non-zero
 * exit on stray files). It never edits or reverts files.
 */

export interface ScopeGuardOptions {
  /** Inline comma/newline-separated allowlist, e.g. "src/bus/**,tests/**". */
  allow?: string;
  /** Path to a scope file (plain glob list, or a spec with a Targets: field). */
  scopeFile?: string;
  /** Git ref to diff against. When set, diffs <base>...HEAD + working tree. */
  base?: string;
  /** Directory to run git in (repo root). Defaults to process.cwd(). */
  cwd?: string;
}

export interface ScopeGuardReport extends ScopeCheckResult {
  declaredGlobs: string[];
  touchedFiles: string[];
}

/** Split an inline allowlist on commas and newlines. */
function parseInlineGlobs(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a scope file. Two supported shapes:
 *  1. A plain list — one glob per line (blank lines and `#` comments ignored).
 *  2. A markdown spec — extract paths/globs from a `Targets:` or
 *     `Files-Touched:` field (the convention specs use), e.g.
 *       **Targets:** `src/daemon/fast-checker.ts`, `src/types/index.ts`
 *     Backtick-wrapped tokens are preferred; if none, comma-split the value.
 */
export function parseScopeFile(content: string): string[] {
  const fieldMatch = content.match(
    /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Targets|Files[-\s]?Touched)(?:\*\*)?\s*:\s*(.+)$/im,
  );
  if (fieldMatch) {
    const value = fieldMatch[1];
    const backticked = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const tokens = backticked.length > 0
      ? backticked
      : value.split(',').map((s) => s.trim());
    return tokens
      // Drop trailing parentheticals like "(small)" that specs sometimes append.
      .map((t) => t.replace(/\s*\(.*\)\s*$/, '').trim())
      .filter(Boolean);
  }

  // Plain list form.
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** Resolve the declared scope from --allow and/or --scope-file. */
export function resolveDeclaredGlobs(opts: ScopeGuardOptions): string[] {
  const globs: string[] = [];
  if (opts.allow) globs.push(...parseInlineGlobs(opts.allow));
  if (opts.scopeFile) {
    if (!existsSync(opts.scopeFile)) {
      throw new Error(`Scope file not found: ${opts.scopeFile}`);
    }
    globs.push(...parseScopeFile(readFileSync(opts.scopeFile, 'utf-8')));
  }
  return globs;
}

/**
 * Ask git which files a run touched. With `base`, compares the merge-base of
 * <base> and HEAD against the working tree (committed + uncommitted). Without
 * `base`, reports the working-tree diff (staged + unstaged + untracked).
 */
export function collectTouchedFiles(opts: ScopeGuardOptions): string[] {
  const cwd = opts.cwd || process.cwd();
  const run = (args: string[]): string[] => {
    const out = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  };

  const files = new Set<string>();

  if (opts.base) {
    // Committed changes since the base (three-dot = since the merge-base).
    for (const f of run(['diff', '--name-only', `${opts.base}...HEAD`])) files.add(f);
  }
  // Working-tree changes: tracked (staged + unstaged) and untracked.
  for (const f of run(['diff', '--name-only', 'HEAD'])) files.add(f);
  for (const f of run(['ls-files', '--others', '--exclude-standard'])) files.add(f);

  return [...files];
}

/** Run the full guard: resolve scope, collect touched files, check drift. */
export function runScopeGuard(opts: ScopeGuardOptions): ScopeGuardReport {
  const declaredGlobs = resolveDeclaredGlobs(opts);
  const touchedFiles = collectTouchedFiles(opts);
  const result = checkScope({ declaredGlobs, touchedFiles });
  return { ...result, declaredGlobs, touchedFiles };
}
