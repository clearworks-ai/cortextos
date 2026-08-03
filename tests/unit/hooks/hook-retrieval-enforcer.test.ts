import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  buildAdditionalContext,
  buildOutputEnvelope,
  cachePathFor,
  readCache,
  sha256Hex,
} from '../../../src/hooks/hook-retrieval-enforcer.js';

const originalHome = process.env.HOME;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalOrg = process.env.CTX_ORG;

let tempHome: string;
let agentName: string;
let commitLogText: string;
let kbResultText: string;

function promptEnvelope(prompt: string, sessionId?: string): string {
  return JSON.stringify({ prompt, session_id: sessionId });
}

function formattedCommits(): string {
  return `repo fleet-repo (git log --all, last 48h, incl. unmerged branches):\n${commitLogText}`;
}

function writeTranscript(fileName: string, lines: string[]): string {
  const dir = join(tempHome, '.claude', 'projects', `${agentName}-project`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function transcriptLine(role: 'user' | 'assistant', text: string, ts: string): string {
  return JSON.stringify({
    timestamp: ts,
    message: {
      role,
      content: text,
    },
  });
}

function writeCacheForSession(sessionId: string, state: object): string {
  const filePath = cachePathFor(agentName, sessionId);
  mkdirSync(join(tmpdir(), 'cortextos-retrieval-cache', agentName), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state), 'utf8');
  return filePath;
}

function kbQueryCalls(): string[][] {
  return mockExecFileSync.mock.calls
    .filter(([file, args]) => file === 'cortextos' && Array.isArray(args) && args[1] === 'kb-query')
    .map(([, args]) => (args as string[]));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'hook-retrieval-enforcer-'));
  agentName = 'codexer';
  commitLogText = 'abc123 07-26 01:00 feat: tighten retrieval cache';
  kbResultText = 'KB hit line one';

  process.env.HOME = tempHome;
  process.env.CTX_AGENT_NAME = agentName;
  process.env.CTX_ORG = 'clearworksai';

  mockExecFileSync.mockReset();
  mockExecFileSync.mockImplementation((file: unknown, args: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (file === 'git' && argv[0] === 'rev-parse') {
      return `${join(tempHome, 'fleet-repo')}\n`;
    }
    if (file === 'git' && argv.includes('log')) {
      return `${commitLogText}\n`;
    }
    if (file === 'cortextos' && argv[1] === 'kb-query') {
      return `${kbResultText}\n`;
    }
    throw new Error(`Unexpected command: ${String(file)} ${argv.join(' ')}`);
  });

  writeTranscript('session.jsonl', [
    transcriptLine('user', 'Please remember the meeting-evt-123 status and the retrieval cache fix we just discussed in detail.', '2026-07-26T01:00:00.000Z'),
    transcriptLine('assistant', 'I confirmed the meeting-evt-123 status and summarized the retrieval cache fix with exact file references.', '2026-07-26T01:01:00.000Z'),
  ]);
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalAgentName === undefined) {
    delete process.env.CTX_AGENT_NAME;
  } else {
    process.env.CTX_AGENT_NAME = originalAgentName;
  }
  if (originalOrg === undefined) {
    delete process.env.CTX_ORG;
  } else {
    process.env.CTX_ORG = originalOrg;
  }

  rmSync(tempHome, { recursive: true, force: true });
  rmSync(join(tmpdir(), 'cortextos-retrieval-cache', agentName), { recursive: true, force: true });
});

describe('hook-retrieval-enforcer', () => {
  it('cron-fire short-circuit unchanged', () => {
    writeCacheForSession('cron-session', { turnCount: 99, lastCommitsHash: 'keep-me' });

    const output = buildAdditionalContext(
      promptEnvelope('[CRON FIRED 2026-07-26T01:44:15.699Z] heartbeat: do work', 'cron-session'),
      { agentName, org: 'clearworksai' },
    );

    expect(output).toBe('');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(readCache(cachePathFor(agentName, 'cron-session'))).toEqual({
      turnCount: 99,
      lastCommitsHash: 'keep-me',
    });
  });

  it('session continuation short-circuit unchanged', () => {
    writeCacheForSession('continue-session', {
      turnCount: 99,
      lastCommitsHash: 'keep-me',
      lastKbQueryNormalized: 'existing normalized query',
      lastKbResultHash: 'existing-result-hash',
      lastKbResultAtMs: 1234,
    });

    const output = buildAdditionalContext(
      promptEnvelope(
        'SESSION CONTINUATION: Your CLI process was restarted while this session was still active. Continue from the prior context, preserve the current task state, and do not treat this as a new session. Resume the interrupted work exactly where it left off and recover any in-flight reasoning or pending implementation details before answering.',
        'continue-session',
      ),
      { agentName, org: 'clearworksai' },
    );

    expect(output).toBe('');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(readCache(cachePathFor(agentName, 'continue-session'))).toEqual({
      turnCount: 99,
      lastCommitsHash: 'keep-me',
      lastKbQueryNormalized: 'existing normalized query',
      lastKbResultHash: 'existing-result-hash',
      lastKbResultAtMs: 1234,
    });
  });

  it('empty or short prompts short-circuit unchanged', () => {
    const output = buildAdditionalContext(promptEnvelope('ok', 'short-session'), {
      agentName,
      org: 'clearworksai',
    });

    expect(output).toBe('');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('first turn always includes direction and commits when non-empty', () => {
    const output = buildAdditionalContext(promptEnvelope('ok continue', 'first-turn'), {
      agentName,
      org: 'clearworksai',
    });

    expect(output).toContain('## Recent commits');
    expect(output).toContain(formattedCommits());
    expect(output).toContain('## Conversation direction');
  });

  it('repeat turn with identical commits hash omits the Recent commits section', () => {
    writeCacheForSession('repeat-identical', {
      turnCount: 1,
      lastCommitsHash: sha256Hex(formattedCommits()),
    });

    const output = buildAdditionalContext(
      promptEnvelope('check meeting-evt-123 status right now', 'repeat-identical'),
      { agentName, org: 'clearworksai' },
    );

    expect(output).not.toContain('## Recent commits');
    expect(output).toContain('## MMRAG');
    expect(output).toContain('## Transcript excerpts');
  });

  it('repeat turn with changed commits re-includes the section and updates the cache', () => {
    const cacheFile = writeCacheForSession('repeat-changed', {
      turnCount: 2,
      lastCommitsHash: sha256Hex('old commits'),
    });

    const output = buildAdditionalContext(promptEnvelope('carry on please', 'repeat-changed'), {
      agentName,
      org: 'clearworksai',
      nowMs: 1234,
    });

    expect(output).toContain('## Recent commits');
    const cache = readCache(cacheFile);
    expect(cache.turnCount).toBe(3);
    expect(cache.lastCommitsHash).toBe(sha256Hex(formattedCommits()));
  });

  it('repeat turn without retrieval intent or urgency omits Conversation direction', () => {
    writeCacheForSession('repeat-no-direction', {
      turnCount: 2,
      lastCommitsHash: sha256Hex('different commits'),
    });

    const output = buildAdditionalContext(promptEnvelope('carry on please', 'repeat-no-direction'), {
      agentName,
      org: 'clearworksai',
    });

    expect(output).toContain('## Recent commits');
    expect(output).not.toContain('## Conversation direction');
  });

  it('retrieval intent on a repeat turn re-includes direction', () => {
    writeCacheForSession('repeat-intent', {
      turnCount: 4,
      lastCommitsHash: sha256Hex(formattedCommits()),
    });

    const output = buildAdditionalContext(
      promptEnvelope('what did we discuss earlier about the retrieval cache?', 'repeat-intent'),
      { agentName, org: 'clearworksai' },
    );

    expect(output).toContain('## Conversation direction');
  });

  it('urgent prompts force both commits and direction open on repeat turns', () => {
    writeCacheForSession('repeat-urgent', {
      turnCount: 5,
      lastCommitsHash: sha256Hex(formattedCommits()),
    });

    const output = buildAdditionalContext(
      promptEnvelope('urgent production down, recover the retrieval path now', 'repeat-urgent'),
      { agentName, org: 'clearworksai' },
    );

    expect(output).toContain('## Recent commits');
    expect(output).toContain('## Conversation direction');
  });

  it('routine short prompts skip kbQuery entirely', () => {
    buildAdditionalContext(promptEnvelope('ok sure', 'skip-kb'), {
      agentName,
      org: 'clearworksai',
    });

    expect(kbQueryCalls()).toHaveLength(0);
  });

  it('cache read failure behaves like turnCount 0', () => {
    const cacheFile = cachePathFor(agentName, 'corrupt-cache');
    mkdirSync(join(tmpdir(), 'cortextos-retrieval-cache', agentName), { recursive: true });
    writeFileSync(cacheFile, '{not-json', 'utf8');

    const output = buildAdditionalContext(promptEnvelope('ok continue', 'corrupt-cache'), {
      agentName,
      org: 'clearworksai',
    });

    expect(output).toContain('## Recent commits');
    expect(output).toContain('## Conversation direction');
    expect(readCache(cacheFile).turnCount).toBe(1);
  });

  it('a new session gets full context even when a prior session cache exists', () => {
    writeCacheForSession('prior-session', {
      turnCount: 10,
      lastCommitsHash: sha256Hex(formattedCommits()),
    });

    const output = buildAdditionalContext(promptEnvelope('ok continue', 'new-session'), {
      agentName,
      org: 'clearworksai',
    });

    expect(output).toContain('## Recent commits');
    expect(output).toContain('## Conversation direction');
  });

  it('output envelope shape remains unchanged', () => {
    const envelope = buildOutputEnvelope('ctx');

    expect(envelope.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(typeof envelope.hookSpecificOutput.additionalContext).toBe('string');
    expect(envelope.hookSpecificOutput.additionalContext).toBe('ctx');
  });

  it('records kb query metadata when the kb section is included', () => {
    const cacheFile = cachePathFor(agentName, 'kb-meta');

    const output = buildAdditionalContext(
      promptEnvelope('check meeting-evt-123 status before you answer', 'kb-meta'),
      { agentName, org: 'clearworksai', nowMs: 5000 },
    );

    expect(output).toContain('## MMRAG');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      lastKbQueryNormalized: string;
      lastKbResultHash: string;
      lastKbResultAtMs: number;
    };
    expect(cache.lastKbQueryNormalized).toContain('meeting-evt-123');
    expect(cache.lastKbResultHash).toBe(sha256Hex(kbResultText));
    expect(cache.lastKbResultAtMs).toBe(5000);
  });

  it('kb-query runs shell-free: prompt with shell metacharacters stays a single argv element', () => {
    const hostile = 'check meeting-evt-123 status"; touch /tmp/pwned; echo "&& rm -rf $HOME `id`';

    buildAdditionalContext(promptEnvelope(hostile, 'inject-prompt'), {
      agentName,
      org: 'clearworksai',
    });

    const calls = kbQueryCalls();
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    // Exact argv shape: no shell string is ever built.
    expect(argv[0]).toBe('bus');
    expect(argv[1]).toBe('kb-query');
    expect(argv.slice(3)).toEqual(['--org', 'clearworksai', '--top-k', '5', '--threshold', '0.45']);
    // The query is one argument; hostile content never reaches a shell.
    expect(argv[2]).toContain('touch /tmp/pwned');
    expect(argv[2]).not.toContain('"');
    expect(argv[2]).not.toContain('$');
    expect(argv[2]).not.toContain('`');
  });

  it('kb-query passes org as its own argv element (no shell interpolation of CTX_ORG)', () => {
    const hostileOrg = 'clearworksai; touch /tmp/pwned-org';

    buildAdditionalContext(promptEnvelope('check meeting-evt-123 status now', 'inject-org'), {
      agentName,
      org: hostileOrg,
    });

    const calls = kbQueryCalls();
    expect(calls).toHaveLength(1);
    const orgFlagIndex = calls[0].indexOf('--org');
    expect(orgFlagIndex).toBeGreaterThan(-1);
    expect(calls[0][orgFlagIndex + 1]).toBe(hostileOrg);
  });

  it('git commands run shell-free with argv arrays', () => {
    buildAdditionalContext(promptEnvelope('ok continue', 'git-argv'), {
      agentName,
      org: 'clearworksai',
    });

    const gitCalls = mockExecFileSync.mock.calls.filter(([file]) => file === 'git');
    expect(gitCalls.length).toBeGreaterThanOrEqual(2);
    for (const [, args] of gitCalls) {
      expect(Array.isArray(args)).toBe(true);
    }
    const logCall = gitCalls.find(([, args]) => (args as string[]).includes('log'));
    expect(logCall).toBeDefined();
    const logArgs = logCall?.[1] as string[];
    // Repo path is its own argv element after -C, never quoted into a shell string.
    expect(logArgs[0]).toBe('-C');
    expect(logArgs[1]).toBe(join(tempHome, 'fleet-repo'));
  });
});
