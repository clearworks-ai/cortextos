import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendMessageSpy = vi.fn();
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalCwd: string;
let originalInstanceId: string | undefined;
let originalOrg: string | undefined;
let originalHome: string | undefined;

function sourceLedgerPath(): string {
  return join(tempCtx, 'state', 'comms-event-dedup.json');
}

function telegramLedgerPath(): string {
  return join(tempCtx, 'state', 'telegram-dedup.json');
}

function readLedger(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'send-telegram-source-key-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'send-telegram-source-key-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalInstanceId = process.env.CTX_INSTANCE_ID;
  originalOrg = process.env.CTX_ORG;
  originalHome = process.env.HOME;
  originalCwd = process.cwd();

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.CTX_ORG = 'clearworksai';
  process.env.HOME = tempCwd;
  process.chdir(tempCwd);

  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue({ result: { message_id: 1 } });
});

afterEach(() => {
  process.chdir(originalCwd);

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
  rmSync(tempCwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('send-telegram --source-key', () => {
  it('eratepros replay: 4 reworded bodies, same source key -> exactly one send', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bodies = [
      'Reminder: ERatePros call with Dean Wilcox at 10am.',
      'Heads up - Dean Wilcox meeting coming up.',
      'Dean Wilcox reminder: ERatePros at 10am.',
      'Meeting soon: ERatePros and Dean Wilcox.',
    ];

    for (const body of bodies) {
      await busCommand.parseAsync(
        ['send-telegram', '12345', body, '--source-key', 'automator:meeting-evt-eratepros', '--source-ttl-sec', '43200'],
        { from: 'user' },
      );
    }

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(readLedger(sourceLedgerPath()))).toEqual(['automator:meeting-evt-eratepros']);
    const erateprosLogs = logSpy.mock.calls
      .flat()
      .filter(value => typeof value === 'string') as string[];
    expect(
      erateprosLogs
        .filter(value => value.includes("Message suppressed (source event 'automator:meeting-evt-eratepros'"))
    ).toHaveLength(3);
  });

  it('goldbach thread: one ping per source event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'James Goldbach thread update one', '--source-key', 'frank2:thread-goldbach123'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'James Goldbach thread update two', '--source-key', 'frank2:thread-goldbach123'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'James Goldbach follow-up', '--source-key', 'frank2:thread-goldbach999'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(Object.keys(readLedger(sourceLedgerPath())).sort()).toEqual([
      'frank2:thread-goldbach123',
      'frank2:thread-goldbach999',
    ]);
  });

  it('different meeting still surfaces', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Meeting A reminder', '--source-key', 'pa:meeting-evt-A'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Meeting B reminder', '--source-key', 'pa:meeting-evt-B'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('byte-hash fallback regression: no source key, identical body suppressed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = 'Same body without a source key';

    await busCommand.parseAsync(['send-telegram', '12345', message], { from: 'user' });
    await busCommand.parseAsync(['send-telegram', '12345', message], { from: 'user' });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(readLedger(sourceLedgerPath())).toEqual({});
    expect(readLedger(telegramLedgerPath())).not.toEqual({});
    const noSourceLogs = logSpy.mock.calls
      .flat()
      .filter(value => typeof value === 'string') as string[];
    expect(
      noSourceLogs.some(value => value.includes('Message suppressed (duplicate sent'))
    ).toBe(true);
  });

  it('invalid source key fails open to byte-hash', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'First invalid-key body', '--source-key', 'NoNamespace'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Second invalid-key body', '--source-key', 'NoNamespace'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(readLedger(sourceLedgerPath())).toEqual({});
    const invalidKeyErrors = errSpy.mock.calls
      .flat()
      .filter(value => typeof value === 'string') as string[];
    expect(
      invalidKeyErrors.filter(value => value.includes("Warning: invalid --source-key 'NoNamespace'"))
    ).toHaveLength(2);
  });

  it('ttl expiry: same key surfaces again after window', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Initial meeting reminder', '--source-key', 'pa:meeting-evt-C', '--source-ttl-sec', '43200'],
      { from: 'user' },
    );

    nowMs += 43_201_000;

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Next-day meeting reminder', '--source-key', 'pa:meeting-evt-C', '--source-ttl-sec', '43200'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('send failure rolls back a first-seen source record', async () => {
    const exitSpy = mockExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendMessageSpy
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ result: { message_id: 2 } });

    await expect(
      busCommand.parseAsync(
        ['send-telegram', '12345', 'First attempt fails', '--source-key', 'pa:meeting-evt-D'],
        { from: 'user' },
      )
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(readLedger(sourceLedgerPath())).toEqual({});

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Second attempt succeeds', '--source-key', 'pa:meeting-evt-D'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(Object.keys(readLedger(sourceLedgerPath()))).toEqual(['pa:meeting-evt-D']);
  });

  it('no-dedup bypasses the source-key layer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Bypass one', '--source-key', 'pa:meeting-evt-E', '--no-dedup'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Bypass two', '--source-key', 'pa:meeting-evt-E', '--no-dedup'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(readLedger(sourceLedgerPath())).toEqual({});
  });

  it('--kind comms requires a source key', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(
        ['send-telegram', '12345', 'Comms send without a source key', '--kind', 'comms'],
        { from: 'user' },
      )
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(
      errSpy.mock.calls.flat().some(value => typeof value === 'string' && value.includes('requires --source-key'))
    ).toBe(true);
  });

  it('--kind comms keeps source-event dedup active even with --no-dedup', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'First comms surface', '--kind', 'comms', '--source-key', 'gmail:19f87c605b27bab7', '--no-dedup'],
      { from: 'user' },
    );
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Second comms surface', '--kind', 'comms', '--source-key', 'gmail:19f87c605b27bab7', '--no-dedup'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(readLedger(sourceLedgerPath()))).toEqual(['gmail:19f87c605b27bab7']);
  });
});
