/**
 * memory-lint.ts — Size lint for the shared fleet MEMORY.md index.
 *
 * The shared fleet index (MEMORY.md) is injected into EVERY agent session's
 * context at boot. When it grows unbounded, every over-long index line and
 * every detail paragraph that belongs in a topic file burns context on every
 * session across the whole fleet.
 *
 * This module is a pure, side-effect-free checker: given the raw content of a
 * memory index file, it reports budget violations. The CLI wrapper
 * (`cortextos bus memory-lint`) reads the file, calls `lintMemory`, prints the
 * violations, and exits non-zero when over budget so it can be used as a
 * lint/CI guard against silent regrowth.
 *
 * Two budgets are enforced:
 *   1. Total byte size of the file must not exceed `maxBytes`.
 *   2. No single index line may exceed `maxLineChars` characters.
 *
 * "Index lines" are the meaningful content lines. Fenced code blocks and blank
 * lines are excluded from the per-line check so that legitimately long code or
 * link-reference lines inside a fenced block do not trip the line budget — the
 * intent is to flag over-long human-written index entries, not code.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryLintBudget {
  /** Maximum total file size in bytes. */
  maxBytes: number;
  /** Maximum length (in characters) of any single index line. */
  maxLineChars: number;
}

/** Default budget: ~12KB total, ~200 chars per index line. */
export const DEFAULT_MEMORY_BUDGET: MemoryLintBudget = {
  maxBytes: 12 * 1024,
  maxLineChars: 200,
};

export type MemoryViolationKind = 'total-size' | 'long-line';

export interface MemoryViolation {
  kind: MemoryViolationKind;
  /** 1-based line number for 'long-line' violations; 0 for whole-file violations. */
  line: number;
  /** Human-readable description of the violation. */
  message: string;
  /** Actual measured value (bytes for total-size, chars for long-line). */
  actual: number;
  /** Budget limit that was exceeded. */
  limit: number;
}

export interface MemoryLintResult {
  /** True when there are zero violations. */
  ok: boolean;
  /** Total byte size of the linted content (UTF-8). */
  totalBytes: number;
  /** Count of meaningful (non-blank, non-fence) index lines considered. */
  indexLineCount: number;
  /** Every budget violation found. */
  violations: MemoryViolation[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Lint a memory index file's content against a size budget.
 *
 * Pure: no I/O. `content` is the raw UTF-8 text of the file.
 */
export function lintMemory(
  content: string,
  budget: MemoryLintBudget = DEFAULT_MEMORY_BUDGET,
): MemoryLintResult {
  const violations: MemoryViolation[] = [];

  // ── Total size check ──────────────────────────────────────────────────────
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  if (totalBytes > budget.maxBytes) {
    violations.push({
      kind: 'total-size',
      line: 0,
      message:
        `MEMORY.md is ${formatKb(totalBytes)} (${totalBytes} bytes), ` +
        `over the ${formatKb(budget.maxBytes)} budget. ` +
        `Move detail out of the index into topic files.`,
      actual: totalBytes,
      limit: budget.maxBytes,
    });
  }

  // ── Per-line check ────────────────────────────────────────────────────────
  const lines = content.split('\n');
  let inFence = false;
  let indexLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Toggle fenced-code-block state on ``` markers; skip the fence lines and
    // everything inside them.
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Blank lines are not index entries.
    if (trimmed.length === 0) continue;

    indexLineCount++;

    // Use character length (code points) so multi-byte glyphs count as 1.
    const charLen = [...raw].length;
    if (charLen > budget.maxLineChars) {
      violations.push({
        kind: 'long-line',
        line: i + 1,
        message:
          `Line ${i + 1} is ${charLen} chars, over the ${budget.maxLineChars}-char ` +
          `index-line budget. Shorten to a one-line pointer + hook and relocate ` +
          `the overflow detail into the corresponding topic file.`,
        actual: charLen,
        limit: budget.maxLineChars,
      });
    }
  }

  return {
    ok: violations.length === 0,
    totalBytes,
    indexLineCount,
    violations,
  };
}

/**
 * Render a MemoryLintResult as a human-readable report.
 * Pure — returns the string, does not print.
 */
export function formatLintReport(result: MemoryLintResult): string {
  const out: string[] = [];
  out.push(
    `MEMORY.md size lint: ${formatKb(result.totalBytes)} ` +
      `(${result.totalBytes} bytes), ${result.indexLineCount} index lines`,
  );

  if (result.ok) {
    out.push('OK — within budget.');
    return out.join('\n');
  }

  out.push(`FAIL — ${result.violations.length} violation(s):`);
  for (const v of result.violations) {
    out.push(`  - ${v.message}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}
