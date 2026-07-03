/**
 * memory-index.ts — Memory-correctness harness (WS10 / R8).
 *
 * MEMORY.md files are one-line indexes: `- [title](topic_file.md) — summary`.
 * They drift: entries grow past the size budget, point at topic files that
 * were never written, or assert claims with no knowledge-base backing. This
 * module makes those failure modes checkable:
 *
 *   parseMemoryIndex   — extract structured entries from the markdown
 *   lintMemoryIndex    — enforce the size/line/entry-length budget
 *   checkMemoryAgainstKB — flag entries whose claims have zero KB backing,
 *                          via an INJECTED query fn (tests never touch a real KB)
 */

export interface MemoryIndexEntry {
  /** 1-based line number in the source markdown. */
  line: number;
  /** Link text — the entry's title/claim. */
  title: string;
  /** Relative topic file the entry points at, e.g. "feedback_foo.md". */
  topicFile: string;
  /** One-line summary after the em-dash. */
  summary: string;
}

export interface MemoryLintOptions {
  /** Max total size of the markdown in bytes. */
  maxBytes: number;
  /** Max total line count. */
  maxLines: number;
  /** Max characters for a single index entry line. */
  maxEntryChars: number;
}

export interface MemoryLintViolation {
  rule: 'max-bytes' | 'max-lines' | 'max-entry-chars';
  /** 1-based line number for per-entry violations; absent for file-level ones. */
  line?: number;
  message: string;
}

export interface KBQueryResult {
  results: { source_file: string }[];
}

export interface MemoryKBCheckReport {
  /** Entries whose title query returned zero KB results. */
  unbacked: MemoryIndexEntry[];
  /** Entries with at least one KB result backing them. */
  backed: MemoryIndexEntry[];
}

/**
 * One-line index entry: `- [title](topic_file.md) — summary`.
 * Accepts em-dash (—), en-dash (–), or double-hyphen separators; the summary
 * may be empty. Multi-line or non-list content is ignored.
 */
const ENTRY_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:—|–|--)\s*(.*)$/;

/**
 * Extract structured entries from a MEMORY.md-style index.
 */
export function parseMemoryIndex(markdown: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = ENTRY_RE.exec(lines[i]);
    if (match === null) continue;
    entries.push({
      line: i + 1,
      title: match[1].trim(),
      topicFile: match[2].trim(),
      summary: match[3].trim(),
    });
  }
  return entries;
}

/**
 * Enforce the memory-index size budget. Returns [] when clean.
 */
export function lintMemoryIndex(
  markdown: string,
  opts: MemoryLintOptions = { maxBytes: 10240, maxLines: 200, maxEntryChars: 200 }
): MemoryLintViolation[] {
  const violations: MemoryLintViolation[] = [];

  const bytes = Buffer.byteLength(markdown, 'utf-8');
  if (bytes > opts.maxBytes) {
    violations.push({
      rule: 'max-bytes',
      message: `index is ${bytes} bytes (max ${opts.maxBytes})`,
    });
  }

  const lines = markdown.split('\n');
  if (lines.length > opts.maxLines) {
    violations.push({
      rule: 'max-lines',
      message: `index has ${lines.length} lines (max ${opts.maxLines})`,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    if (!ENTRY_RE.test(lines[i])) continue;
    if (lines[i].length > opts.maxEntryChars) {
      violations.push({
        rule: 'max-entry-chars',
        line: i + 1,
        message: `entry on line ${i + 1} is ${lines[i].length} chars (max ${opts.maxEntryChars})`,
      });
    }
  }

  return violations;
}

/**
 * Check every index entry's claim against the knowledge base via the injected
 * query fn. An entry is "backed" when the query for its title returns at least
 * one result; entries with zero results are reported as unbacked.
 *
 * The query fn is injected so this stays a pure correctness harness — tests
 * pass a fake, production passes a real KB adapter.
 */
export function checkMemoryAgainstKB(
  entries: MemoryIndexEntry[],
  kbQueryFn: (q: string) => KBQueryResult
): MemoryKBCheckReport {
  const unbacked: MemoryIndexEntry[] = [];
  const backed: MemoryIndexEntry[] = [];

  for (const entry of entries) {
    const res = kbQueryFn(entry.title);
    if (res.results.length === 0) {
      unbacked.push(entry);
    } else {
      backed.push(entry);
    }
  }

  return { unbacked, backed };
}
