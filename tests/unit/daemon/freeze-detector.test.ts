import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  findPermissionSignature,
  detectFrozenPermission,
  writeFrozenFlag,
  clearFrozenFlag,
  listFrozenAgents,
  frozenFlagDir,
  frozenFlagPath,
} from '../../../src/daemon/freeze-detector.js';

// Tests hit the real filesystem under a unique tmp ctxRoot because the
// freeze detector's flag I/O uses sync fs + atomicWriteSync with no DI.

function makeCtxRoot(): string {
  const dir = join(tmpdir(), `freeze-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('freeze-detector signature matching', () => {
  it('matches numbered "Yes" option', () => {
    const buf = 'Running command...\n❯ 1. Yes\n  2. No';
    const { matched, excerpt } = findPermissionSignature(buf);
    expect(matched).toBe(true);
    expect(excerpt).toContain('1. Yes');
  });

  it('matches numbered "Allow" / "Deny" pair', () => {
    const buf = 'Tool request: run bash\n❯ 1. Allow\n  2. Deny';
    const { matched } = findPermissionSignature(buf);
    expect(matched).toBe(true);
  });

  it('does NOT match the phrase "Do you want to proceed" — too broad (per Sage audit)', () => {
    // If an agent's own response mentions the phrase, we must not flag it.
    // Only the concrete numbered-option UI is a valid signature.
    const buf = 'Here is the documentation: "Do you want to proceed with the migration?"';
    const { matched } = findPermissionSignature(buf);
    expect(matched).toBe(false);
  });

  it('does NOT match a plain word "Allow" inside prose', () => {
    const buf = 'Allow me to explain the plan before proceeding.';
    const { matched } = findPermissionSignature(buf);
    expect(matched).toBe(false);
  });

  it('strips ANSI escapes before matching', () => {
    const buf = '\x1b[32m❯\x1b[0m \x1b[1m1. Yes\x1b[0m';
    const { matched } = findPermissionSignature(buf);
    expect(matched).toBe(true);
  });

  it('excerpt includes surrounding context for operator review', () => {
    const pre = 'Writing to /etc/hosts — this is a privileged operation.\n';
    const buf = pre + '❯ 1. Allow\n  2. Deny';
    const { excerpt } = findPermissionSignature(buf);
    expect(excerpt).toContain('/etc/hosts');
  });
});

describe('freeze-detector staleness decision', () => {
  it('returns null when signature is absent regardless of output staleness', () => {
    const result = detectFrozenPermission({
      agentName: 'larry',
      recentBuffer: 'normal agent output\n',
      lastSubstantiveOutputTs: 0,
      nowTs: Date.now(),
      thresholdSec: 180,
    });
    expect(result).toBeNull();
  });

  it('returns null when signature is present but output is still fresh', () => {
    const now = Date.now();
    const result = detectFrozenPermission({
      agentName: 'larry',
      recentBuffer: '❯ 1. Allow\n  2. Deny',
      lastSubstantiveOutputTs: now - 30_000, // 30s ago — under threshold
      nowTs: now,
      thresholdSec: 180,
    });
    expect(result).toBeNull();
  });

  it('returns FrozenState when signature is present and output is stale', () => {
    const now = Date.now();
    const result = detectFrozenPermission({
      agentName: 'larry',
      recentBuffer: 'Deploy to prod?\n❯ 1. Yes\n  2. No',
      lastSubstantiveOutputTs: now - 200_000, // > 180s
      nowTs: now,
      thresholdSec: 180,
    });
    expect(result).not.toBeNull();
    expect(result?.agent_name).toBe('larry');
    expect(result?.prompt_excerpt).toContain('Deploy to prod');
    expect(result?.detected_at).toBe(Math.floor(now / 1000));
  });

  it('honors custom thresholdSec for a strict agent', () => {
    const now = Date.now();
    const buf = '❯ 1. Allow\n  2. Deny';
    // 60s stale, 30s threshold → should fire
    const fires = detectFrozenPermission({
      agentName: 'x',
      recentBuffer: buf,
      lastSubstantiveOutputTs: now - 60_000,
      nowTs: now,
      thresholdSec: 30,
    });
    expect(fires).not.toBeNull();
    // 60s stale, 120s threshold → should NOT fire
    const silent = detectFrozenPermission({
      agentName: 'x',
      recentBuffer: buf,
      lastSubstantiveOutputTs: now - 60_000,
      nowTs: now,
      thresholdSec: 120,
    });
    expect(silent).toBeNull();
  });

  it('Sage audit case: heartbeat-sized output (<50 chars) must not look like progress', () => {
    // This test asserts a property enforced upstream in OutputBuffer: only
    // pushes > 50 chars bump lastSubstantivePushTs. Verified separately in
    // output-buffer.test.ts. Here we just confirm the detector trusts that
    // timestamp literally — if it's stale, we flag regardless of "noise"
    // that might have landed afterward.
    const now = Date.now();
    const result = detectFrozenPermission({
      agentName: 'larry',
      recentBuffer: '❯ 1. Allow\n  2. Deny\n.', // trailing dot is heartbeat noise
      lastSubstantiveOutputTs: now - 240_000, // caller confirms output is stale
      nowTs: now,
      thresholdSec: 180,
    });
    expect(result).not.toBeNull();
  });
});

describe('freeze-detector flag I/O', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = makeCtxRoot();
  });

  afterEach(() => {
    try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writeFrozenFlag creates centralized dir and persists state', () => {
    writeFrozenFlag(ctxRoot, {
      detected_at: 1000,
      prompt_excerpt: 'deploy?',
      agent_name: 'hunter',
    });
    const path = frozenFlagPath(ctxRoot, 'hunter');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.agent_name).toBe('hunter');
    expect(parsed.detected_at).toBe(1000);
    expect(frozenFlagDir(ctxRoot)).toBe(join(ctxRoot, 'state', 'frozen-permissions'));
  });

  it('clearFrozenFlag removes the flag', () => {
    writeFrozenFlag(ctxRoot, {
      detected_at: 1000,
      prompt_excerpt: 'x',
      agent_name: 'larry',
    });
    expect(existsSync(frozenFlagPath(ctxRoot, 'larry'))).toBe(true);
    clearFrozenFlag(ctxRoot, 'larry');
    expect(existsSync(frozenFlagPath(ctxRoot, 'larry'))).toBe(false);
  });

  it('clearFrozenFlag is a no-op when flag does not exist (no throw)', () => {
    expect(() => clearFrozenFlag(ctxRoot, 'ghost')).not.toThrow();
  });

  it('listFrozenAgents returns empty array when no dir exists', () => {
    expect(listFrozenAgents(ctxRoot)).toEqual([]);
  });

  it('listFrozenAgents returns all valid flags across agents', () => {
    writeFrozenFlag(ctxRoot, { detected_at: 1, prompt_excerpt: 'a', agent_name: 'larry' });
    writeFrozenFlag(ctxRoot, { detected_at: 2, prompt_excerpt: 'b', agent_name: 'hunter' });
    const frozen = listFrozenAgents(ctxRoot);
    expect(frozen).toHaveLength(2);
    const names = frozen.map((f) => f.agent_name).sort();
    expect(names).toEqual(['hunter', 'larry']);
  });

  it('listFrozenAgents skips corrupt flag files — does not throw', () => {
    // Sage audit case: a partial/garbage flag must not break the CLI for
    // the remaining valid flags. We need the heartbeat cron to stay alive.
    mkdirSync(frozenFlagDir(ctxRoot), { recursive: true });
    writeFileSync(frozenFlagPath(ctxRoot, 'broken'), '{ not valid json', 'utf-8');
    writeFrozenFlag(ctxRoot, { detected_at: 5, prompt_excerpt: 'ok', agent_name: 'good' });

    const frozen = listFrozenAgents(ctxRoot);
    expect(frozen).toHaveLength(1);
    expect(frozen[0].agent_name).toBe('good');
  });

  it('listFrozenAgents skips flags missing required fields', () => {
    mkdirSync(frozenFlagDir(ctxRoot), { recursive: true });
    writeFileSync(
      frozenFlagPath(ctxRoot, 'partial'),
      JSON.stringify({ agent_name: 'partial' }),
      'utf-8',
    );
    expect(listFrozenAgents(ctxRoot)).toEqual([]);
  });

  it('overwriting a flag preserves atomicity — last write wins', () => {
    // Sage audit case: consecutive detections (same prompt still stuck after
    // N polls) must not stack. One alert, overwrite in place.
    writeFrozenFlag(ctxRoot, { detected_at: 1, prompt_excerpt: 'old', agent_name: 'larry' });
    writeFrozenFlag(ctxRoot, { detected_at: 2, prompt_excerpt: 'new', agent_name: 'larry' });
    const frozen = listFrozenAgents(ctxRoot);
    expect(frozen).toHaveLength(1);
    expect(frozen[0].prompt_excerpt).toBe('new');
    expect(frozen[0].detected_at).toBe(2);
  });

  it('writeFrozenFlag creates parent dir if missing', () => {
    // ctxRoot exists but state/frozen-permissions does not yet — atomicWriteSync
    // must mkdir the parent.
    const freshCtx = makeCtxRoot();
    try {
      writeFrozenFlag(freshCtx, {
        detected_at: 1,
        prompt_excerpt: 'x',
        agent_name: 'new',
      });
      expect(existsSync(frozenFlagPath(freshCtx, 'new'))).toBe(true);
    } finally {
      rmSync(freshCtx, { recursive: true, force: true });
    }
  });
});
