import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../../../.claude/workflows/lib/runtime-bridge.js') as {
  extractOpenCodeJsonText: (stdout: string) => string;
  sendWork: (
    input: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

describe('runtime-bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts the final JSON text payload from opencode json output', () => {
    const output = [
      '{"type":"step_start","part":{"id":"1"}}',
      '{"type":"text","part":{"text":"{\\"ok\\":true"}}',
      '{"type":"text","part":{"text":",\\"provider\\":\\"openrouter\\"}"}}',
      '{"type":"step_finish","part":{"id":"2"}}',
    ].join('\n');

    expect(bridge.extractOpenCodeJsonText(output)).toBe('{"ok":true,"provider":"openrouter"}');
  });

  it('fails loud before spawn when OPENROUTER_API_KEY is missing', async () => {
    const envBackup = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    await expect(
      bridge.sendWork({
        provider: 'openrouter',
        model: 'openrouter/google/gemini-3.5-flash',
        prompt: 'Return {"ok":true}',
        schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      }),
    ).rejects.toThrow('OPENROUTER_API_KEY is required');

    if (envBackup) {
      process.env.OPENROUTER_API_KEY = envBackup;
    }
  });

  it('retries once on openrouter invalid json before succeeding', async () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('{"type":"text","part":{"text":"not-json"}}\n')
      .mockReturnValueOnce('{"type":"text","part":{"text":"{\\"ok\\":true}"}}\n');

    const result = await bridge.sendWork(
      {
        provider: 'openrouter',
        model: 'openrouter/google/gemini-3.5-flash',
        prompt: 'Return {"ok":true}',
        schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        env: { OPENROUTER_API_KEY: 'test-key' },
      },
      { execFileSync },
    );

    expect(result).toEqual({ ok: true });
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(String(execFileSync.mock.calls[1]?.[1]?.at(-1))).toContain('previous response was not valid JSON');
  });

  it('parses and validates codex output-last-message payloads', async () => {
    const execFileSync = vi.fn();
    const mkdtempSync = vi.fn().mockReturnValue('/tmp/runtime-bridge-test');
    const writeFileSync = vi.fn();
    const readFileSync = vi.fn((filePath: string) => {
      if (filePath.endsWith('output.json')) {
        return '{"ok":true,"provider":"codex"}';
      }
      return '';
    });
    const rmSync = vi.fn();

    const result = await bridge.sendWork(
      {
        provider: 'codex',
        model: 'gpt-5.4',
        prompt: 'Return {"ok":true,"provider":"codex"}',
        schema: {
          type: 'object',
          required: ['ok', 'provider'],
          properties: {
            ok: { type: 'boolean' },
            provider: { type: 'string' },
          },
        },
        cwd: '/tmp/worktree',
        allowWrite: true,
      },
      { execFileSync, mkdtempSync, writeFileSync, readFileSync, rmSync },
    );

    expect(result).toEqual({ ok: true, provider: 'codex' });
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(execFileSync.mock.calls[0]?.[1]).toContain('--model');
    expect(execFileSync.mock.calls[0]?.[1]).toContain('gpt-5.4');
    expect(execFileSync.mock.calls[0]?.[1]).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(rmSync).toHaveBeenCalledWith('/tmp/runtime-bridge-test', { recursive: true, force: true });
  });

  it('reports codex auth or model failures without silent fallback', async () => {
    const execFileSync = vi.fn(() => {
      const error = new Error('boom') as Error & { stderr?: string };
      error.stderr = 'The "gpt-5-codex" model is not supported when using Codex with a ChatGPT account.';
      throw error;
    });

    await expect(
      bridge.sendWork(
        {
          provider: 'codex',
          model: 'gpt-5-codex',
          prompt: 'Return {"ok":true}',
          schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        },
        {
          execFileSync,
          mkdtempSync: () => '/tmp/runtime-bridge-test',
          writeFileSync: vi.fn(),
          readFileSync: vi.fn(),
          rmSync: vi.fn(),
        },
      ),
    ).rejects.toThrow('model is not supported');
  });
});
