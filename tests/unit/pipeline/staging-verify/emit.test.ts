import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitStagingVerify, preflightReviewRow } from '../../../../src/pipeline/staging-verify/emit.js';
import type { RunContext } from '../../../../src/pipeline/staging-verify/types.js';

function createCtx(root: string): RunContext {
  return {
    slug: 'slug',
    repo: {
      key: 'clearpath',
      localPath: '/Users/joshweiss/code/clearpath',
      railwayProject: 'awake-recreation',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'npm test',
      healthPath: '/api/health',
    },
    buildOutputPath: 'feature-branch',
    buildOutputSha256: 'sha',
    attempt: 1,
    maxAttempts: 3,
    runner: 'staging-verify-loop',
    evidenceDir: root,
    keepDeploy: false,
    ledgerPath: join(root, 'ledger.jsonl'),
    secretPath: join(root, '.pipeline-secret'),
    log: () => {},
    appliedArtifactPath: '/tmp/worktree',
  };
}

function writeEvidence(root: string, ok = true): string {
  const path = join(root, 'slug.json');
  writeFileSync(path, JSON.stringify({
    schema: 'staging-verify-evidence/v1',
    slug: 'slug',
    ok,
    repo: '/Users/joshweiss/code/clearpath',
    staging_url: 'https://staging.example.com',
    verify_command: 'npm test',
    exit_code: ok ? 0 : 1,
    build_output_sha256: 'sha',
    assertions: [{ name: 'count', source: 'json-api', expected: 1, actual: ok ? 1 : 0, op: 'eq', pass: ok }],
    build_output_kind: 'git-ref',
    applied_git_sha: 'abc123',
    railway_project: 'awake-recreation',
    staging_env: 'staging',
    attempts: 1,
    max_attempts: 3,
    scenario: 'fixture',
    stages: [],
    verify_output_tail: '',
    started_at: '2026-07-23T00:00:00.000Z',
    finished_at: '2026-07-23T00:00:01.000Z',
    runner: 'staging-verify-loop',
    tool_version: '0.1.1',
  }), 'utf-8');
  return path;
}

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('emit helpers', () => {
  it('fails preflight when the review row is missing', async () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-emit-preflight-'));
    const outcome = await preflightReviewRow(createCtx(root), {
      exec: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'NO_ROWS' })),
      pipelineEmitBin: '/tmp/pipeline-stage-emit',
    });

    expect(outcome.kind).toBe('fatal');
    expect(outcome.detail).toContain('review stage first');
  });

  it('refuses emit when the evidence is not fully successful', async () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-emit-guard-'));
    const evidence = writeEvidence(root, false);
    const exec = vi.fn();

    const result = await emitStagingVerify(createCtx(root), evidence, {
      exec,
      pipelineEmitBin: '/tmp/pipeline-stage-emit',
    });

    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('constructs emit args without transcript/session flags and maps CHAIN_BREAK exit codes', async () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-emit-args-'));
    const evidence = writeEvidence(root, true);
    const calls: string[][] = [];
    const successExec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--verify')) {
        return { code: 0, stdout: JSON.stringify({ evidence_path: evidence }), stderr: '' };
      }
      return { code: 0, stdout: '{"stage":"staging-verify"}', stderr: '' };
    });

    const success = await emitStagingVerify(createCtx(root), evidence, {
      exec: successExec,
      pipelineEmitBin: '/tmp/pipeline-stage-emit',
    });

    expect(success.ok).toBe(true);
    expect(calls[0]).toEqual(expect.arrayContaining([
      '--stage',
      'staging-verify',
      '--evidence',
      evidence,
      '--runner',
      'staging-verify-loop',
    ]));
    expect(calls[0]).not.toContain('--transcript');
    expect(calls[0]).not.toContain('--session');

    const chainBreak = await emitStagingVerify(createCtx(root), evidence, {
      exec: vi.fn(async () => ({ code: 3, stdout: '', stderr: 'CHAIN_BREAK' })),
      pipelineEmitBin: '/tmp/pipeline-stage-emit',
    });
    expect(chainBreak.detail).toContain('CHAIN_BREAK');
  });

  it('fails cleanly when evidence is unreadable or self-verify emits non-JSON', async () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-emit-hardening-'));
    const missingEvidence = join(root, 'missing.json');

    const missing = await emitStagingVerify(createCtx(root), missingEvidence, {
      exec: vi.fn(),
      pipelineEmitBin: '/tmp/pipeline-stage-emit',
    });

    expect(missing).toMatchObject({
      ok: false,
      detail: expect.stringContaining('unable to read evidence file'),
    });

    const evidence = writeEvidence(root, true);
    const nonJson = await emitStagingVerify(createCtx(root), evidence, {
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('--verify')) {
          return { code: 0, stdout: 'not-json\n', stderr: '' };
        }
        return { code: 0, stdout: '{"stage":"staging-verify"}', stderr: '' };
      }),
      pipelineEmitBin: '/tmp/pipeline-stage-emit',
    });

    expect(nonJson).toEqual({
      ok: false,
      detail: 'self-verify emitted non-JSON terminal line',
    });
  });
});
