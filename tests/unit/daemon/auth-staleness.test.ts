import { describe, it, expect } from 'vitest';
import { detectAuthChange } from '../../../src/daemon/auth-staleness.js';

/**
 * Every time the ChatGPT plan hits its usage cap and Josh re-authenticates,
 * the whole fleet has to be restarted by hand. Claude Code does not have this
 * problem because it re-reads OAuth from the keychain per request; `codex
 * app-server` reads ~/.codex/auth.json ONCE at spawn and holds those tokens for
 * the life of the process, so a re-login reaches exactly nothing.
 *
 * Observed 2026-09-15: auth.json rewritten 17:45, every agent process started
 * Sep 10-14, all still failing with "You've hit your usage limit ... try again
 * at Sep 21st". Restarting one agent fixed it instantly.
 *
 * THE FILE MTIME IS THE WRONG SIGNAL. codex rewrites auth.json on every routine
 * token refresh (its own `last_refresh` field moves), so an mtime watcher would
 * restart the entire fleet every refresh interval — a self-inflicted outage far
 * worse than the problem. The account identity is what actually changed on a
 * re-login, and it is stable across refreshes.
 */

describe('detectAuthChange', () => {
  it('reports a change when the account differs from the one the process started with', () => {
    const d = detectAuthChange({ startedWithAccountId: 'acct-old', currentAccountId: 'acct-new' });
    expect(d.changed).toBe(true);
    expect(d.reason).toBe('account-changed');
  });

  it('does NOT report a change on a routine token refresh of the same account', () => {
    // The tokens rotate and auth.json is rewritten; the account is identical.
    const d = detectAuthChange({ startedWithAccountId: 'acct-1', currentAccountId: 'acct-1' });
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('same-account');
  });

  it('does nothing when the current account cannot be read', () => {
    // A partial write or a missing file must never trigger a fleet restart.
    const d = detectAuthChange({ startedWithAccountId: 'acct-1', currentAccountId: null });
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('current-account-unknown');
  });

  it('does nothing when we never recorded what the process started with', () => {
    // Agents already running when this feature ships have no record. They must
    // not all restart on first check.
    const d = detectAuthChange({ startedWithAccountId: null, currentAccountId: 'acct-1' });
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('no-baseline');
  });

  it('treats empty strings as unknown, not as a difference', () => {
    expect(detectAuthChange({ startedWithAccountId: '', currentAccountId: 'acct-1' }).changed).toBe(false);
    expect(detectAuthChange({ startedWithAccountId: 'acct-1', currentAccountId: '' }).changed).toBe(false);
  });
});
