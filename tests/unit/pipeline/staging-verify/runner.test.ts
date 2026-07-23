import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExec, RailwayCli } from '../../../../src/pipeline/staging-verify/railway.js';
import {
  deployToStaging,
  runMigrateStage,
  runSeedStage,
  teardownDeployment,
} from '../../../../src/pipeline/staging-verify/deploy.js';
import { runLoop, type StageFns } from '../../../../src/pipeline/staging-verify/runner.js';
import type { RepoConfig, RunContext, StageOutcome } from '../../../../src/pipeline/staging-verify/types.js';

const repo: RepoConfig = {
  key: 'clearpath',
  localPath: '/tmp/clearpath',
  railwayProject: 'awake-recreation',
  stagingEnv: 'staging',
  prodEnvNames: ['production'],
  verifyCommand: 'npm test',
  migrateCommand: 'npm run db:push',
  healthPath: '/api/health',
};

function createCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    slug: 'slug',
    repo,
    buildOutputPath: 'feature-branch',
    buildOutputSha256: 'sha',
    attempt: 1,
    maxAttempts: 3,
    runner: 'staging-verify-loop',
    evidenceDir: '/tmp/staging-verify',
    keepDeploy: false,
    log: () => {},
    appliedArtifactPath: '/tmp/worktree',
    ...overrides,
  };
}

function ok(detail?: string): StageOutcome {
  return { kind: 'ok', detail };
}

function createStageFns(overrides: Partial<StageFns> = {}): StageFns {
  return {
    preflight: vi.fn(async () => ok()),
    apply: vi.fn(async () => ok()),
    deploy: vi.fn(async () => ok()),
    migrate: vi.fn(async () => ok()),
    seed: vi.fn(async () => ok()),
    drive: vi.fn(async () => ok()),
    readState: vi.fn(async () => ok()),
    verify: vi.fn(async () => ok()),
    evidence: vi.fn(async () => '/tmp/staging-verify/slug.json'),
    emit: vi.fn(async () => ({ ok: true, rowJson: '{"ok":true}' })),
    teardown: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runLoop', () => {
  it('records the full happy-path stage order, emits once, and tears down', async () => {
    const fns = createStageFns();
    const result = await runLoop(createCtx(), fns);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.ledgerRowJson).toBe('{"ok":true}');
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'preflight',
      'apply',
      'deploy',
      'migrate',
      'seed',
      'drive',
      'read-state',
      'verify',
      'evidence',
      'emit',
      'teardown',
    ]);
    expect(fns.emit).toHaveBeenCalledTimes(1);
    expect(fns.teardown).toHaveBeenCalledTimes(1);
  });

  it('rewinds transient deploy failures back to deploy without re-running apply', async () => {
    const deploy = vi.fn(async (ctx: RunContext) => (ctx.attempt < 3
      ? { kind: 'transient', detail: 'retry' }
      : { kind: 'ok' }) as StageOutcome);
    const fns = createStageFns({ deploy });

    const result = await runLoop(createCtx(), fns);

    expect(result.exitCode).toBe(0);
    expect(deploy).toHaveBeenCalledTimes(3);
    expect(fns.apply).toHaveBeenCalledTimes(1);
    expect(result.stages.filter((stage) => stage.stage === 'deploy')).toHaveLength(3);
  });

  it('writes failure evidence and exits 3 when a transient drive failure exhausts retries', async () => {
    const evidence = vi.fn(async () => '/tmp/staging-verify/slug.failed.json');
    const fns = createStageFns({
      drive: vi.fn(async () => ({ kind: 'transient', detail: '503' })),
      evidence,
    });

    const result = await runLoop(createCtx({ maxAttempts: 1 }), fns);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.evidencePath).toBe('/tmp/staging-verify/slug.failed.json');
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(fns.emit).not.toHaveBeenCalled();
  });

  it('writes failure evidence and exits 1 on fatal verify failures', async () => {
    const fns = createStageFns({
      verify: vi.fn(async () => ({ kind: 'fatal', detail: 'verify broke' })),
    });

    const result = await runLoop(createCtx(), fns);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(fns.emit).not.toHaveBeenCalled();
    expect(fns.teardown).toHaveBeenCalledTimes(1);
  });

  it('stops on preflight failure without evidence or teardown', async () => {
    const fns = createStageFns({
      preflight: vi.fn(async () => ({ kind: 'fatal', detail: 'missing review row' })),
    });

    const result = await runLoop(createCtx(), fns);

    expect(result.exitCode).toBe(2);
    expect(fns.evidence).not.toHaveBeenCalled();
    expect(fns.teardown).not.toHaveBeenCalled();
  });

  it('returns exit 4 when emit fails after successful evidence write', async () => {
    const fns = createStageFns({
      emit: vi.fn(async () => ({ ok: false, detail: 'CHAIN_BREAK' })),
    });

    const result = await runLoop(createCtx(), fns);

    expect(result.exitCode).toBe(4);
    expect(result.evidencePath).toBe('/tmp/staging-verify/slug.json');
  });

  it('skips teardown when keepDeploy is set', async () => {
    const fns = createStageFns();
    const result = await runLoop(createCtx({ keepDeploy: true }), fns);

    expect(result.exitCode).toBe(0);
    expect(fns.teardown).not.toHaveBeenCalled();
    expect(result.stages.at(-1)?.detail).toBe('skipped: keepDeploy');
  });
});

describe('railway and deploy helpers', () => {
  it('passes --environment staging on every mutating Railway command', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--json')) return { code: 0, stdout: '{"services":[]}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const cli = new RailwayCli({ exec, repo });

    await cli.up('/tmp/worktree', 'staging');
    await cli.statusJson('/tmp/worktree', 'staging');
    await cli.run('/tmp/worktree', 'staging', ['node', 'script.js']);
    await cli.serviceDelete('/tmp/worktree', 'staging');
    await cli.domain('/tmp/worktree', 'staging');

    expect(calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['--environment', 'staging']),
      expect.arrayContaining(['--environment', 'staging']),
      expect.arrayContaining(['--environment', 'staging']),
      expect.arrayContaining(['--environment', 'staging']),
      expect.arrayContaining(['--environment', 'staging']),
    ]));
  });

  it('refuses prod-like environments before exec', async () => {
    const exec = vi.fn();
    const cli = new RailwayCli({ exec, repo });
    await expect(cli.up('/tmp/worktree', 'production')).rejects.toThrow(/Unsafe Railway environment|prod-like environment/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('describes non-JSON Railway status output', async () => {
    const cli = new RailwayCli({
      exec: vi.fn(async () => ({ code: 0, stdout: 'not-json', stderr: '' })),
      repo,
    });

    await expect(cli.statusJson('/tmp/worktree', 'staging')).rejects.toThrow(/non-JSON output/);
  });

  it('classifies ETIMEDOUT deploys as transient and build failures as fatal', async () => {
    const transientExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'environment') return { code: 0, stdout: '["staging"]', stderr: '' };
      if (args[0] === 'up') return { code: 1, stdout: '', stderr: 'ETIMEDOUT' };
      return { code: 0, stdout: '{"services":[]}', stderr: '' };
    });
    const fatalExec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'environment') return { code: 0, stdout: '["staging"]', stderr: '' };
      if (args[0] === 'up') return { code: 1, stdout: '', stderr: 'Build failed' };
      return { code: 0, stdout: '{"services":[]}', stderr: '' };
    });

    const transient = await deployToStaging(createCtx(), {
      railway: new RailwayCli({ exec: transientExec, repo }),
      fetchImpl: vi.fn(),
      sleep: async () => {},
    });
    const fatal = await deployToStaging(createCtx(), {
      railway: new RailwayCli({ exec: fatalExec, repo }),
      fetchImpl: vi.fn(),
      sleep: async () => {},
    });

    expect(transient.kind).toBe('transient');
    expect(fatal.kind).toBe('fatal');
  });

  it('treats HTML health responses as transient and a later JSON health response as ok', async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'environment') return { code: 0, stdout: '["staging"]', stderr: '' };
      if (args[0] === 'up') return { code: 0, stdout: 'ok', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: '{"services":[{"domains":["https://staging.example.com"]}]}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const htmlOnly = vi.fn(async () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const healthy = vi.fn()
      .mockResolvedValueOnce(new Response('temporary', { status: 502 }))
      .mockResolvedValueOnce(new Response('temporary', { status: 502 }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const transient = await deployToStaging(createCtx(), {
      railway: new RailwayCli({ exec, repo }),
      fetchImpl: htmlOnly,
      sleep: async () => {},
    });
    const okResult = await deployToStaging(createCtx(), {
      railway: new RailwayCli({ exec, repo }),
      fetchImpl: healthy,
      sleep: async () => {},
    });

    expect(transient.kind).toBe('transient');
    expect(okResult.kind).toBe('ok');
    expect(okResult.detail).toBe('https://staging.example.com');
  });

  it('skips missing migrate commands, fails non-zero migrate exits, and blocks unsafe seed commands', async () => {
    const migrateSkip = await runMigrateStage(createCtx({
      repo: { ...repo, migrateCommand: undefined },
    }), {
      railway: new RailwayCli({ exec: vi.fn(), repo }),
    });

    const migrateFail = await runMigrateStage(createCtx(), {
      railway: new RailwayCli({
        exec: vi.fn(async (_cmd: string, args: string[]) => {
          if (args[0] === 'run') return { code: 1, stdout: '', stderr: 'migration failed' };
          return { code: 0, stdout: '', stderr: '' };
        }),
        repo,
      }),
    });

    const exec = vi.fn();
    const seedFail = await runSeedStage(createCtx({
      repo: { ...repo, seedCommand: 'pg_restore prod_dump' },
    }), {
      railway: new RailwayCli({ exec, repo }),
    });

    expect(migrateSkip).toEqual({ kind: 'ok', detail: 'skipped: no migrateCommand' });
    expect(migrateFail.kind).toBe('fatal');
    expect(seedFail.kind).toBe('fatal');
    expect(exec).not.toHaveBeenCalled();
  });

  it('swallows teardown errors and returns the timeout sentinel from defaultExec', async () => {
    await expect(teardownDeployment(createCtx(), {
      railway: new RailwayCli({
        exec: vi.fn(async () => {
          throw new Error('boom');
        }),
        repo,
      }),
      exec: vi.fn(async () => {
        throw new Error('boom');
      }),
    })).resolves.toBeUndefined();

    const exec = defaultExec();
    const result = await exec(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      cwd: process.cwd(),
      timeoutMs: 50,
    });
    expect(result.code).toBe(124);
  });
});
