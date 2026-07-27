import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
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

function kbQueryCalls(): string[] {
  return mockExecSync.mock.calls
    .map(([command]) => String(command))
    .filter((command) => command.includes('cortextos bus kb-query'));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'hook-retrieval-enforcer-'));
  agentName = 'codexer';
  commitLogText = 'abc123 07-26 01:00 feat: tighten retrieval cache';
  kbResultText = 'KB hit line one';

  process.env.HOME = tempHome;
  process.env.CTX_AGENT_NAME = agentName;
  process.env.CTX_ORG = 'clearworksai';

  mockExecSync.mockReset();
  mockExecSync.mockImplementation((command: unknown) => {
    const commandText = String(command);
    if (commandText === 'git rev-parse --show-toplevel') {
      return `${join(tempHome, 'fleet-repo')}\n`;
    }
    if (commandText.includes('git -C') && commandText.includes('log --all')) {
      return `${commitLogText}\n`;
    }
    if (commandText.includes('cortextos bus kb-query')) {
      return `${kbResultText}\n`;
    }
    throw new Error(`Unexpected command: ${commandText}`);
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
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(readCache(cachePathFor(agentName, 'cron-session'))).toEqual({
      turnCount: 99,
      lastCommitsHash: 'keep-me',
    });
  });

  it('empty or short prompts short-circuit unchanged', () => {
    const output = buildAdditionalContext(promptEnvelope('ok', 'short-session'), {
      agentName,
      org: 'clearworksai',
    });

    expect(output).toBe('');
    expect(mockExecSync).not.toHaveBeenCalled();
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
});
