import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  readCronActive,
  isWorkerSession,
  shouldDenyFast,
  buildPreToolUseDenyOutput,
  emitTelegramSuppressedEvent,
} from '../../../src/hooks/lib/session-context';

describe('session-context', () => {
  let tmp: string;
  const originalWorker = process.env.CTX_WORKER;
  const originalFramework = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'session-context-'));
    execFileMock.mockReset();
    delete process.env.CTX_WORKER;
    delete process.env.CTX_FRAMEWORK_ROOT;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalWorker === undefined) delete process.env.CTX_WORKER;
    else process.env.CTX_WORKER = originalWorker;
    if (originalFramework === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFramework;
  });

  describe('shouldDenyFast', () => {
    it('denies worker sessions', () => {
      process.env.CTX_WORKER = '1';
      expect(shouldDenyFast(tmp)).toEqual({
        deny: true,
        source: 'worker',
        reason: 'auto-suppressed: worker-session (CTX_WORKER=1), no human present',
      });
    });

    it('denies fresh cron marker', () => {
      writeFileSync(
        join(tmp, '.cron-active'),
        JSON.stringify({
          cronName: 'heartbeat',
          firedAt: '2026-07-25T09:00:00Z',
          expiresAt: Date.now() + 60_000,
        }),
        'utf-8',
      );
      const result = shouldDenyFast(tmp);
      expect(result).toMatchObject({
        deny: true,
        source: 'cron',
        cronName: 'heartbeat',
        firedAt: '2026-07-25T09:00:00Z',
      });
      if (result.deny && result.source === 'cron') {
        expect(result.reason).toContain('heartbeat');
      }
    });

    it('prefers cron over worker when both present', () => {
      process.env.CTX_WORKER = '1';
      writeFileSync(
        join(tmp, '.cron-active'),
        JSON.stringify({
          cronName: 'heartbeat',
          firedAt: '2026-07-25T09:00:00Z',
          expiresAt: Date.now() + 60_000,
        }),
        'utf-8',
      );
      const result = shouldDenyFast(tmp);
      expect(result.deny).toBe(true);
      if (result.deny) expect(result.source).toBe('cron');
    });

    it('ignores expired marker', () => {
      writeFileSync(
        join(tmp, '.cron-active'),
        JSON.stringify({
          cronName: 'heartbeat',
          firedAt: 'x',
          expiresAt: Date.now() - 1000,
        }),
        'utf-8',
      );
      expect(shouldDenyFast(tmp)).toEqual({ deny: false });
    });

    it('ignores corrupt marker', () => {
      writeFileSync(join(tmp, '.cron-active'), 'not-json', 'utf-8');
      expect(shouldDenyFast(tmp)).toEqual({ deny: false });
    });

    it('ignores marker without cronName', () => {
      writeFileSync(join(tmp, '.cron-active'), JSON.stringify({ firedAt: 'x' }), 'utf-8');
      expect(shouldDenyFast(tmp)).toEqual({ deny: false });
    });

    it('allows interactive sessions', () => {
      delete process.env.CTX_WORKER;
      expect(shouldDenyFast(tmp)).toEqual({ deny: false });
      process.env.CTX_WORKER = '0';
      expect(shouldDenyFast(tmp)).toEqual({ deny: false });
      process.env.CTX_WORKER = 'true';
      expect(shouldDenyFast(tmp)).toEqual({ deny: false });
    });
  });

  describe('buildPreToolUseDenyOutput', () => {
    it('emits dual legacy+modern deny shape without trailing newline', () => {
      const raw = buildPreToolUseDenyOutput('r1');
      expect(raw.endsWith('\n')).toBe(false);
      expect(JSON.parse(raw)).toEqual({
        decision: 'block',
        reason: 'r1',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'r1',
        },
      });
    });
  });

  describe('emitTelegramSuppressedEvent', () => {
    it('calls execFile via frameworkRoot cli path', () => {
      process.env.CTX_FRAMEWORK_ROOT = tmp;
      emitTelegramSuppressedEvent({
        hook: 'hook-ask-telegram',
        toolName: 'AskUserQuestion',
        source: 'worker',
      });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [execPath, argv, opts] = execFileMock.mock.calls[0] as [string, string[], { timeout: number }];
      expect(execPath).toBe(process.execPath);
      expect(argv.slice(0, 7)).toEqual([
        join(tmp, 'dist', 'cli.js'),
        'bus',
        'log-event',
        'action',
        'worker_telegram_suppressed',
        'warn',
        '--meta',
      ]);
      const meta = JSON.parse(argv[7]) as Record<string, string>;
      expect(meta.hook).toBe('hook-ask-telegram');
      expect(meta.toolName).toBe('AskUserQuestion');
      expect(meta.source).toBe('worker');
      expect(opts.timeout).toBe(5_000);
    });

    it('falls back to cortextos binary', () => {
      delete process.env.CTX_FRAMEWORK_ROOT;
      emitTelegramSuppressedEvent({
        hook: 'hook-ask-telegram',
        toolName: 'AskUserQuestion',
        source: 'worker',
      });
      const [bin, argv] = execFileMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe('cortextos');
      expect(argv[0]).toBe('bus');
    });

    it('swallows execFile throws', () => {
      execFileMock.mockImplementation(() => {
        throw new Error('bus down');
      });
      expect(() =>
        emitTelegramSuppressedEvent({
          hook: 'hook-ask-telegram',
          toolName: 'AskUserQuestion',
          source: 'worker',
        }),
      ).not.toThrow();
    });

    it('includes cron meta fields', () => {
      process.env.CTX_FRAMEWORK_ROOT = tmp;
      emitTelegramSuppressedEvent({
        hook: 'hook-planmode-telegram',
        toolName: 'ExitPlanMode',
        source: 'cron',
        cronName: 'heartbeat',
        firedAt: 'f1',
      });
      const argv = execFileMock.mock.calls[0][1] as string[];
      const meta = JSON.parse(argv[argv.length - 1]) as Record<string, string>;
      expect(meta.cronName).toBe('heartbeat');
      expect(meta.firedAt).toBe('f1');
      expect(meta.source).toBe('cron');
    });
  });

  describe('primitives', () => {
    it('isWorkerSession is exact-1', () => {
      process.env.CTX_WORKER = '1';
      expect(isWorkerSession()).toBe(true);
      delete process.env.CTX_WORKER;
      expect(isWorkerSession()).toBe(false);
    });

    it('readCronActive returns null when missing', () => {
      expect(readCronActive(tmp)).toBeNull();
    });
  });
});
