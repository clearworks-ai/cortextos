import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let frameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalInstanceId = process.env.CTX_INSTANCE_ID;
const originalAgentDir = process.env.CTX_AGENT_DIR;
const originalProjectRoot = process.env.CTX_PROJECT_ROOT;
const originalOrg = process.env.CTX_ORG;
const originalHome = process.env.HOME;

function sourceLedgerPath(): string {
  return join(tempCtx, 'state', 'comms-event-dedup.json');
}

function inboxDir(agent: string): string {
  return join(tempCtx, '.cortextos', 'default', 'inbox', agent);
}

function inboxFiles(agent: string): string[] {
  if (!existsSync(inboxDir(agent))) {
    return [];
  }
  return readdirSync(inboxDir(agent)).filter(file => file.endsWith('.json')).sort();
}

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'send-message-source-key-ctx-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'send-message-source-key-fw-'));
  mkdirSync(join(frameworkRoot, 'orgs', 'lifeos', 'agents', 'sender'), { recursive: true });
  mkdirSync(join(frameworkRoot, 'orgs', 'lifeos', 'agents', 'pa'), { recursive: true });

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = 'sender';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_AGENT_DIR = join(frameworkRoot, 'orgs', 'lifeos', 'agents', 'sender');
  process.env.CTX_PROJECT_ROOT = frameworkRoot;
  process.env.CTX_ORG = 'lifeos';
  process.env.HOME = tempCtx;
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;

  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;

  if (originalAgentName !== undefined) process.env.CTX_AGENT_NAME = originalAgentName;
  else delete process.env.CTX_AGENT_NAME;

  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
  else delete process.env.CTX_INSTANCE_ID;

  if (originalAgentDir !== undefined) process.env.CTX_AGENT_DIR = originalAgentDir;
  else delete process.env.CTX_AGENT_DIR;

  if (originalProjectRoot !== undefined) process.env.CTX_PROJECT_ROOT = originalProjectRoot;
  else delete process.env.CTX_PROJECT_ROOT;

  if (originalOrg !== undefined) process.env.CTX_ORG = originalOrg;
  else delete process.env.CTX_ORG;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;

  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('send-message --source-key', () => {
  it('suppresses a duplicate source event on the bus path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['send-message', 'pa', 'normal', 'Meeting reminder one', '--source-key', 'automator:meeting-evt-F'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-message', 'pa', 'normal', 'Meeting reminder two', '--source-key', 'automator:meeting-evt-F'],
      { from: 'user' },
    );

    expect(inboxFiles('pa')).toHaveLength(1);
    expect(existsSync(sourceLedgerPath())).toBe(true);
    const logs = logSpy.mock.calls
      .flat()
      .filter(value => typeof value === 'string') as string[];
    expect(logs.some(value => value.includes("Message suppressed (source event 'automator:meeting-evt-F'"))).toBe(true);
  });

  it('no source key -> both messages deliver (regression)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['send-message', 'pa', 'normal', 'First plain send'], { from: 'user' });
    await busCommand.parseAsync(['send-message', 'pa', 'normal', 'Second plain send'], { from: 'user' });

    expect(inboxFiles('pa')).toHaveLength(2);
    expect(existsSync(sourceLedgerPath())).toBe(false);
  });
});
