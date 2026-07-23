import { defaultExec, type ExecFn } from './railway.js';
import { splitCommand } from './deploy.js';
import type { RunContext, StageOutcome } from './types.js';

function tailLines(text: string, limit: number): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(lines.length - limit, 0)).join('\n');
}

export async function runVerifyCommand(
  ctx: RunContext,
  deps: { exec: ExecFn; worktree: string },
): Promise<{ outcome: StageOutcome; exitCode: number; command: string; tailOutput: string }> {
  const command = ctx.repo.verifyCommand;
  const parts = splitCommand(command);
  const exec = deps.exec ?? defaultExec();
  const result = await exec(parts[0], parts.slice(1), {
    cwd: deps.worktree,
    timeoutMs: 900_000,
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const tailOutput = tailLines(combined, 50);

  if (result.code === 124) {
    return {
      outcome: { kind: 'transient', detail: `${command} timed out` },
      exitCode: result.code,
      command,
      tailOutput,
    };
  }
  if (result.code !== 0) {
    return {
      outcome: { kind: 'fatal', detail: `${command} exited ${result.code}` },
      exitCode: result.code,
      command,
      tailOutput,
    };
  }
  return {
    outcome: { kind: 'ok' },
    exitCode: result.code,
    command,
    tailOutput,
  };
}
