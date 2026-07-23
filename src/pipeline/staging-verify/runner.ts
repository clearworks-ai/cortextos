import type { RunContext, RunResult, StageName, StageOutcome, StageRecord } from './types.js';

export interface StageFns {
  preflight(ctx: RunContext): Promise<StageOutcome>;
  apply(ctx: RunContext): Promise<StageOutcome>;
  deploy(ctx: RunContext): Promise<StageOutcome>;
  migrate(ctx: RunContext): Promise<StageOutcome>;
  seed(ctx: RunContext): Promise<StageOutcome>;
  drive(ctx: RunContext): Promise<StageOutcome>;
  readState(ctx: RunContext): Promise<StageOutcome>;
  verify(ctx: RunContext): Promise<StageOutcome>;
  evidence(ctx: RunContext, failure?: { stage: StageName; detail: string }): Promise<string>;
  emit(ctx: RunContext, evidencePath: string): Promise<{ ok: boolean; rowJson?: string; detail?: string }>;
  teardown(ctx: RunContext): Promise<void>;
}

const FORWARD_STAGES: StageName[] = ['apply', 'deploy', 'migrate', 'seed', 'drive', 'read-state', 'verify'];

function nowIso(): string {
  return new Date().toISOString();
}

function pushRecord(stages: StageRecord[], stage: StageName, attempt: number, startedAt: string, outcome: StageOutcome): void {
  stages.push({
    stage,
    attempt,
    startedAt,
    endedAt: nowIso(),
    outcome: outcome.kind,
    detail: outcome.detail,
  });
}

async function recordStage(
  ctx: RunContext,
  stages: StageRecord[],
  stage: StageName,
  fn: (ctx: RunContext) => Promise<StageOutcome>,
): Promise<StageOutcome> {
  const startedAt = nowIso();
  const outcome = await fn(ctx);
  pushRecord(stages, stage, ctx.attempt, startedAt, outcome);
  ctx.stageRecords = stages;
  return outcome;
}

function forwardStageFn(fns: StageFns, stage: StageName): (ctx: RunContext) => Promise<StageOutcome> {
  switch (stage) {
    case 'apply': return fns.apply;
    case 'deploy': return fns.deploy;
    case 'migrate': return fns.migrate;
    case 'seed': return fns.seed;
    case 'drive': return fns.drive;
    case 'read-state': return fns.readState;
    case 'verify': return fns.verify;
    default:
      throw new Error(`Unsupported forward stage ${stage}`);
  }
}

async function recordEvidence(
  ctx: RunContext,
  stages: StageRecord[],
  fns: StageFns,
  failure?: { stage: StageName; detail: string },
): Promise<string> {
  const startedAt = nowIso();
  const path = await fns.evidence(ctx, failure);
  pushRecord(stages, 'evidence', ctx.attempt, startedAt, { kind: 'ok', detail: path });
  ctx.stageRecords = stages;
  return path;
}

async function recordEmit(
  ctx: RunContext,
  stages: StageRecord[],
  fns: StageFns,
  evidencePath: string,
): Promise<{ ok: boolean; rowJson?: string; detail?: string }> {
  const startedAt = nowIso();
  const result = await fns.emit(ctx, evidencePath);
  pushRecord(stages, 'emit', ctx.attempt, startedAt, result.ok
    ? { kind: 'ok' }
    : { kind: 'fatal', detail: result.detail ?? 'emit failed' });
  ctx.stageRecords = stages;
  return result;
}

async function recordTeardown(ctx: RunContext, stages: StageRecord[], fns: StageFns): Promise<void> {
  const startedAt = nowIso();
  try {
    await fns.teardown(ctx);
    pushRecord(stages, 'teardown', ctx.attempt, startedAt, { kind: 'ok' });
  } catch (error) {
    pushRecord(stages, 'teardown', ctx.attempt, startedAt, {
      kind: 'ok',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  ctx.stageRecords = stages;
}

export async function runLoop(ctx: RunContext, fns: StageFns): Promise<RunResult> {
  const stages: StageRecord[] = [];
  ctx.startedAt = ctx.startedAt ?? nowIso();
  let reachedDeploy = false;
  let evidencePath: string | undefined;

  try {
    const preflight = await recordStage(ctx, stages, 'preflight', fns.preflight);
    if (preflight.kind !== 'ok') {
      return {
        ok: false,
        exitCode: 2,
        stages,
      };
    }

    let stageIndex = 0;
    while (stageIndex < FORWARD_STAGES.length) {
      const stage = FORWARD_STAGES[stageIndex];
      if (stage === 'deploy') reachedDeploy = true;
      const outcome = await recordStage(ctx, stages, stage, forwardStageFn(fns, stage));
      if (outcome.kind === 'ok') {
        stageIndex += 1;
        continue;
      }
      if (outcome.kind === 'transient') {
        if (ctx.attempt >= ctx.maxAttempts) {
          evidencePath = await recordEvidence(ctx, stages, fns, {
            stage,
            detail: outcome.detail,
          });
          return {
            ok: false,
            exitCode: 3,
            evidencePath,
            stages,
          };
        }
        ctx.attempt += 1;
        stageIndex = FORWARD_STAGES.indexOf('deploy');
        continue;
      }
      evidencePath = await recordEvidence(ctx, stages, fns, {
        stage,
        detail: outcome.detail,
      });
      return {
        ok: false,
        exitCode: 1,
        evidencePath,
        stages,
      };
    }

    evidencePath = await recordEvidence(ctx, stages, fns);
    const emit = await recordEmit(ctx, stages, fns, evidencePath);
    if (!emit.ok) {
      return {
        ok: false,
        exitCode: 4,
        evidencePath,
        stages,
      };
    }

    return {
      ok: true,
      exitCode: 0,
      evidencePath,
      ledgerRowJson: emit.rowJson,
      stages,
    };
  } finally {
    if (reachedDeploy && !ctx.keepDeploy) {
      await recordTeardown(ctx, stages, fns);
    } else if (reachedDeploy && ctx.keepDeploy) {
      const startedAt = nowIso();
      pushRecord(stages, 'teardown', ctx.attempt, startedAt, { kind: 'ok', detail: 'skipped: keepDeploy' });
      ctx.stageRecords = stages;
    }
  }
}
