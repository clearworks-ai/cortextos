import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { evidencePath, redact, writeEvidence } from '../../../../src/pipeline/staging-verify/evidence.js';
import type { RunContext, StagingVerifyEvidence } from '../../../../src/pipeline/staging-verify/types.js';

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
    log: () => {},
  };
}

function createEvidence(ok: boolean): StagingVerifyEvidence {
  return {
    schema: 'staging-verify-evidence/v1',
    slug: 'slug',
    ok,
    repo: '/Users/joshweiss/code/clearpath',
    staging_url: 'https://staging.example.com',
    verify_command: 'npm test',
    exit_code: ok ? 0 : -1,
    build_output_sha256: 'sha',
    assertions: [{ name: 'count', source: 'json-api', expected: 1, actual: 1, op: 'eq', pass: true, detail: '/api/state' }],
    build_output_kind: 'git-ref',
    applied_git_sha: 'abc123',
    railway_project: 'awake-recreation',
    staging_env: 'staging',
    attempts: 1,
    max_attempts: 3,
    scenario: ok ? 'fixture' : 'minimal',
    stages: [{ stage: 'verify', attempt: 1, startedAt: '2026-07-23T00:00:00.000Z', endedAt: '2026-07-23T00:01:00.000Z', outcome: 'ok' }],
    verify_output_tail: 'DATABASE_URL=postgres://user:pw@host/db\nBearer abc12345678',
    failure: ok ? undefined : { stage: 'verify', detail: 'broken' },
    started_at: '2026-07-23T00:00:00.000Z',
    finished_at: '2026-07-23T00:01:00.000Z',
    runner: 'staging-verify-loop',
    tool_version: '0.1.1',
  };
}

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.TEST_DATABASE_URL;
  delete process.env.TEST_API_SECRET;
  root = '';
});

describe('evidence writer', () => {
  it('writes atomic success evidence with the contract fields intact', () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-evidence-'));
    const ctx = createCtx(root);
    const path = writeEvidence(ctx, createEvidence(true));
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StagingVerifyEvidence;

    expect(path).toBe(evidencePath(ctx));
    expect(parsed).toMatchObject({
      repo: '/Users/joshweiss/code/clearpath',
      staging_url: 'https://staging.example.com',
      verify_command: 'npm test',
      exit_code: 0,
      build_output_sha256: 'sha',
    });
    expect(parsed.assertions[0]).toMatchObject({ expected: 1, actual: 1 });
    expect(readdirSync(root).some((entry) => entry.includes('.tmp-'))).toBe(false);
  });

  it('redacts secrets and writes failure variants to .failed.json', () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-evidence-fail-'));
    const ctx = createCtx(root);
    process.env.TEST_DATABASE_URL = 'postgres://user:pw@host/db';
    process.env.TEST_API_SECRET = 'abc12345678';

    const redacted = redact('DATABASE_URL=postgres://user:pw@host/db\nBearer abc12345678\nnpm test');
    const path = writeEvidence(ctx, createEvidence(false));

    expect(redacted).not.toContain('postgres://user:pw@host/db');
    expect(redacted).not.toContain('abc12345678');
    expect(redacted).toContain('npm test');
    expect(path).toBe(evidencePath(ctx, true));
    expect(existsSync(path)).toBe(true);
  });
});
