import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = process.cwd();
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXED_NOW = '2026-07-16T20:00:00.000Z';
const EVENT_DATE = '2026-07-16';

type HookCase = {
  emitSystemPings: boolean;
  markerFile?: string;
  markerReason?: string;
  stdoutLog?: string;
};

type FetchCall = {
  url: string;
  options: {
    body?: string;
  };
};

type ExecCall = unknown[];

type HookRunResult = {
  fetchCalls: FetchCall[];
  execCalls: ExecCall[];
  events: Array<{
    event: string;
    metadata?: Record<string, unknown>;
  }>;
  status: number | null;
  stderr: string;
};

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function createPreloadScript(preloadPath: string): void {
  writeFileSync(
    preloadPath,
    `const { appendFileSync } = require('fs');
const childProcess = require('child_process');
const fetchLogPath = process.env.TEST_FETCH_LOG;
const execLogPath = process.env.TEST_EXEC_LOG;
const fixedNow = process.env.TEST_FIXED_NOW;
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(fixedNow);
      return;
    }
    super(...args);
  }
  static now() {
    return new RealDate(fixedNow).getTime();
  }
  static parse(value) {
    return RealDate.parse(value);
  }
  static UTC(...args) {
    return RealDate.UTC(...args);
  }
}
global.Date = FixedDate;
global.fetch = async (url, options = {}) => {
  appendFileSync(fetchLogPath, JSON.stringify({ url, options }) + '\\n', 'utf-8');
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({}),
  };
};
childProcess.execFile = (...args) => {
  appendFileSync(execLogPath, JSON.stringify(args) + '\\n', 'utf-8');
  const maybeCallback = args[args.length - 1];
  if (typeof maybeCallback === 'function') {
    maybeCallback(null, '', '');
  }
  return { pid: 1, kill() {} };
};
`,
    'utf-8',
  );
}

function runHookCase(tmp: string, testCase: HookCase): HookRunResult {
  const tempHome = join(tmp, 'home');
  const agentDir = join(tmp, 'agent');
  const instanceId = 'hook-test';
  const agentName = 'test-agent';
  const org = 'clearworksai';
  const stateDir = join(tempHome, '.cortextos', instanceId, 'state', agentName);
  const logDir = join(tempHome, '.cortextos', instanceId, 'logs', agentName);
  const fetchLogPath = join(tmp, 'fetch.jsonl');
  const execLogPath = join(tmp, 'exec.jsonl');
  const preloadPath = join(tmp, 'preload.cjs');
  const eventPath = join(
    tempHome,
    '.cortextos',
    instanceId,
    'orgs',
    org,
    'analytics',
    'events',
    agentName,
    `${EVENT_DATE}.jsonl`,
  );

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ emit_system_telegram_pings: testCase.emitSystemPings }),
    'utf-8',
  );
  writeFileSync(fetchLogPath, '', 'utf-8');
  writeFileSync(execLogPath, '', 'utf-8');
  createPreloadScript(preloadPath);

  if (testCase.markerFile) {
    writeFileSync(
      join(stateDir, testCase.markerFile),
      testCase.markerReason ?? testCase.markerFile,
      'utf-8',
    );
  }
  if (testCase.stdoutLog) {
    writeFileSync(join(logDir, 'stdout.log'), testCase.stdoutLog, 'utf-8');
  }

  const nodeOptions = [process.env.NODE_OPTIONS, '--require', preloadPath]
    .filter(Boolean)
    .join(' ');
  const run = spawnSync(
    process.execPath,
    [TSX_CLI, 'src/hooks/hook-crash-alert.ts'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tempHome,
        CTX_AGENT_NAME: agentName,
        CTX_INSTANCE_ID: instanceId,
        CTX_ORG: org,
        CTX_AGENT_DIR: agentDir,
        BOT_TOKEN: 'test-bot-token',
        CHAT_ID: '12345',
        TEST_FETCH_LOG: fetchLogPath,
        TEST_EXEC_LOG: execLogPath,
        TEST_FIXED_NOW: FIXED_NOW,
        NODE_OPTIONS: nodeOptions,
      },
      encoding: 'utf-8',
      input: JSON.stringify({ session_id: 'sess-1' }),
      timeout: 10_000,
    },
  );

  return {
    fetchCalls: readJsonLines<FetchCall>(fetchLogPath),
    execCalls: readJsonLines<ExecCall>(execLogPath),
    events: readJsonLines<{ event: string; metadata?: Record<string, unknown> }>(eventPath),
    status: run.status,
    stderr: run.stderr ?? '',
  };
}

function extractFetchText(fetchCall: FetchCall): string {
  const body = fetchCall.options.body ?? '{}';
  return (JSON.parse(body) as { text?: string }).text ?? '';
}

describe('hook-crash-alert lifecycle gate', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hook-crash-alert-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('flag OFF + planned-restart suppresses Telegram and writes a lifecycle_notice event', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
      markerFile: '.restart-planned',
      markerReason: 'planned reboot',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.fetchCalls).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        event: 'system_ping_suppressed',
        metadata: expect.objectContaining({
          kind: 'lifecycle_notice',
          type: 'planned-restart',
        }),
      }),
    );
  });

  it('flag OFF + session-refresh suppresses Telegram and writes a lifecycle_notice event', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
      markerFile: '.session-refresh',
      markerReason: 'context rollover',
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        event: 'system_ping_suppressed',
        metadata: expect.objectContaining({
          kind: 'lifecycle_notice',
          type: 'session-refresh',
        }),
      }),
    );
  });

  it('flag OFF + daemon-stop suppresses Telegram and writes a lifecycle_notice event', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
      markerFile: '.daemon-stop',
      markerReason: 'SIGTERM',
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        event: 'system_ping_suppressed',
        metadata: expect.objectContaining({
          kind: 'lifecycle_notice',
          type: 'daemon-stop',
        }),
      }),
    );
  });

  it('flag ON + planned-restart still sends Telegram', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: true,
      markerFile: '.restart-planned',
      markerReason: 'planned reboot',
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(extractFetchText(result.fetchCalls[0])).toContain('🔄 test-agent restarted (planned)');
  });

  it('flag OFF + crash still sends Telegram', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(extractFetchText(result.fetchCalls[0])).toContain('🚨 CRASH: test-agent died unexpectedly.');
  });

  it('flag OFF + daemon-crashed still sends Telegram', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
      markerFile: '.daemon-crashed',
      markerReason: 'daemon panic',
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(extractFetchText(result.fetchCalls[0])).toContain('🚨 test-agent — daemon crashed, session was interrupted. Resuming.');
  });

  it('flag OFF + rate-limited still sends Telegram', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
      stdoutLog: 'API Error: rate_limit_error: too many tokens\n',
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(extractFetchText(result.fetchCalls[0])).toContain('⏳ test-agent paused — Anthropic rate limit hit.');
  });

  it('flag OFF + user-restart still sends Telegram', () => {
    const result = runHookCase(tmp, {
      emitSystemPings: false,
      markerFile: '.user-restart',
      markerReason: 'manual restart',
    });

    expect(result.status).toBe(0);
    expect(result.fetchCalls).toHaveLength(1);
    expect(extractFetchText(result.fetchCalls[0])).toContain('🔄 test-agent restarted by user: manual restart');
  });
});
