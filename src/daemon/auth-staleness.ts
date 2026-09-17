import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * auth-staleness — detect that an agent is running on a superseded login.
 *
 * `codex app-server` reads ~/.codex/auth.json once at spawn and holds those
 * tokens for the life of the process. So when the ChatGPT plan hits its usage
 * cap and the user re-authenticates (often onto a different account), every
 * running agent keeps presenting the OLD credentials and keeps failing with
 * "You've hit your usage limit", until each one is restarted by hand.
 *
 * Observed 2026-09-15: auth.json rewritten 17:45, agent processes dating from
 * Sep 10-14, all failing; restarting one fixed it immediately.
 *
 * WHY NOT WATCH THE FILE. codex rewrites auth.json on every routine token
 * refresh — its own `last_refresh` field moves — so an mtime watcher would
 * restart the whole fleet on every refresh interval. That is a self-inflicted
 * outage worse than the problem being solved. The ACCOUNT is what changes on a
 * re-login, and it is stable across refreshes, so the account is the signal.
 */

export interface AuthChangeInput {
  /** Account id recorded when this agent's runtime process was spawned. */
  startedWithAccountId: string | null;
  /** Account id currently in auth.json. */
  currentAccountId: string | null;
}

export type AuthChangeDecision =
  | { changed: false; reason: 'same-account' | 'current-account-unknown' | 'no-baseline' }
  | { changed: true; reason: 'account-changed' };

/**
 * Whether this agent is running on a login that has since been replaced.
 *
 * Fail-safe in every ambiguous case: an unreadable or unrecorded account never
 * triggers a restart. A missed detection costs one manual restart; a false one
 * takes down the fleet.
 */
export function detectAuthChange(input: AuthChangeInput): AuthChangeDecision {
  const started = input.startedWithAccountId?.trim() || null;
  const current = input.currentAccountId?.trim() || null;

  if (!started) return { changed: false, reason: 'no-baseline' };
  if (!current) return { changed: false, reason: 'current-account-unknown' };
  if (started === current) return { changed: false, reason: 'same-account' };
  return { changed: true, reason: 'account-changed' };
}

/**
 * The ChatGPT account id currently in `auth.json`, or null if unreadable.
 *
 * Null on ANY doubt — a missing file, a partial write, an API-key auth mode with
 * no account — because null can never trigger a restart.
 */
export function readAuthAccountId(codexHome: string): string | null {
  try {
    const raw = readFileSync(join(codexHome, 'auth.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { tokens?: { account_id?: unknown } };
    const id = parsed?.tokens?.account_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Where an agent records the account its runtime process was spawned with. */
export function authBaselinePath(stateDir: string): string {
  return join(stateDir, 'codex-auth-account.json');
}

/** Record the account this process started with. Best-effort; never throws. */
export function writeAuthBaseline(stateDir: string, accountId: string | null): void {
  if (!accountId) return;
  try {
    writeFileSync(
      authBaselinePath(stateDir),
      JSON.stringify({ account_id: accountId, recorded_at: new Date().toISOString() }),
    );
  } catch { /* non-fatal — absence just means no baseline, which never restarts */ }
}

/** The account recorded at spawn, or null if none was recorded. */
export function readAuthBaseline(stateDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(authBaselinePath(stateDir), 'utf-8')) as { account_id?: unknown };
    const id = parsed?.account_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Default codex home, honouring CODEX_HOME when the user has moved it. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}
