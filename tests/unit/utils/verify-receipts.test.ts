import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
  writeVerifyReceipt,
  findFreshReceipt,
  verifyReceiptsDir,
  MAX_OUTPUT_BYTES,
  type VerifyReceipt,
} from '../../../src/utils/verify-receipts';

let ctxRoot: string;
const AGENT = 'larry';

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'verify-receipts-'));
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

function makeReceipt(overrides: Partial<VerifyReceipt> = {}): VerifyReceipt {
  return {
    kind: 'generic',
    target: 'the dashboard fix',
    command: 'npm test',
    output: 'all green',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('writeVerifyReceipt', () => {
  it('writes the receipt to state/<agent>/verify-receipts with <epochms>-<slug>.json name', () => {
    const path = writeVerifyReceipt(ctxRoot, AGENT, makeReceipt({ target: 'https://briefs.clearworks.ai/x' }));

    expect(path.startsWith(verifyReceiptsDir(ctxRoot, AGENT))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(basename(path)).toMatch(/^\d+-https-briefs-clearworks-ai-x\.json$/);

    const stored = JSON.parse(readFileSync(path, 'utf-8')) as VerifyReceipt;
    expect(stored.kind).toBe('generic');
    expect(stored.target).toBe('https://briefs.clearworks.ai/x');
    expect(stored.command).toBe('npm test');
    expect(stored.output).toBe('all green');
  });

  it('truncates output to 2KB', () => {
    const path = writeVerifyReceipt(ctxRoot, AGENT, makeReceipt({ output: 'x'.repeat(MAX_OUTPUT_BYTES + 500) }));
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as VerifyReceipt;
    expect(stored.output.length).toBe(MAX_OUTPUT_BYTES);
  });
});

describe('findFreshReceipt', () => {
  it('returns null when the store does not exist', () => {
    expect(findFreshReceipt(ctxRoot, AGENT)).toBeNull();
  });

  it('returns a fresh receipt', () => {
    writeVerifyReceipt(ctxRoot, AGENT, makeReceipt());
    const found = findFreshReceipt(ctxRoot, AGENT);
    expect(found).not.toBeNull();
    expect(found!.target).toBe('the dashboard fix');
  });

  it('returns null for a receipt older than maxAgeMs (16 minutes vs 15 default)', () => {
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    writeVerifyReceipt(ctxRoot, AGENT, makeReceipt({ created_at: old }));
    expect(findFreshReceipt(ctxRoot, AGENT)).toBeNull();
  });

  it('honors a custom maxAgeMs', () => {
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    writeVerifyReceipt(ctxRoot, AGENT, makeReceipt({ created_at: old }));
    expect(findFreshReceipt(ctxRoot, AGENT, { maxAgeMs: 60 * 60_000 })).not.toBeNull();
  });

  it('filters by kind', () => {
    writeVerifyReceipt(ctxRoot, AGENT, makeReceipt({ kind: 'deploy', target: 'railway prod' }));
    expect(findFreshReceipt(ctxRoot, AGENT, { kind: 'url' })).toBeNull();
    expect(findFreshReceipt(ctxRoot, AGENT, { kind: 'deploy' })!.target).toBe('railway prod');
  });

  it('for kind:url the target must match the exact URL', () => {
    writeVerifyReceipt(
      ctxRoot,
      AGENT,
      makeReceipt({ kind: 'url', target: 'https://briefs.clearworks.ai/abc?token=1' })
    );
    expect(
      findFreshReceipt(ctxRoot, AGENT, { kind: 'url', target: 'https://briefs.clearworks.ai/abc?token=1' })
    ).not.toBeNull();
    expect(
      findFreshReceipt(ctxRoot, AGENT, { kind: 'url', target: 'https://briefs.clearworks.ai/other' })
    ).toBeNull();
  });

  it('returns the newest matching receipt', () => {
    writeVerifyReceipt(
      ctxRoot,
      AGENT,
      makeReceipt({ target: 'older', created_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    );
    writeVerifyReceipt(
      ctxRoot,
      AGENT,
      makeReceipt({ target: 'newer', created_at: new Date(Date.now() - 1 * 60_000).toISOString() })
    );
    expect(findFreshReceipt(ctxRoot, AGENT)!.target).toBe('newer');
  });

  it('is scoped per-agent', () => {
    writeVerifyReceipt(ctxRoot, AGENT, makeReceipt());
    expect(findFreshReceipt(ctxRoot, 'frank2')).toBeNull();
  });

  it('ignores malformed receipt files instead of throwing', () => {
    const dir = verifyReceiptsDir(ctxRoot, AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '123-garbage.json'), 'not json{{{', 'utf-8');
    writeFileSync(join(dir, '456-wrong-shape.json'), JSON.stringify({ kind: 'bogus' }), 'utf-8');
    expect(findFreshReceipt(ctxRoot, AGENT)).toBeNull();

    writeVerifyReceipt(ctxRoot, AGENT, makeReceipt());
    expect(findFreshReceipt(ctxRoot, AGENT)).not.toBeNull();
  });
});
