import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_WATCHDOG_ENV_KEYS,
  buildHeartbeatWatchdogEnv,
} from '../../../src/daemon/fast-checker';

const TARGET = {
  agentName: 'knox-codex',
  agentDir: '/tmp/fw/agents/knox-codex',
  org: 'acme',
  ctxRoot: '/tmp/ctx',
  instanceId: 'test-instance',
  frameworkRoot: '/tmp/fw',
  projectRoot: '/tmp/fw',
  timezone: 'America/Los_Angeles',
  orchestrator: 'frank',
};

const CTX_KEYS = [
  'CTX_AGENT_NAME',
  'CTX_AGENT_DIR',
  'CTX_ORG',
  'CTX_ROOT',
  'CTX_INSTANCE_ID',
  'CTX_FRAMEWORK_ROOT',
  'CTX_PROJECT_ROOT',
  'CTX_TIMEZONE',
  'CTX_ORCHESTRATOR',
] as const;

const EXPECTED_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
] as const;

/** Credential-shaped names. Assertions compare KEYS only — never values. */
const SECRET_KEY_RE = /token|secret|password|credential|api[_-]?key/i;

function secretShapedKeys(keys: string[]): string[] {
  return keys.filter((k) => SECRET_KEY_RE.test(k));
}

describe('buildHeartbeatWatchdogEnv', () => {
  it('allowlist is the exact required safe key set', () => {
    expect([...HEARTBEAT_WATCHDOG_ENV_KEYS]).toEqual([...EXPECTED_ALLOWLIST]);
    expect(secretShapedKeys([...HEARTBEAT_WATCHDOG_ENV_KEYS])).toEqual([]);
    expect(HEARTBEAT_WATCHDOG_ENV_KEYS).not.toContain('USER');
    expect(HEARTBEAT_WATCHDOG_ENV_KEYS).not.toContain('LOGNAME');
    expect(HEARTBEAT_WATCHDOG_ENV_KEYS).not.toContain('SHELL');
    expect(HEARTBEAT_WATCHDOG_ENV_KEYS).not.toContain('TZ');
  });

  it('child keys are exactly allowlist ∩ parent plus CTX pin — keys only', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/bin',
      HOME: '/home/u',
      LANG: 'C',
      USER: 'not-copied',
      SHELL: '/bin/zsh',
      TZ: 'UTC',
      NODE_OPTIONS: 'not-copied',
    };
    const keys = Object.keys(buildHeartbeatWatchdogEnv(parent, TARGET)).sort();
    expect(keys).toEqual(['HOME', 'LANG', 'PATH', ...CTX_KEYS].sort());
    expect(keys).not.toContain('USER');
    expect(keys).not.toContain('SHELL');
    expect(keys).not.toContain('TZ');
    expect(keys).not.toContain('NODE_OPTIONS');
  });

  it('secret-shaped parent keys never appear on the child env (keys only)', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/bin',
      SLACK_BOT_TOKEN: 'xoxb-should-not-copy',
      TELEGRAM_BOT_TOKEN: '123:AA-should-not-copy',
      AWS_SECRET_ACCESS_KEY: 'wJalr-should-not-copy',
      GITHUB_TOKEN: 'ghp-should-not-copy',
      DATABASE_URL: 'postgres://user:pw@host/db',
      OPENAI_API_KEY: 'sk-should-not-copy',
    };
    const keys = Object.keys(buildHeartbeatWatchdogEnv(parent, TARGET));
    expect(secretShapedKeys(keys)).toEqual([]);
    expect(keys).toContain('PATH');
    expect(keys).not.toContain('SLACK_BOT_TOKEN');
    expect(keys).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(keys).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(keys).not.toContain('GITHUB_TOKEN');
    expect(keys).not.toContain('DATABASE_URL');
    expect(keys).not.toContain('OPENAI_API_KEY');
  });
});
