import { spawn } from 'child_process';
import type { RepoConfig } from './types.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePlainEnvironmentOutput(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^environments?/i.test(line));
}

function parseEnvironmentList(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
            return String((entry as Record<string, unknown>).name);
          }
          return '';
        })
        .filter((entry) => entry.length > 0);
    }
  } catch {
    // Fall back to the CLI's plain-text output.
  }
  return normalizePlainEnvironmentOutput(trimmed);
}

function assertSafeEnvironment(env: string, repo?: Pick<RepoConfig, 'stagingEnv' | 'prodEnvNames'>): void {
  if (!repo) return;
  if (env !== repo.stagingEnv) {
    throw new Error(`Unsafe Railway environment '${env}' for ${repo.stagingEnv} staging run`);
  }
  if (repo.prodEnvNames.includes(env)) {
    throw new Error(`Refusing Railway action against prod-like environment '${env}'`);
  }
}

export function defaultExec(): ExecFn {
  return (cmd, args, opts) => new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
      });
    };

    const timer = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 250).unref();
      }, opts.timeoutMs)
      : undefined;

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${toMessage(error)}`;
      finish(1);
    });
    child.on('close', (code) => {
      finish(timedOut ? 124 : (code ?? 0));
    });
  });
}

export class RailwayCli {
  private readonly exec: ExecFn;
  private readonly binary: string;
  private readonly repo?: Pick<RepoConfig, 'stagingEnv' | 'prodEnvNames'>;

  constructor(opts: { exec?: ExecFn; binary?: string; repo?: Pick<RepoConfig, 'stagingEnv' | 'prodEnvNames'> } = {}) {
    this.exec = opts.exec ?? defaultExec();
    this.binary = opts.binary ?? 'railway';
    this.repo = opts.repo;
  }

  async environmentList(cwd: string): Promise<string[]> {
    const result = await this.exec(this.binary, ['environment', 'list', '--json'], {
      cwd,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      const fallback = await this.exec(this.binary, ['environment', 'list'], {
        cwd,
        timeoutMs: 60_000,
      });
      if (fallback.code !== 0) {
        throw new Error(`railway environment list failed: ${fallback.stderr || fallback.stdout}`.trim());
      }
      return parseEnvironmentList(fallback.stdout);
    }
    return parseEnvironmentList(result.stdout);
  }

  async up(cwd: string, env: string): Promise<{ ok: boolean; detail: string }> {
    assertSafeEnvironment(env, this.repo);
    const result = await this.exec(this.binary, ['up', '--ci', '--environment', env], {
      cwd,
      timeoutMs: 600_000,
    });
    const detail = (result.stderr || result.stdout || '').trim();
    return {
      ok: result.code === 0,
      detail,
    };
  }

  async statusJson(cwd: string, env: string): Promise<unknown> {
    assertSafeEnvironment(env, this.repo);
    const result = await this.exec(this.binary, ['status', '--json', '--environment', env], {
      cwd,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new Error(`railway status failed: ${result.stderr || result.stdout}`.trim());
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('railway status emitted non-JSON output');
    }
  }

  async run(cwd: string, env: string, command: string[]): Promise<ExecResult> {
    assertSafeEnvironment(env, this.repo);
    return this.exec(this.binary, ['run', '--environment', env, '--', ...command], {
      cwd,
      timeoutMs: 300_000,
    });
  }

  async serviceDelete(cwd: string, env: string): Promise<ExecResult> {
    assertSafeEnvironment(env, this.repo);
    return this.exec(this.binary, ['down', '--environment', env, '--yes'], {
      cwd,
      timeoutMs: 60_000,
    });
  }

  async domain(cwd: string, env: string): Promise<ExecResult> {
    assertSafeEnvironment(env, this.repo);
    return this.exec(this.binary, ['domain', '--environment', env], {
      cwd,
      timeoutMs: 60_000,
    });
  }
}
