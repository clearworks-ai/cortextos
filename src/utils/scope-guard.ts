/**
 * SCOPE_GUARD — real-time scope-drift detection for delegated coding runs.
 *
 * A coding run (codex/M2C1 worker) declares up front the files it intends to
 * touch — the spec's "Files-Touched" / "Targets:" scope. This module compares
 * that DECLARED scope against the files a run ACTUALLY touched and flags any
 * "stray" file — one that matches no declared glob. Stray files are the early
 * signal of scope sprawl (the failure mode WS12 exists to prevent: a run that
 * quietly grows into an 80-file conflict bomb before anyone notices).
 *
 * This is PURE logic — no git, no filesystem. The caller supplies the two
 * lists. The CLI wrapper (src/bus/scope-guard.ts) is responsible for reading
 * the declared scope and shelling out to `git diff --name-only`.
 *
 * Matching is intentionally simple, matching how specs declare scope:
 *   - Exact file path:            src/daemon/fast-checker.ts
 *   - Prefix (trailing slash):    src/bus/        (any file under src/bus/)
 *   - Glob with `**`:             src/bus/**      (any file under src/bus/)
 *   - Glob with single `*`:       src/bus/*.ts    (direct children only)
 *   - Directory literal:          src/bus         (treated as a prefix)
 */

export interface ScopeCheckInput {
  /** Declared allowlist — file paths and simple globs from the spec's scope. */
  declaredGlobs: string[];
  /** Files the run actually touched (e.g. from `git diff --name-only`). */
  touchedFiles: string[];
}

export interface ScopeCheckResult {
  /** Touched files that matched no declared glob — scope violations. */
  strayFiles: string[];
  /** True when there are no stray files (run stayed in declared scope). */
  ok: boolean;
}

/**
 * Normalize a path for comparison: trim, strip a leading `./`, and collapse
 * backslashes to forward slashes so Windows-style diffs still match POSIX-style
 * declared globs. Does not resolve `..` — callers pass repo-relative paths.
 */
function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * Convert a single declared scope pattern into a matcher function.
 * Returns null for empty/whitespace patterns so they are ignored.
 */
function compilePattern(rawPattern: string): ((file: string) => boolean) | null {
  const pattern = normalizePath(rawPattern);
  if (!pattern) return null;

  // Prefix form: trailing slash means "anything under this directory".
  if (pattern.endsWith('/')) {
    return (file) => file.startsWith(pattern);
  }

  // Glob form: contains `*`. Translate to a regex.
  if (pattern.includes('*')) {
    const regex = globToRegExp(pattern);
    return (file) => regex.test(file);
  }

  // No glob chars. Match either the exact file, or treat the pattern as a
  // directory prefix so `src/bus` covers `src/bus/message.ts`. Guard the
  // prefix with a `/` so `src/bus` does NOT match `src/business.ts`.
  return (file) => file === pattern || file.startsWith(pattern + '/');
}

/**
 * Translate a simple glob into an anchored RegExp.
 *   `**` matches across path separators (any depth).
 *   `*`  matches within a single path segment (no `/`).
 * All other characters are matched literally.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` — any characters including path separators.
        // Consume a following `/` so `src/**/x` still matches `src/x`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        // Single `*` — anything except a path separator.
        out += '[^/]*';
      }
      continue;
    }
    // Escape regex metacharacters.
    if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp('^' + out + '$');
}

/**
 * Compare touched files against the declared scope. A touched file that
 * matches NO declared glob is "stray".
 *
 * Fail-safe: an empty declared scope means every touched file is stray. A run
 * that declares nothing but touches files has, by definition, drifted.
 */
export function checkScope(input: ScopeCheckInput): ScopeCheckResult {
  const matchers = input.declaredGlobs
    .map(compilePattern)
    .filter((m): m is (file: string) => boolean => m !== null);

  const strayFiles: string[] = [];
  for (const raw of input.touchedFiles) {
    const file = normalizePath(raw);
    if (!file) continue;
    const inScope = matchers.some((match) => match(file));
    if (!inScope) strayFiles.push(file);
  }

  return { strayFiles, ok: strayFiles.length === 0 };
}
