/**
 * tests/unit/utils/memory-lint.test.ts
 *
 * Unit tests for the pure MEMORY.md size-lint core.
 * No I/O — all inputs are injected strings.
 *
 * Coverage:
 *  - within-budget file -> ok, zero violations
 *  - over-budget total size -> total-size violation + not ok
 *  - over-long index line -> long-line violation with correct line number
 *  - fenced code blocks + blank lines excluded from per-line check
 *  - multi-byte glyphs counted as single chars
 *  - report formatting reflects pass/fail
 */

import { describe, it, expect } from 'vitest';
import {
  lintMemory,
  formatLintReport,
  DEFAULT_MEMORY_BUDGET,
  type MemoryLintBudget,
} from '../../../src/utils/memory-lint.js';

const TINY: MemoryLintBudget = { maxBytes: 200, maxLineChars: 40 };

describe('lintMemory', () => {
  it('passes a within-budget file with zero violations', () => {
    const content = '# Index\n\n- [Foo](foo.md) — short hook\n- [Bar](bar.md) — another\n';
    const result = lintMemory(content, TINY);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    // 3 meaningful lines (# Index, two bullets); the blank line is excluded.
    expect(result.indexLineCount).toBe(3);
  });

  it('flags an over-budget total size and exits-worthy (not ok)', () => {
    // Build content that exceeds 200 bytes but keeps every line short.
    const line = 'x'.repeat(30) + '\n';
    const content = line.repeat(20); // 620 bytes, each line 30 chars < 40
    const result = lintMemory(content, TINY);
    expect(result.ok).toBe(false);
    const totalViol = result.violations.filter(v => v.kind === 'total-size');
    expect(totalViol).toHaveLength(1);
    expect(totalViol[0].actual).toBe(result.totalBytes);
    expect(totalViol[0].limit).toBe(TINY.maxBytes);
    expect(totalViol[0].line).toBe(0);
    // No long-line violations since each line is under the char budget.
    expect(result.violations.some(v => v.kind === 'long-line')).toBe(false);
  });

  it('flags an over-long index line with the correct 1-based line number', () => {
    const longLine = '- [Big](big.md) — ' + 'y'.repeat(100); // > 40 chars
    const content = `# Index\n${longLine}\n- [Ok](ok.md) — fine\n`;
    const result = lintMemory(content, TINY);
    expect(result.ok).toBe(false);
    const lineViol = result.violations.filter(v => v.kind === 'long-line');
    expect(lineViol).toHaveLength(1);
    expect(lineViol[0].line).toBe(2); // longLine is the 2nd line
    expect(lineViol[0].actual).toBe([...longLine].length);
    expect(lineViol[0].limit).toBe(TINY.maxLineChars);
  });

  it('excludes fenced code blocks and blank lines from the per-line check', () => {
    const codeInner = 'z'.repeat(100); // would violate if counted
    const content = [
      '# Index',
      '',
      '```',
      codeInner,
      '```',
      '- [Short](s.md) — ok',
    ].join('\n');
    const result = lintMemory(content, TINY);
    // The long line lives inside a fence, so no long-line violation.
    expect(result.violations.some(v => v.kind === 'long-line')).toBe(false);
    // Only meaningful non-fence, non-blank lines are counted: '# Index' + bullet.
    expect(result.indexLineCount).toBe(2);
  });

  it('counts multi-byte glyphs as single characters', () => {
    // 30 emoji = 30 code points but 120 bytes. Under 40 char budget, so OK on
    // line length; total bytes still within budget here.
    const emojiLine = '★'.repeat(30);
    const result = lintMemory(emojiLine + '\n', { maxBytes: 10_000, maxLineChars: 40 });
    expect(result.violations.some(v => v.kind === 'long-line')).toBe(false);

    const overLine = '★'.repeat(50); // 50 code points > 40
    const over = lintMemory(overLine + '\n', { maxBytes: 10_000, maxLineChars: 40 });
    const lineViol = over.violations.filter(v => v.kind === 'long-line');
    expect(lineViol).toHaveLength(1);
    expect(lineViol[0].actual).toBe(50);
  });

  it('uses DEFAULT_MEMORY_BUDGET when no budget passed', () => {
    const small = lintMemory('# ok\n');
    expect(small.ok).toBe(true);
    // A 20KB file should trip the ~12KB default byte budget.
    const big = lintMemory('a'.repeat(20 * 1024) + '\n');
    expect(big.ok).toBe(false);
    expect(big.violations.some(v => v.kind === 'total-size')).toBe(true);
    expect(DEFAULT_MEMORY_BUDGET.maxBytes).toBe(12 * 1024);
    expect(DEFAULT_MEMORY_BUDGET.maxLineChars).toBe(200);
  });
});

describe('formatLintReport', () => {
  it('reports OK for a clean result', () => {
    const result = lintMemory('# ok\n', TINY);
    const report = formatLintReport(result);
    expect(report).toContain('OK');
    expect(report).not.toContain('FAIL');
  });

  it('reports FAIL and lists violations for a dirty result', () => {
    const longLine = 'q'.repeat(100);
    const result = lintMemory(`# Index\n${longLine}\n`, TINY);
    const report = formatLintReport(result);
    expect(report).toContain('FAIL');
    expect(report).toContain('violation');
  });
});
