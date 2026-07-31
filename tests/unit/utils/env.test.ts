import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  buildSubprocessCtxEnv,
  isOpRef,
  loadEnvFileInto,
  resetOpRefStateForTest,
  resolveEnv,
  resolveOpRefs,
  sourceEnvFile,
} from '../../../src/utils/env';

describe('env op:// resolution', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let envSnapshot: NodeJS.ProcessEnv;
  let tempDirs: string[];

  function makeTempEnvFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
    tempDirs.push(dir);
    const filePath = join(dir, '.env');
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function stringifyCalls(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls
      .flat()
      .map((value) => String(value))
      .join('\n');
  }

  function restoreProcessEnv(): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  beforeEach(() => {
    envSnapshot = { ...process.env };
    tempDirs = [];
    execFileSyncMock.mockReset();
    resetOpRefStateForTest();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    restoreProcessEnv();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('isOpRef', () => {
    it('accepts op:// references', () => {
      expect(isOpRef('op://Openclaw/Item/field')).toBe(true);
      expect(isOpRef('op://x')).toBe(true);
    });

    it('rejects literal and malformed values', () => {
      for (const value of ['plain', '', ' op://leading-space', 'OP://caps', 'http://example.com']) {
        expect(isOpRef(value)).toBe(false);
      }
    });
  });

  describe('resolveOpRefs — with token', () => {
    it('resolves multiple refs through a single op inject pass', () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';
      execFileSyncMock.mockImplementation((file, args, options) => {
        expect(file).toBe('op');
        expect(args).toEqual(['inject']);
        const injectOptions = options as { input: string; stdio: string[]; env: Record<string, string> };
        expect(injectOptions.stdio[2]).toBe('ignore');
        expect(injectOptions.env.OP_SERVICE_ACCOUNT_TOKEN).toBe('test-token');
        const lines = injectOptions.input.trim().split(/\r?\n/);
        return lines
          .map((line) => {
            const eqIdx = line.indexOf('=');
            const key = line.slice(0, eqIdx);
            return `${key}=resolved-${key}`;
          })
          .join('\n') + '\n';
      });

      const result = resolveOpRefs({
        A: 'op://Openclaw/I/f',
        B: 'op://Openclaw/I/g',
        LIT: 'plain',
      });

      expect(result).toEqual({
        A: 'resolved-A',
        B: 'resolved-B',
        LIT: 'plain',
      });
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it('takes the fast path for literal-only input', () => {
      const env = { A: 'plain', B: 'still-plain' };
      expect(resolveOpRefs(env)).toEqual(env);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('uses the per-process cache on repeated refs', () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';
      execFileSyncMock.mockImplementation((_file, _args, options) => {
        const injectOptions = options as { input: string };
        const key = injectOptions.input.slice(0, injectOptions.input.indexOf('='));
        return `${key}=cached-secret\n`;
      });

      expect(resolveOpRefs({ A: 'op://Openclaw/I/f' }).A).toBe('cached-secret');
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);

      expect(resolveOpRefs({ B: 'op://Openclaw/I/f' }).B).toBe('cached-secret');
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to per-key op read when op inject is unavailable', () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';
      execFileSyncMock.mockImplementation((file, args, options) => {
        expect(file).toBe('op');
        const childArgs = args as string[];
        if (childArgs[0] === 'inject') {
          throw new Error('ENOENT');
        }
        expect(childArgs[0]).toBe('read');
        expect((options as { stdio: string[] }).stdio[2]).toBe('ignore');
        return 'secret-value\n';
      });

      const result = resolveOpRefs({ SECRET: 'op://Openclaw/I/f' });

      expect(result.SECRET).toBe('secret-value');
      expect(execFileSyncMock).toHaveBeenCalledTimes(2);
      expect(stringifyCalls(warnSpy)).toContain('[env] op inject unavailable, falling back to per-key op read');
    });

    it('keeps a literal ref and warns by key name only when op read also fails', () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';
      execFileSyncMock.mockImplementation((_file, args) => {
        const childArgs = args as string[];
        if (childArgs[0] === 'inject') {
          throw new Error('inject failed for op://Openclaw/I/f');
        }
        throw new Error('read failed for secret-value');
      });

      const result = resolveOpRefs({ SECRET_KEY: 'op://Openclaw/I/f' });
      const warnOutput = stringifyCalls(warnSpy);

      expect(result.SECRET_KEY).toBe('op://Openclaw/I/f');
      expect(warnOutput).toContain('SECRET_KEY');
      expect(warnOutput).not.toContain('op://Openclaw/I/f');
      expect(warnOutput).not.toContain('secret-value');
    });

    it('uses a literal token from the env map when process.env has none', () => {
      execFileSyncMock.mockImplementation((_file, args, options) => {
        expect(args).toEqual(['inject']);
        expect((options as { env: Record<string, string> }).env.OP_SERVICE_ACCOUNT_TOKEN).toBe('map-token');
        return 'SECRET=resolved-SECRET\n';
      });

      const result = resolveOpRefs({
        OP_SERVICE_ACCOUNT_TOKEN: 'map-token',
        SECRET: 'op://Openclaw/I/f',
      });

      expect(result.SECRET).toBe('resolved-SECRET');
    });

    it('treats an op-ref token as absent', () => {
      const result = resolveOpRefs({
        OP_SERVICE_ACCOUNT_TOKEN: 'op://Openclaw/Bootstrap/token',
        SECRET: 'op://Openclaw/I/f',
      });

      expect(result.SECRET).toBe('op://Openclaw/I/f');
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(stringifyCalls(warnSpy)).toContain('OP_SERVICE_ACCOUNT_TOKEN');
    });
  });

  describe('resolveOpRefs — no token', () => {
    it('leaves refs literal without throwing', () => {
      const result = resolveOpRefs({ A: 'op://Openclaw/I/f' });
      expect(result.A).toBe('op://Openclaw/I/f');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('warns only once per process even across multiple calls', () => {
      resolveOpRefs({
        A: 'op://Openclaw/I/f',
        B: 'op://Openclaw/I/g',
        C: 'op://Openclaw/I/h',
      });
      resolveOpRefs({ D: 'op://Openclaw/I/i' });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnOutput = stringifyCalls(warnSpy);
      expect(warnOutput).toContain('A');
      expect(warnOutput).toContain('B');
      expect(warnOutput).toContain('C');
      expect(warnOutput).not.toContain('op://Openclaw/I/f');
    });
  });

  describe('sourceEnvFile — parser semantics preserved', () => {
    it('preserves first-wins semantics for process.env', () => {
      process.env.KEEP = 'existing';
      const envFile = makeTempEnvFile('KEEP=other\nNEW=fresh\n');

      sourceEnvFile(envFile);

      expect(process.env.KEEP).toBe('existing');
      expect(process.env.NEW).toBe('fresh');
    });

    it('parses BOM and CRLF correctly', () => {
      const envFile = makeTempEnvFile('\ufeffFIRST=1\r\nSECOND=2\r\n');

      sourceEnvFile(envFile);

      expect(process.env.FIRST).toBe('1');
      expect(process.env.SECOND).toBe('2');
    });

    it('preserves quote and inline-comment parsing semantics', () => {
      const envFile = makeTempEnvFile([
        'Q1="quoted value"',
        "Q2='single'",
        'U=value # inline comment',
        '# full comment line',
        'NOEQ',
      ].join('\n'));

      sourceEnvFile(envFile);

      expect(process.env.Q1).toBe('quoted value');
      expect(process.env.Q2).toBe('single');
      expect(process.env.U).toBe('value');
      expect(process.env.NOEQ).toBeUndefined();
    });

    it('resolves op refs after parse and before apply', () => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';
      execFileSyncMock.mockReturnValue('SECRET=resolved-SECRET\n');
      const envFile = makeTempEnvFile('SECRET=op://Openclaw/I/f\n');

      sourceEnvFile(envFile);

      expect(process.env.SECRET).toBe('resolved-SECRET');
    });
  });

  describe('loadEnvFileInto', () => {
    it('uses overwrite semantics for the target map', () => {
      const envFile = makeTempEnvFile('K=agent\n');
      const target = { K: 'org' };

      loadEnvFileInto(envFile, target);

      expect(target.K).toBe('agent');
    });

    it('ignores missing files', () => {
      const target = { K: 'org' };
      loadEnvFileInto(join(tmpdir(), 'missing-env-file'), target);
      expect(target).toEqual({ K: 'org' });
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('no secret bytes in logs', () => {
    it('never writes resolved secrets or op error text to console output', () => {
      const sentinel = 'SENTINEL_SECRET_XYZZY';
      process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';

      execFileSyncMock.mockImplementationOnce(() => `SECRET=${sentinel}\n`);
      expect(resolveOpRefs({ SECRET: 'op://Openclaw/I/f' }).SECRET).toBe(sentinel);

      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error(sentinel);
      });
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error(sentinel);
      });
      expect(resolveOpRefs({ SECOND_SECRET: 'op://Openclaw/I/g' }).SECOND_SECRET).toBe('op://Openclaw/I/g');

      const logOutput = `${stringifyCalls(warnSpy)}\n${stringifyCalls(errorSpy)}`;
      expect(logOutput).not.toContain(sentinel);
    });
  });

  describe('buildSubprocessCtxEnv', () => {
    it('strips inherited CTX_AGENT_DIR and re-roots both CTX roots', () => {
      const result = buildSubprocessCtxEnv(
        {
          CTX_AGENT_DIR: '/live/agents/sage',
          CTX_FRAMEWORK_ROOT: '/live',
          CTX_PROJECT_ROOT: '/live',
          PATH: '/usr/bin',
        },
        { root: '/wt' },
      );

      expect(result.CTX_FRAMEWORK_ROOT).toBe('/wt');
      expect(result.CTX_PROJECT_ROOT).toBe('/wt');
      expect('CTX_AGENT_DIR' in result).toBe(false);
      expect(result.PATH).toBe('/usr/bin');
    });

    it('only overrides optional keys when opts provide them', () => {
      const base = {
        CTX_INSTANCE_ID: 'live-instance',
        CTX_ROOT: '/live/root',
        CTX_ORG: 'live-org',
      };

      const inherited = buildSubprocessCtxEnv(base, { root: '/wt' });
      expect(inherited.CTX_INSTANCE_ID).toBe('live-instance');
      expect(inherited.CTX_ROOT).toBe('/live/root');
      expect(inherited.CTX_ORG).toBe('live-org');

      const overridden = buildSubprocessCtxEnv(base, {
        root: '/wt',
        instanceId: 'sandbox-instance',
        ctxRoot: '/sandbox/root',
        org: 'sandbox-org',
      });
      expect(overridden.CTX_INSTANCE_ID).toBe('sandbox-instance');
      expect(overridden.CTX_ROOT).toBe('/sandbox/root');
      expect(overridden.CTX_ORG).toBe('sandbox-org');
    });

    it('passes the sandbox guard end-to-end by re-deriving agentDir under the new root', () => {
      const liveRoot = mkdtempSync(join(tmpdir(), 'env-live-root-'));
      const worktreeRoot = mkdtempSync(join(tmpdir(), 'env-worktree-root-'));
      tempDirs.push(liveRoot, worktreeRoot);

      const env = buildSubprocessCtxEnv(
        {
          CTX_AGENT_DIR: join(liveRoot, 'orgs', 'acme', 'agents', 'sage'),
          CTX_FRAMEWORK_ROOT: liveRoot,
          CTX_PROJECT_ROOT: liveRoot,
          CTX_AGENT_NAME: 'sage',
          CTX_ORG: 'acme',
          CTX_INSTANCE_ID: 'default',
          CTX_ROOT: join(worktreeRoot, '.ctx'),
        },
        {
          root: worktreeRoot,
          instanceId: 'default',
          ctxRoot: join(worktreeRoot, '.ctx'),
          org: 'acme',
        },
      );

      Object.assign(process.env, env);

      const resolved = resolveEnv();

      expect(resolved.frameworkRoot).toBe(worktreeRoot);
      expect(resolved.projectRoot).toBe(worktreeRoot);
      expect(resolved.agentDir).toBe(join(worktreeRoot, 'orgs', 'acme', 'agents', 'sage'));
    });
  });
});
