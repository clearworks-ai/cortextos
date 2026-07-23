import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { defaultExec, type ExecFn } from './railway.js';
import type { RunContext, StageOutcome, StagingVerifyEvidence } from './types.js';

export interface EmitDeps {
  exec: ExecFn;
  pipelineEmitBin: string;
}

function defaultPipelineEmitBin(): string {
  return join(resolve(__dirname, '../../..'), 'bin', 'pipeline-stage-emit');
}

function baseArgs(ctx: RunContext): string[] {
  const args = [];
  if (ctx.ledgerPath) args.push('--ledger', ctx.ledgerPath);
  if (ctx.secretPath) args.push('--secret', ctx.secretPath);
  return args;
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop() ?? '';
}

function detailForExitCode(code: number): string | undefined {
  if (code === 2) return 'SECRET_UNREADABLE';
  if (code === 3) return 'CHAIN_BREAK';
  if (code === 4) return 'EVIDENCE_MISSING';
  return undefined;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEvidence(path: string): { evidence?: StagingVerifyEvidence; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return {
      error: `unable to read evidence file ${path}: ${toMessage(error)}`,
    };
  }

  try {
    return {
      evidence: JSON.parse(raw) as StagingVerifyEvidence,
    };
  } catch {
    return {
      error: `evidence file ${path} is not valid JSON`,
    };
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

export async function preflightReviewRow(
  ctx: RunContext,
  deps: Partial<EmitDeps> = {},
): Promise<StageOutcome> {
  const exec = deps.exec ?? defaultExec();
  const pipelineEmitBin = deps.pipelineEmitBin ?? defaultPipelineEmitBin();
  const result = await exec(pipelineEmitBin, [
    '--verify',
    '--slug',
    ctx.slug,
    '--through',
    'review',
    '--max-age',
    '86400',
    ...baseArgs(ctx),
  ], {
    cwd: resolve(__dirname, '../../..'),
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    return {
      kind: 'fatal',
      detail: `no signed review row for ${ctx.slug} — staging-verify chains off review (src/pipeline/ledger.ts:346); run the review stage first`,
    };
  }
  return { kind: 'ok' };
}

export async function emitStagingVerify(
  ctx: RunContext,
  evidenceFile: string,
  deps: Partial<EmitDeps> = {},
): Promise<{ ok: boolean; rowJson?: string; detail?: string }> {
  const parsedEvidence = parseEvidence(evidenceFile);
  if (!parsedEvidence.evidence) {
    return { ok: false, detail: parsedEvidence.error ?? 'unable to parse evidence file' };
  }
  const evidence = parsedEvidence.evidence;
  if (evidence.ok !== true || evidence.exit_code !== 0 || evidence.assertions.some((assertion) => !assertion.pass)) {
    return { ok: false, detail: 'Evidence is not emit-safe' };
  }

  const exec = deps.exec ?? defaultExec();
  const pipelineEmitBin = deps.pipelineEmitBin ?? defaultPipelineEmitBin();
  const emitArgs = [
    '--slug',
    ctx.slug,
    '--stage',
    'staging-verify',
    '--artifact',
    ctx.appliedArtifactPath ?? ctx.buildOutputPath,
    '--evidence',
    evidenceFile,
    '--runner',
    ctx.runner,
    ...baseArgs(ctx),
  ];
  const emitResult = await exec(pipelineEmitBin, emitArgs, {
    cwd: resolve(__dirname, '../../..'),
    timeoutMs: 120_000,
  });
  if (emitResult.code !== 0) {
    const mapped = detailForExitCode(emitResult.code);
    return {
      ok: false,
      detail: `${mapped ?? 'EMIT_FAILED'} (exit ${emitResult.code}): ${(emitResult.stderr || emitResult.stdout).trim()}`,
    };
  }

  const verifyResult = await exec(pipelineEmitBin, [
    '--verify',
    '--slug',
    ctx.slug,
    '--through',
    'staging-verify',
    '--max-age',
    '86400',
    ...baseArgs(ctx),
  ], {
    cwd: resolve(__dirname, '../../..'),
    timeoutMs: 120_000,
  });
  if (verifyResult.code !== 0) {
    return {
      ok: false,
      detail: `self-verify failed: ${(verifyResult.stderr || verifyResult.stdout).trim()}`,
    };
  }

  let terminal: { evidence_path?: string };
  try {
    terminal = JSON.parse(lastLine(verifyResult.stdout)) as { evidence_path?: string };
  } catch {
    return {
      ok: false,
      detail: 'self-verify emitted non-JSON terminal line',
    };
  }

  if (!terminal.evidence_path || !nonEmptyFile(terminal.evidence_path)) {
    return {
      ok: false,
      detail: 'self-verify did not return a non-empty evidence_path',
    };
  }

  return {
    ok: true,
    rowJson: lastLine(emitResult.stdout),
  };
}
