import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendHandoffTail, collectOpenLoops } from '../../../src/daemon/handoff-tail.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'handoff-tail-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('appendHandoffTail', () => {
  it('appends the daemon session-tail section verbatim to the doc', () => {
    const docPath = join(tmpRoot, 'handoff.md');
    writeFileSync(docPath, '# Handoff\n\nbody text', 'utf-8');

    const ok = appendHandoffTail({
      docPath,
      bufferTail: 'last live output line',
      openLoops: ['msg-001.json: fix the form blocker', 'msg-002.json: reply to Josh'],
    });

    expect(ok).toBe(true);
    const content = readFileSync(docPath, 'utf-8');
    // Original body untouched, section appended after it.
    expect(content.startsWith('# Handoff\n\nbody text')).toBe(true);
    expect(content).toContain(
      '\n\n## Daemon-appended session tail (automatic — written at restart, independent of the agent)\n' +
      '### Last live output before restart\n' +
      '```\n' +
      'last live output line' +
      '\n```\n' +
      '### Open loops (unconsumed inbox items at restart)\n' +
      '- msg-001.json: fix the form blocker\n' +
      '- msg-002.json: reply to Josh' +
      '\n### Rule\n' +
      'Any correction/instruction visible in the tail above that is not reflected in the handoff body is UNRESOLVED — action it first.\n',
    );
  });

  it('renders "(none)" when there are no open loops', () => {
    const docPath = join(tmpRoot, 'handoff.md');
    writeFileSync(docPath, 'body', 'utf-8');

    expect(appendHandoffTail({ docPath, bufferTail: 'tail', openLoops: [] })).toBe(true);
    expect(readFileSync(docPath, 'utf-8')).toContain(
      '### Open loops (unconsumed inbox items at restart)\n- (none)\n### Rule\n',
    );
  });

  it('returns false and does not throw when the doc is missing', () => {
    const logs: string[] = [];
    const ok = appendHandoffTail({
      docPath: join(tmpRoot, 'does-not-exist.md'),
      bufferTail: 'tail',
      openLoops: [],
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('returns false and does not throw when docPath is empty', () => {
    expect(appendHandoffTail({ docPath: '', bufferTail: 'tail', openLoops: [] })).toBe(false);
  });

  it('returns false and leaves the doc untouched when the buffer tail is empty', () => {
    const docPath = join(tmpRoot, 'handoff.md');
    writeFileSync(docPath, 'body', 'utf-8');

    expect(appendHandoffTail({ docPath, bufferTail: '', openLoops: ['x'] })).toBe(false);
    // ANSI-only / whitespace-only tails count as empty too.
    expect(appendHandoffTail({ docPath, bufferTail: '\x1b[2J\x1b[0m  \n', openLoops: ['x'] })).toBe(false);
    expect(readFileSync(docPath, 'utf-8')).toBe('body');
  });

  it('returns false and does not throw when the doc is unwritable', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores perms
    const docPath = join(tmpRoot, 'readonly.md');
    writeFileSync(docPath, 'body', 'utf-8');
    chmodSync(docPath, 0o444);
    try {
      const logs: string[] = [];
      const ok = appendHandoffTail({ docPath, bufferTail: 'tail', openLoops: [], log: (m) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      chmodSync(docPath, 0o644);
    }
  });

  it('strips ANSI escape sequences from the buffer tail', () => {
    const docPath = join(tmpRoot, 'handoff.md');
    writeFileSync(docPath, 'body', 'utf-8');

    const ok = appendHandoffTail({
      docPath,
      bufferTail: '\x1b[31mred text\x1b[0m and \x1b[1;32mgreen\x1b[0m',
      openLoops: [],
    });

    expect(ok).toBe(true);
    const content = readFileSync(docPath, 'utf-8');
    expect(content).toContain('red text and green');
    expect(content).not.toContain('\x1b');
  });

  it('caps the tail at 16KB keeping the END of the buffer', () => {
    const docPath = join(tmpRoot, 'handoff.md');
    writeFileSync(docPath, 'body', 'utf-8');

    const head = 'HEAD-MARKER-';
    const filler = 'A'.repeat(20_000);
    const end = '-END-MARKER';
    const ok = appendHandoffTail({ docPath, bufferTail: head + filler + end, openLoops: [] });

    expect(ok).toBe(true);
    const content = readFileSync(docPath, 'utf-8');
    // The most recent output (end of buffer) survives; the oldest is dropped.
    expect(content).toContain('-END-MARKER');
    expect(content).not.toContain('HEAD-MARKER-');
    const fenced = content.match(/```\n([\s\S]*?)\n```/);
    expect(fenced).not.toBeNull();
    expect(fenced![1].length).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('collectOpenLoops', () => {
  it('lists inbox files as "basename: first-120-chars" and skips unreadable entries', () => {
    const inbox = join(tmpRoot, 'inbox', 'alice');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'msg-b.json'), '{"body":"reply to Josh about the invoice"}', 'utf-8');
    const longBody = 'x'.repeat(500);
    writeFileSync(join(inbox, 'msg-a.json'), longBody, 'utf-8');
    // Dangling symlink = unreadable entry → must be skipped, not fatal.
    symlinkSync(join(tmpRoot, 'gone'), join(inbox, 'msg-broken.json'));
    // Sub-directory entries are not messages → skipped.
    mkdirSync(join(inbox, 'not-a-message'));

    const loops = collectOpenLoops(tmpRoot, 'alice');

    expect(loops).toHaveLength(2);
    expect(loops[0]).toBe(`msg-a.json: ${'x'.repeat(120)}`);
    expect(loops[1]).toBe('msg-b.json: {"body":"reply to Josh about the invoice"}');
  });

  it('returns [] for a missing inbox dir and never throws', () => {
    expect(collectOpenLoops(tmpRoot, 'nobody')).toEqual([]);
  });
});
