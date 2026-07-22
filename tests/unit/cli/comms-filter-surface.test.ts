import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendMessageSpy = vi.fn();
let stdinPayload = '';

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (path: unknown, options?: unknown) => {
      if (path === 0) {
        return stdinPayload;
      }
      return actual.readFileSync(
        path as Parameters<typeof actual.readFileSync>[0],
        options as never,
      );
    },
  };
});

import { busCommand } from '../../../src/cli/bus';

type SurfaceOutput = {
  emails: Array<{ id: string }>;
  summary: {
    total: number;
    surfaced: number;
    suppressed: number;
    sent: number;
    chatId: string;
    namespace: string;
  };
};

let tempCtx: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalInstanceId: string | undefined;
let originalOrg: string | undefined;
let originalHome: string | undefined;

function sourceLedgerPath(): string {
  return join(tempCtx, 'state', 'comms-event-dedup.json');
}

function readSourceLedger(): Record<string, { firstSeenAt: number; fireOnce: boolean }> {
  if (!existsSync(sourceLedgerPath())) {
    return {};
  }
  return JSON.parse(readFileSync(sourceLedgerPath(), 'utf-8')) as Record<string, { firstSeenAt: number; fireOnce: boolean }>;
}

function mockStdout(): { chunks: string[]; spy: ReturnType<typeof vi.spyOn> } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as never);
  return { chunks, spy };
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'comms-filter-surface-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalInstanceId = process.env.CTX_INSTANCE_ID;
  originalOrg = process.env.CTX_ORG;
  originalHome = process.env.HOME;

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_ORG = 'clearworksai';
  process.env.HOME = tempCtx;

  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue({ result: { message_id: 1 } });
  stdinPayload = '';
});

afterEach(() => {
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = originalBotToken;
  if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
  else process.env.CTX_INSTANCE_ID = originalInstanceId;
  if (originalOrg === undefined) delete process.env.CTX_ORG;
  else process.env.CTX_ORG = originalOrg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  rmSync(tempCtx, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('bus comms-filter --surface', () => {
  it('replays gmail id 19f87c605b27bab7 with 3 bodies and surfaces exactly once', async () => {
    stdinPayload = JSON.stringify({
      emails: [
        {
          id: '19f87c605b27bab7',
          from: 'Dr. Bob Newport <theholodoc@outlook.com>',
          subject: 'Hermes Stuckness.20260721.docx',
          snippet: 'First body variant',
        },
        {
          id: '19f87c605b27bab7',
          from: 'Dr. Bob Newport <theholodoc@outlook.com>',
          subject: 'Hermes Stuckness.20260721.docx',
          snippet: 'Second body variant',
        },
        {
          id: '19f87c605b27bab7',
          from: 'Dr. Bob Newport <theholodoc@outlook.com>',
          subject: 'Hermes Stuckness.20260721.docx',
          snippet: 'Third body variant',
        },
      ],
    });

    const { chunks } = mockStdout();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['comms-filter', '--surface', '--chat', '12345'],
      { from: 'user' },
    );

    const output = JSON.parse(chunks.join('')) as SurfaceOutput;

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[0]).toBe('12345');
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain('Source: gmail:19f87c605b27bab7');
    expect(output.summary).toEqual({
      total: 3,
      surfaced: 1,
      suppressed: 2,
      sent: 1,
      chatId: '12345',
      namespace: 'gmail',
    });
    expect(output.emails).toEqual([
      {
        id: '19f87c605b27bab7',
        from: 'Dr. Bob Newport <theholodoc@outlook.com>',
        subject: 'Hermes Stuckness.20260721.docx',
        snippet: 'First body variant',
      },
    ]);
    expect(Object.keys(readSourceLedger())).toEqual(['gmail:19f87c605b27bab7']);
  });

  it('requires --chat when --surface is set', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['comms-filter', '--surface'], { from: 'user' })
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(
      errSpy.mock.calls.flat().some(value => typeof value === 'string' && value.includes('requires --chat'))
    ).toBe(true);
  });
});
