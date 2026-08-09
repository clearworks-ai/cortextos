import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../src/types/index.js';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

const mockPty = { pid: 7, write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn() };

function newPty(config: AgentConfig) {
  const pty = new AgentPTY(mockEnv, config);
  (pty as unknown as { spawnFn: () => typeof mockPty }).spawnFn = () => mockPty;
  return pty;
}

describe('AgentPTY working_directory validation', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('rejects a whitespace-only working_directory', async () => {
    await expect(newPty({ working_directory: '   ' }).spawn('fresh', 'P'))
      .rejects.toThrow(/whitespace-only/);
  });

  it('rejects a nonexistent working_directory', async () => {
    await expect(newPty({ working_directory: '/no/such/dir' }).spawn('fresh', 'P'))
      .rejects.toThrow(/does not exist/);
  });

  it('does not validate an unset working_directory', async () => {
    const pty = newPty({});
    await expect(pty.spawn('fresh', 'P')).resolves.toBeUndefined();
    pty.kill();
  });

  it('does not reject the empty-string unset sentinel', async () => {
    const pty = newPty({ working_directory: '' });
    await expect(pty.spawn('fresh', 'P')).resolves.toBeUndefined();
    pty.kill();
  });
});

describe('AgentPTY first-run wedge detection', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('flags a bypass prompt still showing at the backstop', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });

  it('never flags once the session has bootstrapped', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('accept edits · permissions');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });

  it('clears the wedge flag on late recovery', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
    pty.getOutputBuffer().push('permissions');
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });
});

describe('AgentPTY broadened auto-accept token match', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('injects Enter for a directory trust-prompt variant', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('Do you trust the files in this directory?');
    await vi.advanceTimersByTimeAsync(1300);
    expect(mockPty.write).toHaveBeenCalledWith('\r');
  });

  it('injects Down for a lowercase bypass prompt variant', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('bypass mode ... 2. Yes, I accept');
    await vi.advanceTimersByTimeAsync(1700);
    expect(mockPty.write).toHaveBeenCalledWith('\x1b[B');
  });

  it('does not inject on benign single-token output', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('please accept the changes and open the directory');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});

describe('AgentPTY no-keystroke-into-live-session invariant', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('writes no keystroke once bootstrapped even if prompt tokens linger', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('Bypass Permissions ... 2. Yes, I accept · permissions');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});
