import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = join(__dirname, '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

type CommsFilterOutput = { emails: unknown[] };

let ctxRoot: string;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'comms-filter-'));
});

afterEach(() => {
  try {
    rmSync(ctxRoot, { recursive: true, force: true });
  } catch {
    // Ignore temp cleanup failures.
  }
});

function runCommsFilter(input: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [DIST_CLI, 'bus', 'comms-filter', ...args],
    {
      env: { ...process.env, CTX_ROOT: ctxRoot },
      encoding: 'utf-8',
      input,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseOutput(stdout: string): CommsFilterOutput {
  return JSON.parse(stdout) as CommsFilterOutput;
}

function readLedger(): Record<string, { firstSeenAt: number; fireOnce: boolean }> {
  return JSON.parse(
    readFileSync(join(ctxRoot, 'state', 'comms-event-dedup.json'), 'utf-8'),
  ) as Record<string, { firstSeenAt: number; fireOnce: boolean }>;
}

describe.skipIf(!existsSync(DIST_CLI))('bus comms-filter CLI', () => {
  it('surfaces both emails on the first call', () => {
    const result = runCommsFilter('{"emails":[{"id":"aaa"},{"id":"bbb"}]}');

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({ emails: [{ id: 'aaa' }, { id: 'bbb' }] });
    expect(result.stderr).toBe('');
  });

  it('suppresses the same emails on the second identical call', () => {
    runCommsFilter('{"emails":[{"id":"aaa"},{"id":"bbb"}]}');

    const second = runCommsFilter('{"emails":[{"id":"aaa"},{"id":"bbb"}]}');

    expect(second.status).toBe(0);
    expect(parseOutput(second.stdout)).toEqual({ emails: [] });
  });

  it('keeps only unseen emails in mixed input while preserving order', () => {
    runCommsFilter('{"emails":[{"id":"aaa"},{"id":"bbb"}]}');

    const result = runCommsFilter('{"emails":[{"id":"bbb"},{"id":"ccc"}]}');

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({ emails: [{ id: 'ccc' }] });
  });

  it('accepts a bare-array input shape', () => {
    const result = runCommsFilter('[{"id":"array-1"}]');

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({ emails: [{ id: 'array-1' }] });
  });

  it('passes through items with no id and warns without throwing', () => {
    const result = runCommsFilter('{"emails":[{"subject":"missing id"}]}');

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({ emails: [{ subject: 'missing id' }] });
    expect(result.stderr).toContain('missing string id/messageId');
  });

  it('returns empty emails for empty and malformed input while exiting cleanly', () => {
    const empty = runCommsFilter('{"emails":[]}');
    const malformed = runCommsFilter('{not json');

    expect(empty.status).toBe(0);
    expect(parseOutput(empty.stdout)).toEqual({ emails: [] });
    expect(empty.stderr).toBe('');

    expect(malformed.status).toBe(0);
    expect(parseOutput(malformed.stdout)).toEqual({ emails: [] });
    expect(malformed.stderr).toContain('failed to parse stdin JSON');
  });

  it('records fire-once entries in the ledger and skips them on the second call', () => {
    const first = runCommsFilter('{"emails":[{"id":"fire"}]}', ['--fire-once']);
    const second = runCommsFilter('{"emails":[{"id":"fire"}]}');

    expect(first.status).toBe(0);
    expect(parseOutput(first.stdout)).toEqual({ emails: [{ id: 'fire' }] });
    expect(readLedger()['gmail:fire']).toMatchObject({ fireOnce: true });

    expect(second.status).toBe(0);
    expect(parseOutput(second.stdout)).toEqual({ emails: [] });
  });

  it('treats namespaces as independent ledgers', () => {
    const gmail = runCommsFilter('{"emails":[{"id":"shared"}]}');
    const calendar = runCommsFilter('{"emails":[{"id":"shared"}]}', ['--namespace', 'calendar']);

    expect(gmail.status).toBe(0);
    expect(parseOutput(gmail.stdout)).toEqual({ emails: [{ id: 'shared' }] });

    expect(calendar.status).toBe(0);
    expect(parseOutput(calendar.stdout)).toEqual({ emails: [{ id: 'shared' }] });
    expect(readLedger()).toMatchObject({
      'gmail:shared': { fireOnce: false },
      'calendar:shared': { fireOnce: false },
    });
  });
});
