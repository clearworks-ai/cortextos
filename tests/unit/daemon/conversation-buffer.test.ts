import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationBufferEntry } from '../../../src/types/index.js';

const mockPty = {
  spawn: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mockPty; },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test/state/alice' }),
}));

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('../../../src/bus/system.js', () => ({
  hardRestart: vi.fn(),
}));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const { loadBuffer, toDigestLine } = await import('../../../src/daemon/conversation-buffer.js');

function makeEntry(index: number, content = `message-${index}`): ConversationBufferEntry {
  return {
    ts: new Date(Date.UTC(2026, 6, 29, 8, index, 0)).toISOString(),
    sender: index % 2 === 0 ? 'pd88' : 'alice',
    via: 'telegram',
    content,
  };
}

function writeBufferFile(ctxRoot: string, agentName: string, entries: ConversationBufferEntry[]): string {
  const dir = join(ctxRoot, 'state', agentName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'conversation-buffer.jsonl');
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  return path;
}

function buildEnv(rootDir: string) {
  const frameworkRoot = join(rootDir, 'framework');
  const ctxRoot = join(rootDir, 'ctx');
  const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
  mkdirSync(agentDir, { recursive: true });
  return {
    env: {
      instanceId: 'test-instance',
      ctxRoot,
      frameworkRoot,
      agentName: 'alice',
      agentDir,
      org: 'acme',
      projectRoot: frameworkRoot,
    },
    ctxRoot,
    agentDir,
  };
}

describe('conversation-buffer selective reinsertion', () => {
  let tempDir: string;

  afterEach(() => {
    vi.clearAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns all entries verbatim and no digest when the buffer has five or fewer entries', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'conversation-buffer-test-'));
    const { ctxRoot } = buildEnv(tempDir);
    const entries = Array.from({ length: 5 }, (_, index) => makeEntry(index));
    writeBufferFile(ctxRoot, 'alice', entries);

    const loaded = loadBuffer(ctxRoot, 'alice');

    expect(Array.from(loaded)).toEqual(entries);
    expect(loaded.verbatim).toEqual(entries);
    expect(loaded.digest).toEqual([]);
  });

  it('returns the last five entries verbatim and digests the older remainder in chronological order', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'conversation-buffer-test-'));
    const { ctxRoot } = buildEnv(tempDir);
    const entries = Array.from({ length: 20 }, (_, index) => makeEntry(index));
    writeBufferFile(ctxRoot, 'alice', entries);

    const loaded = loadBuffer(ctxRoot, 'alice');

    expect(Array.from(loaded)).toEqual(entries);
    expect(loaded.verbatim).toEqual(entries.slice(15));
    expect(loaded.digest).toEqual(entries.slice(0, 15).map(toDigestLine));
    expect(loaded.digest).toHaveLength(15);
  });

  it('toDigestLine truncates long content at 120 chars and leaves short content untouched', () => {
    const longEntry: ConversationBufferEntry = {
      ts: '2026-07-29T08:00:00.000Z',
      sender: 'alice',
      via: 'telegram',
      content: 'x'.repeat(300),
    };
    const shortEntry: ConversationBufferEntry = {
      ts: '2026-07-29T08:01:00.000Z',
      sender: 'pd88',
      via: 'telegram',
      content: 'y'.repeat(50),
    };

    expect(toDigestLine(longEntry)).toBe(
      `alice (2026-07-29T08:00:00.000Z): ${'x'.repeat(120)}…`,
    );
    expect(toDigestLine(shortEntry)).toBe(
      `pd88 (2026-07-29T08:01:00.000Z): ${'y'.repeat(50)}`,
    );
  });

  it('omits the compressed block from the startup prompt when no digest entries exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'conversation-buffer-test-'));
    const { ctxRoot, env } = buildEnv(tempDir);
    const entries = Array.from({ length: 5 }, (_, index) => makeEntry(index, `recent-${index}`));
    writeBufferFile(ctxRoot, 'alice', entries);

    const ap = new AgentProcess('alice', env, {});
    const prompt = (
      ap as unknown as { buildStartupPrompt: () => string }
    ).buildStartupPrompt();

    expect(prompt).toContain('VERBATIM LIVE TAIL');
    expect(prompt).not.toContain('EARLIER TURNS (compressed):');
    expect(prompt).toContain(`${entries[4].ts} ${entries[4].sender}: recent-4`);
  });

  it('includes the compressed block before the verbatim tail on the continue prompt when older entries exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'conversation-buffer-test-'));
    const { ctxRoot, env } = buildEnv(tempDir);
    const entries = Array.from({ length: 6 }, (_, index) => makeEntry(index, `turn-${index}`));
    writeBufferFile(ctxRoot, 'alice', entries);

    const ap = new AgentProcess('alice', env, {});
    const prompt = (
      ap as unknown as { buildContinuePrompt: () => string }
    ).buildContinuePrompt();

    const digestIndex = prompt.indexOf('EARLIER TURNS (compressed):');
    const liveTailIndex = prompt.indexOf('VERBATIM LIVE TAIL');

    expect(digestIndex).toBeGreaterThan(-1);
    expect(liveTailIndex).toBeGreaterThan(-1);
    expect(digestIndex).toBeLessThan(liveTailIndex);
    expect(prompt).toContain(toDigestLine(entries[0]));
    expect(prompt).toContain(`${entries[5].ts} ${entries[5].sender}: turn-5`);
  });
});
