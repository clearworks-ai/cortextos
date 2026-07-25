import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  shouldDenyFast,
  buildPreToolUseDenyOutput,
  emitTelegramSuppressedEvent,
  isWorkerSession as isWorkerFromLib,
} from '../../../src/hooks/lib/session-context';
import { isWorkerSession as isWorkerFromHook } from '../../../src/hooks/hook-permission-telegram';

describe('telegram-suppression-guards', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tg-suppress-'));
    execFileMock.mockReset();
    for (const key of ['CTX_WORKER', 'CTX_FRAMEWORK_ROOT', 'CTX_ROOT', 'CTX_AGENT_NAME']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('refactor safety (permission hook)', () => {
    it('re-exports isWorkerSession from hook-permission-telegram', () => {
      process.env.CTX_WORKER = '1';
      expect(isWorkerFromHook()).toBe(true);
      delete process.env.CTX_WORKER;
      expect(isWorkerFromHook()).toBe(false);
    });

    it('re-export is the same function identity as session-context', () => {
      expect(isWorkerFromHook).toBe(isWorkerFromLib);
    });
  });

  describe('mirror-gate: hook-ask-telegram', () => {
    // Mirrors Spec-02.1 guard after loadEnv()
    function mirrorAskGuard(stateDir: string): {
      denyFast: ReturnType<typeof shouldDenyFast>;
      askStateWritten: boolean;
      stdoutLine: string | null;
      sendReached: boolean;
    } {
      const denyFast = shouldDenyFast(stateDir);
      if (denyFast.deny) {
        emitTelegramSuppressedEvent({
          hook: 'hook-ask-telegram',
          toolName: 'AskUserQuestion',
          source: denyFast.source,
          cronName: denyFast.source === 'cron' ? denyFast.cronName : undefined,
          firedAt: denyFast.source === 'cron' ? denyFast.firedAt : undefined,
        });
        const stdoutLine =
          buildPreToolUseDenyOutput(
            `${denyFast.reason} — AskUserQuestion blocked; answer with your best judgment and continue`,
          );
        return { denyFast, askStateWritten: false, stdoutLine, sendReached: false };
      }
      writeFileSync(join(stateDir, 'ask-state.json'), JSON.stringify({ ok: true }), 'utf-8');
      return { denyFast, askStateWritten: true, stdoutLine: null, sendReached: true };
    }

    it('worker suppresses ask (no ask-state, deny output)', () => {
      process.env.CTX_WORKER = '1';
      const r = mirrorAskGuard(tmp);
      expect(r.denyFast.deny).toBe(true);
      expect(r.sendReached).toBe(false);
      expect(existsSync(join(tmp, 'ask-state.json'))).toBe(false);
      expect(r.stdoutLine).toBeTruthy();
      const parsed = JSON.parse(r.stdoutLine!) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('cron suppresses ask and meta includes cronName', () => {
      writeFileSync(
        join(tmp, '.cron-active'),
        JSON.stringify({
          cronName: 'heartbeat',
          firedAt: '2026-07-25T09:00:00Z',
          expiresAt: Date.now() + 60_000,
        }),
        'utf-8',
      );
      process.env.CTX_FRAMEWORK_ROOT = tmp;
      const r = mirrorAskGuard(tmp);
      expect(r.denyFast.deny).toBe(true);
      if (r.denyFast.deny) expect(r.denyFast.source).toBe('cron');
      expect(existsSync(join(tmp, 'ask-state.json'))).toBe(false);
      expect(execFileMock).toHaveBeenCalled();
      const argv = execFileMock.mock.calls[0][1] as string[];
      const meta = JSON.parse(argv[argv.length - 1]) as Record<string, string>;
      expect(meta.cronName).toBe('heartbeat');
    });

    it('interactive still reaches send and writes ask-state', () => {
      const r = mirrorAskGuard(tmp);
      expect(r.denyFast.deny).toBe(false);
      expect(r.sendReached).toBe(true);
      expect(existsSync(join(tmp, 'ask-state.json'))).toBe(true);
    });
  });

  describe('mirror-gate: hook-planmode-telegram', () => {
    // Mirrors Spec-02.2 guard after loadEnv()
    function mirrorPlanGuard(stateDir: string): {
      decision: 'allow' | 'deny' | null;
      sendReached: boolean;
    } {
      const denyFast = shouldDenyFast(stateDir);
      if (denyFast.deny) {
        emitTelegramSuppressedEvent({
          hook: 'hook-planmode-telegram',
          toolName: 'ExitPlanMode',
          source: denyFast.source,
          cronName: denyFast.source === 'cron' ? denyFast.cronName : undefined,
          firedAt: denyFast.source === 'cron' ? denyFast.firedAt : undefined,
        });
        return { decision: 'allow', sendReached: false };
      }
      return { decision: null, sendReached: true };
    }

    it('worker+cron suppress with allow (not deny)', () => {
      process.env.CTX_WORKER = '1';
      const worker = mirrorPlanGuard(tmp);
      expect(worker.decision).toBe('allow');
      expect(worker.sendReached).toBe(false);

      delete process.env.CTX_WORKER;
      writeFileSync(
        join(tmp, '.cron-active'),
        JSON.stringify({
          cronName: 'heartbeat',
          firedAt: 't',
          expiresAt: Date.now() + 60_000,
        }),
        'utf-8',
      );
      const cron = mirrorPlanGuard(tmp);
      expect(cron.decision).toBe('allow');
      expect(cron.sendReached).toBe(false);
    });

    it('interactive still reaches send', () => {
      const r = mirrorPlanGuard(tmp);
      expect(r.sendReached).toBe(true);
      expect(r.decision).toBeNull();
    });
  });

  describe('mirror-gate: hook-tool-result-router', () => {
    // Mirrors Spec-02.3: logEvent always, telegram only when !denyFast.deny
    function mirrorRouterGuard(stateDir: string): {
      logEventReached: boolean;
      telegramSuppressed: boolean;
      telegramFetchReached: boolean;
    } {
      const denyFast = shouldDenyFast(stateDir);
      const meta = { telegramSuppressed: denyFast.deny };
      const logEventReached = true;
      if (denyFast.deny) {
        return {
          logEventReached,
          telegramSuppressed: meta.telegramSuppressed,
          telegramFetchReached: false,
        };
      }
      return {
        logEventReached,
        telegramSuppressed: meta.telegramSuppressed,
        telegramFetchReached: true,
      };
    }

    it('worker suppresses Telegram but keeps activity feed', () => {
      process.env.CTX_WORKER = '1';
      const r = mirrorRouterGuard(tmp);
      expect(r.logEventReached).toBe(true);
      expect(r.telegramSuppressed).toBe(true);
      expect(r.telegramFetchReached).toBe(false);
    });

    it('interactive runs both feeds', () => {
      const r = mirrorRouterGuard(tmp);
      expect(r.logEventReached).toBe(true);
      expect(r.telegramSuppressed).toBe(false);
      expect(r.telegramFetchReached).toBe(true);
    });
  });

  describe('importability (require.main guards)', () => {
    it('importing ask and tool-result-router does not run main', async () => {
      execFileMock.mockClear();
      await import('../../../src/hooks/hook-ask-telegram');
      await import('../../../src/hooks/hook-tool-result-router');
      expect(existsSync(join(tmp, 'ask-state.json'))).toBe(false);
      // Import must not emit suppression bus events either
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });
});
