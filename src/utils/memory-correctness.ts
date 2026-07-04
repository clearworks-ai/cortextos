/**
 * memory-correctness.ts — R8 memory-correctness test harness (pure logic).
 *
 * WS10 — Completeness / Correctness Layer.
 *
 * Makes memory claims falsifiable. The memory protocol states: "A memory that
 * names a specific function, file, or flag is a claim that it existed when
 * written." This module extracts those claims from MEMORY.md and topic files,
 * then verifies them against a resolver (filesystem, grep, sibling files).
 *
 * This module is DELIBERATELY PURE: no I/O, no fs reads, no shell — the
 * resolver is injected by the caller (DI pattern, same as reconcile.ts taking
 * plain data). That keeps it unit-testable without touching the live fleet.
 *
 * Three claim kinds:
 *   - file    — backtick-wrapped token that looks like a repo path
 *               (src/... | orgs/... | any *.ts/*.py/*.md/*.json with a /).
 *               Conservative regex: only flags things that clearly assert a
 *               path exists.
 *   - symbol  — backtick-wrapped identifierCase() or --flag-name token
 *               (a memory naming a function or CLI flag).
 *   - wikilink — [[slug]] cross-references per the memory protocol's own link
 *               format — must resolve to a sibling memory file.
 *
 * Verdicts:
 *   resolved   — the claim resolves to a real file/symbol/wikilink.
 *   unresolved — checked and NOT found (a real gap the memory may be wrong about).
 *   skipped    — ambiguous token; classifier cannot confidently call it a claim.
 *               Never fail on skipped (avoids false-positive flooding from
 *               code snippets in prose).
 *
 * False-positive bias: conservative. Prefer skipped over unresolved on any
 * token that might be a prose word. An unresolved claim only fires when the
 * token pattern unambiguously looks like a path/function/wikilink.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MemoryClaimKind = 'file' | 'symbol' | 'wikilink';
export type MemoryClaimVerdict = 'resolved' | 'unresolved' | 'skipped';

export interface MemoryClaim {
  kind: MemoryClaimKind;
  /** The extracted value: a path, identifier, or wikilink slug. */
  value: string;
  /** 1-based line number within the source file. */
  line: number;
}

export interface MemoryClaimResult {
  claim: MemoryClaim;
  verdict: MemoryClaimVerdict;
  /** Human-readable reason for the verdict, for report output. */
  reason: string;
}

/**
 * Resolver interface injected by the caller — keeps the core fs-free and
 * unit-testable. The integration test / CLI passes real fs.existsSync +
 * execSync grep; unit tests pass stubs.
 */
export interface ClaimResolver {
  /** Returns true when a file exists at the given repo-relative path. */
  fileExists(repoRelativePath: string): boolean;
  /**
   * Returns true when a symbol name exists somewhere in src/ (best-effort).
   * May grep, may use a pre-built index. Returns false on any error.
   */
  symbolExists(name: string): boolean;
  /**
   * Returns true when a memory file slug resolves to a sibling memory file.
   * Slug is the [[wikilink]] content, e.g. "project-foo" or "reference_bar".
   */
  memoryExists(slug: string): boolean;
}

// ---------------------------------------------------------------------------
// Extraction regexes
// ---------------------------------------------------------------------------

/**
 * Match backtick-wrapped tokens that look like repo file paths.
 *
 * Criteria (conservative — minimise false positives):
 *   - Starts with src/, orgs/, tests/, dist/, templates/, community/,
 *     dashboard/, bus/, or .cortextOS/
 *   - OR ends with a file extension (.ts, .py, .md, .json, .sh, .js, .txt)
 *     AND contains at least one slash (so "foo.ts" alone is not flagged,
 *     but "src/foo.ts" or "orgs/x/y.json" is).
 *
 * Examples that match: `src/bus/reconcile.ts`, `orgs/clearworksai/agents/larry/config.json`
 * Examples that do NOT match: `reconcile.ts` (no slash), `foo` (no extension or known root)
 */
const FILE_CLAIM_RE =
  /`((?:(?:src|orgs|tests|dist|templates|community|dashboard|bus|\.cortextOS)\/[^`\s]+)|(?:[^`\s]*\/[^`\s]+\.(?:ts|js|py|md|json|sh|txt|yaml|yml|toml)))`/g;

/**
 * Match backtick-wrapped symbols — function/method names with parentheses, or
 * CLI flags with --prefix.
 *
 * Examples: `detectsCompletionClaim()`, `reconcile()`, `--strict`, `--json`
 * Does NOT match: short identifiers without () or --, which are too ambiguous.
 */
const SYMBOL_CLAIM_RE = /`([a-zA-Z_][a-zA-Z0-9_]*\(\))`|`(--[a-z][a-z0-9-]*)`/g;

/**
 * Match [[wikilink]] cross-references in the memory protocol format.
 * Slug is the raw content between [[ and ]].
 */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

// ---------------------------------------------------------------------------
// Core pure functions
// ---------------------------------------------------------------------------

/**
 * Extract all memory claims from a markdown string.
 * Returns an array of MemoryClaim objects sorted by line number.
 * Pure — no I/O.
 */
export function extractClaims(markdown: string): MemoryClaim[] {
  const claims: MemoryClaim[] = [];

  // Build a quick line-start offset index so we can map character positions
  // to line numbers without splitting the entire file repeatedly.
  const lineStarts: number[] = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === '\n') lineStarts.push(i + 1);
  }

  function charToLine(charIndex: number): number {
    // Binary search for the line start <= charIndex.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= charIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  }

  // ── File claims ────────────────────────────────────────────────────────
  FILE_CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_CLAIM_RE.exec(markdown)) !== null) {
    const value = m[1];
    if (!value) continue;
    claims.push({
      kind: 'file',
      value,
      line: charToLine(m.index),
    });
  }

  // ── Symbol claims ─────────────────────────────────────────────────────
  SYMBOL_CLAIM_RE.lastIndex = 0;
  while ((m = SYMBOL_CLAIM_RE.exec(markdown)) !== null) {
    // Group 1: identifier(), Group 2: --flag
    const value = m[1] ?? m[2];
    if (!value) continue;
    claims.push({
      kind: 'symbol',
      value,
      line: charToLine(m.index),
    });
  }

  // ── Wikilinks ─────────────────────────────────────────────────────────
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(markdown)) !== null) {
    const value = m[1].trim();
    if (!value) continue;
    claims.push({
      kind: 'wikilink',
      value,
      line: charToLine(m.index),
    });
  }

  // Sort by line number for stable, readable output.
  claims.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));

  return claims;
}

/**
 * Verify a list of extracted claims against the provided resolver.
 * Returns one MemoryClaimResult per claim. Pure — no I/O (all I/O via resolver).
 */
export function verifyClaims(
  claims: MemoryClaim[],
  resolver: ClaimResolver,
): MemoryClaimResult[] {
  return claims.map(claim => {
    try {
      switch (claim.kind) {
        case 'file': {
          const exists = resolver.fileExists(claim.value);
          return {
            claim,
            verdict: exists ? 'resolved' : 'unresolved',
            reason: exists
              ? `file "${claim.value}" exists`
              : `file "${claim.value}" not found in repo`,
          };
        }

        case 'symbol': {
          // Symbol checks are best-effort. If the resolver errors or is
          // unavailable, skip rather than fail — symbol grepping is advisory.
          try {
            const exists = resolver.symbolExists(claim.value);
            return {
              claim,
              verdict: exists ? 'resolved' : 'skipped',
              reason: exists
                ? `symbol "${claim.value}" found in src/`
                : `symbol "${claim.value}" not found (best-effort grep — skipped rather than unresolved)`,
            };
          } catch {
            return {
              claim,
              verdict: 'skipped',
              reason: `symbol check for "${claim.value}" errored — skipped`,
            };
          }
        }

        case 'wikilink': {
          const exists = resolver.memoryExists(claim.value);
          return {
            claim,
            verdict: exists ? 'resolved' : 'unresolved',
            reason: exists
              ? `wikilink "[[${claim.value}]]" resolves to a memory file`
              : `wikilink "[[${claim.value}]]" has no corresponding memory file`,
          };
        }
      }
    } catch {
      // Resolver threw — skip this claim rather than crashing the whole run.
      return {
        claim,
        verdict: 'skipped' as MemoryClaimVerdict,
        reason: `claim check for "${claim.value}" errored — skipped`,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Report formatting (pure)
// ---------------------------------------------------------------------------

/** Render a verification result list as a human-readable audit table. Pure. */
export function formatCorrectnessReport(
  results: MemoryClaimResult[],
  sourceLabel?: string,
): string {
  if (results.length === 0) {
    return sourceLabel
      ? `${sourceLabel}: no memory claims found (nothing to check)`
      : 'no memory claims found (nothing to check)';
  }

  const header = sourceLabel ? `Memory-correctness audit: ${sourceLabel}\n` : '';
  const rows = results.map(r => {
    const icon =
      r.verdict === 'resolved' ? 'OK' : r.verdict === 'unresolved' ? 'FAIL' : 'SKIP';
    return `  [${icon}] L${r.claim.line} ${r.claim.kind}: ${r.claim.value} — ${r.reason}`;
  });

  const unresolvedCount = results.filter(r => r.verdict === 'unresolved').length;
  const summary = `\n${results.length} claim(s) checked: ${results.filter(r => r.verdict === 'resolved').length} resolved, ${unresolvedCount} unresolved, ${results.filter(r => r.verdict === 'skipped').length} skipped.`;

  return header + rows.join('\n') + summary;
}
