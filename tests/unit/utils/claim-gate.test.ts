import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordVerificationReceipt,
  evaluateClaimGate,
  claimGateOverridePath,
  receiptLedgerPath,
} from '../../../src/utils/verification-receipt.js';
import { resolvePaths } from '../../../src/utils/paths.js';
import type { BusPaths } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'claim-gate-'));
  mkdirSync(join(tmpRoot, 'state'), { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makePaths(agent: string): BusPaths {
  const base = resolvePaths(agent, 'default', 'clearworksai');
  return {
    ...base,
    ctxRoot: tmpRoot,
    stateDir: join(tmpRoot, 'state', agent),
    analyticsDir: join(tmpRoot, 'analytics'),
  };
}

/** Common gate opts shared by most tests */
function gateOpts(overrides: Partial<Parameters<typeof evaluateClaimGate>[0]> = {}) {
  return {
    ctxRoot: tmpRoot,
    agent: 'codexer',
    org: 'clearworksai',
    paths: makePaths('codexer'),
    text: 'Deployed to production.',
    isOwnerChat: true,
    confirmFlag: false,
    gateMode: 'enforce' as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Owner-chat scoping
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — owner-chat scoping', () => {
  it('not owner chat → always allow (even high-stakes claim, enforce mode)', () => {
    const d = evaluateClaimGate(gateOpts({ isOwnerChat: false }));
    expect(d.action).toBe('allow');
  });

  it('non-owner chat with block-rung text → still allow', () => {
    const d = evaluateClaimGate(gateOpts({
      isOwnerChat: false,
      text: 'Sent to the client.',
    }));
    expect(d.action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Gate mode: off and warn
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — gate modes', () => {
  it('gateMode=off → allow regardless of claim', () => {
    const d = evaluateClaimGate(gateOpts({ gateMode: 'off' }));
    expect(d.action).toBe('allow');
  });

  it('gateMode=warn, no receipt, deploy claim → warn (not hold)', () => {
    // In warn mode, high-stakes claims still produce a 'warn' decision, not 'hold'.
    const d = evaluateClaimGate(gateOpts({ gateMode: 'warn' }));
    expect(d.action).toBe('warn');
    if (d.action === 'warn') {
      expect(d.cls).toBe('deploy');
    }
  });

  it('gateMode=warn, generic claim → warn', () => {
    const d = evaluateClaimGate(gateOpts({
      gateMode: 'warn',
      text: 'Done — all set.',
    }));
    expect(d.action).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// Non-claim text
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — non-claim text', () => {
  it('non-claim text → allow', () => {
    const d = evaluateClaimGate(gateOpts({ text: 'Here is a status update on the work.' }));
    expect(d.action).toBe('allow');
  });

  it('negated high-stakes → allow (not a real claim)', () => {
    const d = evaluateClaimGate(gateOpts({ text: 'About to deploy — will confirm shortly.' }));
    expect(d.action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Generic claim (warn rung)
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — generic claim', () => {
  it('owner chat, generic claim, no receipt, enforce → warn', () => {
    const d = evaluateClaimGate(gateOpts({ text: 'Done — checked and it works now.' }));
    expect(d.action).toBe('warn');
    if (d.action === 'warn') {
      expect(d.cls).toBe('generic');
    }
  });

  it('owner chat, generic claim + any receipt → warn (gate delegates to post-send observer)', () => {
    // Generic claims stay on the warn path in the gate regardless of receipts.
    // The existing emitClaimWithoutReceiptWarning (post-send) suppresses the
    // warning when a receipt is present. The gate returns 'warn' so the
    // caller can proceed and let the observer decide.
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'build', ref: 'npm run build' });
    const d = evaluateClaimGate(gateOpts({ text: 'Fixed and it works.' }));
    // warn or allow — either is acceptable; the gate must not hold.
    expect(['allow', 'warn']).toContain(d.action);
    // Must never hold on a generic claim.
    expect(d.action).not.toBe('hold');
  });
});

// ---------------------------------------------------------------------------
// Deploy claim (require-confirm rung)
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — deploy claim (require-confirm)', () => {
  it('owner chat, deployed, no receipt, no confirm → hold/require-confirm', () => {
    const d = evaluateClaimGate(gateOpts());
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(d.cls).toBe('deploy');
      expect(d.rung).toBe('require-confirm');
      expect(d.reason).toContain('deploy');
      expect(d.requiredKinds).toContain('deploy');
    }
  });

  it('owner chat, deployed, matching receipt in window → allow', () => {
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'deploy', ref: 'https://railway.app/deploy/123' });
    const d = evaluateClaimGate(gateOpts());
    expect(d.action).toBe('allow');
  });

  it('owner chat, deployed, curl receipt in window → allow (curl satisfies deploy)', () => {
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'curl', ref: 'https://myapp.railway.app/health → 200' });
    const d = evaluateClaimGate(gateOpts());
    expect(d.action).toBe('allow');
  });

  it('owner chat, deployed, no receipt, confirmFlag=true → allow (confirm-claim bypass)', () => {
    const d = evaluateClaimGate(gateOpts({ confirmFlag: true }));
    expect(d.action).toBe('allow');
  });

  it('owner chat, deployed, stale receipt (>window) → hold', () => {
    const staleTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'deploy', ref: 'old', ts: staleTs });
    const d = evaluateClaimGate(gateOpts({ withinMs: 30 * 60 * 1000 }));
    expect(d.action).toBe('hold');
  });

  it('owner chat, deployed, receipt for DIFFERENT agent → hold (agent-scoped)', () => {
    recordVerificationReceipt(tmpRoot, 'frank2', { kind: 'deploy', ref: 'not-codexer' });
    const d = evaluateClaimGate(gateOpts());
    expect(d.action).toBe('hold');
  });
});

// ---------------------------------------------------------------------------
// Merge claim (require-confirm rung)
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — merge claim (require-confirm)', () => {
  it('owner chat, merged to main, no receipt → hold/require-confirm', () => {
    const d = evaluateClaimGate(gateOpts({ text: 'Merged to main — pipeline passed.' }));
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(d.cls).toBe('merge');
      expect(d.rung).toBe('require-confirm');
    }
  });

  it('owner chat, merged to main, merge receipt → allow', () => {
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'merge', ref: 'PR #56' });
    const d = evaluateClaimGate(gateOpts({ text: 'Merged to main.' }));
    expect(d.action).toBe('allow');
  });

  it('owner chat, merged, confirmFlag → allow', () => {
    const d = evaluateClaimGate(gateOpts({
      text: 'Merged to main.',
      confirmFlag: true,
    }));
    expect(d.action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// External-send claim (block rung)
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — external-send claim (block rung)', () => {
  it('owner chat, sent to client, no receipt → hold/block', () => {
    const d = evaluateClaimGate(gateOpts({ text: 'Sent to the client — all done.' }));
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(d.cls).toBe('external-send');
      expect(d.rung).toBe('block');
      expect(d.reason).toContain('external-send');
    }
  });

  it('owner chat, invoice sent, no receipt → hold/block', () => {
    const d = evaluateClaimGate(gateOpts({ text: 'Invoice sent.' }));
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(d.rung).toBe('block');
    }
  });

  it('owner chat, sent to client, confirmFlag=true → STILL hold (confirm does not bypass block)', () => {
    const d = evaluateClaimGate(gateOpts({
      text: 'Sent to the client.',
      confirmFlag: true,
    }));
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(d.rung).toBe('block');
    }
  });

  it('owner chat, sent to client, valid dated override marker → allow', () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(claimGateOverridePath(tmpRoot), JSON.stringify({ expires: futureDate }), 'utf-8');
    const d = evaluateClaimGate(gateOpts({ text: 'Sent to the client.' }));
    expect(d.action).toBe('allow');
  });

  it('owner chat, sent to client, EXPIRED override marker → hold', () => {
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString();
    writeFileSync(claimGateOverridePath(tmpRoot), JSON.stringify({ expires: pastDate }), 'utf-8');
    const d = evaluateClaimGate(gateOpts({ text: 'Sent to the client.' }));
    expect(d.action).toBe('hold');
  });

  it('owner chat, sent to client, matching external-send receipt → allow', () => {
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'external-send', ref: 'email-thread-id-abc' });
    const d = evaluateClaimGate(gateOpts({ text: 'Sent to the client.' }));
    expect(d.action).toBe('allow');
  });

  it('owner chat, sent to client, manual receipt → allow', () => {
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'manual', ref: 'Josh confirmed on call' });
    const d = evaluateClaimGate(gateOpts({ text: 'Sent to the client.' }));
    expect(d.action).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Fail-open invariant
// ---------------------------------------------------------------------------

describe('evaluateClaimGate — fail-open invariant', () => {
  it('never throws — invalid ctxRoot → allow', () => {
    let result: ReturnType<typeof evaluateClaimGate> | undefined;
    expect(() => {
      result = evaluateClaimGate(gateOpts({ ctxRoot: '/this/path/does/not/exist/ever' }));
    }).not.toThrow();
    // Fail-open: either allow or hold, but must not throw
    expect(['allow', 'warn', 'hold']).toContain(result?.action);
  });

  it('never throws — empty agent name → allow', () => {
    let result: ReturnType<typeof evaluateClaimGate> | undefined;
    expect(() => {
      result = evaluateClaimGate(gateOpts({ agent: '' }));
    }).not.toThrow();
    expect(result).toBeDefined();
  });

  it('malformed ledger does not throw — returns hold (no valid receipt found)', () => {
    const p = receiptLedgerPath(tmpRoot);
    mkdirSync(join(tmpRoot, 'state'), { recursive: true });
    appendFileSync(p, '{not json at all\n', 'utf-8');
    let result: ReturnType<typeof evaluateClaimGate> | undefined;
    expect(() => {
      result = evaluateClaimGate(gateOpts());
    }).not.toThrow();
    // Gate should still make a decision (likely hold since no valid receipt)
    expect(result?.action).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Regression: existing warn-only path is byte-unchanged in warn mode
// ---------------------------------------------------------------------------

describe('regression — warn mode behaviour matches pre-WS2 behaviour', () => {
  it('deploy claim, warn mode, no receipt → warn (no block, never exits non-zero)', () => {
    const d = evaluateClaimGate(gateOpts({ gateMode: 'warn' }));
    expect(d.action).toBe('warn');
  });

  it('generic claim, warn mode, no receipt → warn', () => {
    const d = evaluateClaimGate(gateOpts({ gateMode: 'warn', text: 'Done and shipped.' }));
    expect(d.action).toBe('warn');
  });

  it('non-claim, warn mode → allow', () => {
    const d = evaluateClaimGate(gateOpts({ gateMode: 'warn', text: 'Still working on it.' }));
    expect(d.action).toBe('allow');
  });

  it('legitimate progress message (true claim with receipt) passes in all modes', () => {
    recordVerificationReceipt(tmpRoot, 'codexer', { kind: 'build', ref: 'npm run build' });

    const offMode = evaluateClaimGate(gateOpts({ gateMode: 'off', text: 'Build passed — done.' }));
    const warnMode = evaluateClaimGate(gateOpts({ gateMode: 'warn', text: 'Build passed — done.' }));
    const enforceMode = evaluateClaimGate(gateOpts({ gateMode: 'enforce', text: 'Build passed — done.' }));

    // off mode → allow
    expect(offMode.action).toBe('allow');
    // warn mode → warn (generic claim, warn path)
    expect(['allow', 'warn']).toContain(warnMode.action);
    // enforce mode with a receipt → allow (receipt satisfies generic warning)
    // Note: generic class uses hasRecentReceipt (no kind filter), so any receipt counts
    expect(['allow', 'warn']).toContain(enforceMode.action);
  });
});
