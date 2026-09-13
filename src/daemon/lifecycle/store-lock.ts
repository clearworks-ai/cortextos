import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  existsSync,
} from 'fs';
import { join } from 'path';

/**
 * Generation-bound store lock for the lifecycle state store.
 *
 * This is a PRIVATE mutex used exclusively by the lifecycle state store
 * (`src/daemon/lifecycle/*`). It is a deliberately separate implementation
 * from `src/utils/lock.ts` — it must never share a lock directory, callers,
 * or code path with that module. `src/utils/lock.ts` remains the mutex for
 * `src/bus/message.ts` and its existing callers; this module only ever
 * operates under a `<stateDir>/lifecycle/` root.
 *
 * It is strictly stronger than `src/utils/lock.ts` in one specific way:
 * ambiguous liveness never authorizes a steal. `src/utils/lock.ts`'s
 * `acquireLock` treats "definite dead PID" (ESRCH) and "ambiguous/EPERM"
 * the same way (both fall into its generic `catch` and go straight to a
 * destructive `rmSync`-then-recreate). This module explicitly branches on
 * the error code from `process.kill(pid, 0)`: only ESRCH ("no such
 * process") counts as a definite "process absent" result that authorizes
 * reclamation. EPERM (process exists, owned by someone else) or any other
 * unreadable/ambiguous outcome PRESERVES exclusion (refuses the lock).
 *
 * Mechanics:
 *  - Acquisition reserves the observed directory by RENAME, never by bare
 *    `mkdir`. A uniquely-named staging directory is created first (with the
 *    caller's identity already written inside it), then `renameSync`'d onto
 *    the canonical `.lock.d` slot. `renameSync` is atomic on the same
 *    filesystem, so exactly one renamer wins when multiple processes race
 *    for the same target path.
 *  - Release verifies BOTH the lock directory's device+inode (has the
 *    directory been deleted and recreated out from under this handle?) AND
 *    the on-disk identity file's owner token (does a different owner now
 *    hold it?) before removing anything. Either mismatch is a no-op — this
 *    module never blindly `rmSync`s based on path string alone.
 *  - Contention is single-shot: a failed `acquireStoreLock` returns `null`
 *    immediately. There is no retry/backoff loop here (unlike
 *    `withFileLockSync`/`withFileLockAsync`'s spin-with-backoff pattern) —
 *    contention on this lock defers or rejects the caller's transaction,
 *    it must never spin the daemon event loop in a retry sleep.
 *
 * Tombstone retention policy (acceptance criterion — read before touching
 * the reclamation path): when a dead holder's lock is reclaimed, the stale
 * `.lock.d` directory is renamed ASIDE to a `.lock.d.tombstone-<ts>-...`
 * path rather than deleted. Tombstones are ADVISORY AUDIT TRAIL ONLY. This
 * module NEVER auto-deletes tombstones on its own acquire/release path —
 * not on the acquire that created them, not on any later acquire/release.
 * A periodic EXTERNAL cleanup process (not this module) may prune old
 * tombstones; until such a process exists, they accumulate under
 * `lockRoot` and that is expected/correct behavior, not a leak this module
 * is responsible for closing.
 */

export interface StoreLockHandle {
  readonly __brand: 'StoreLockHandle';
}

interface InternalLockState {
  lockPath: string;
  ownerToken: string;
  pid: number;
  acquiredAtMs: number;
  lockDev: number;
  lockIno: number;
}

interface LockIdentity {
  ownerToken: string;
  pid: number;
  acquiredAtMs: number;
  rootDev: number;
  rootIno: number;
}

// Real fields live only here, keyed off the opaque branded handle. The
// public `StoreLockHandle` type carries no data of its own — callers cannot
// forge a handle that maps to real internal state.
const HANDLE_STATE = new WeakMap<StoreLockHandle, InternalLockState>();

class StoreLockHandleImpl implements StoreLockHandle {
  readonly __brand: 'StoreLockHandle' = 'StoreLockHandle';
}

function lockDirPath(lockRoot: string): string {
  return join(lockRoot, '.lock.d');
}

function identityFilePath(lockDirAbs: string): string {
  return join(lockDirAbs, 'identity.json');
}

function readIdentity(lockDirAbs: string): LockIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(identityFilePath(lockDirAbs), 'utf-8');
  } catch {
    // Missing identity file: either the holder is mid-acquire (rename won,
    // identity not yet visible) or the slot is otherwise unreadable. Never
    // steal on this ambiguity.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt/garbage bytes -- refuse, never steal.
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).ownerToken !== 'string' ||
    typeof (parsed as Record<string, unknown>).pid !== 'number' ||
    typeof (parsed as Record<string, unknown>).acquiredAtMs !== 'number' ||
    typeof (parsed as Record<string, unknown>).rootDev !== 'number' ||
    typeof (parsed as Record<string, unknown>).rootIno !== 'number'
  ) {
    return null; // malformed shape -- refuse, never steal.
  }

  return parsed as LockIdentity;
}

function sanitizeTokenFragment(token: string): string {
  return token.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function writeStaging(lockRoot: string, ownerToken: string): string {
  const rootStat = statSync(lockRoot);
  const stagingDir = mkdtempSync(join(lockRoot, '.lock.d.reserve-'));
  const identity: LockIdentity = {
    ownerToken,
    pid: process.pid,
    acquiredAtMs: Date.now(),
    rootDev: rootStat.dev,
    rootIno: rootStat.ino,
  };
  writeFileSync(identityFilePath(stagingDir), JSON.stringify(identity));
  return stagingDir;
}

function buildHandle(
  lockPath: string,
  ownerToken: string,
  pid: number,
  acquiredAtMs: number,
  lockDev: number,
  lockIno: number,
): StoreLockHandle {
  const handle = new StoreLockHandleImpl();
  HANDLE_STATE.set(handle, { lockPath, ownerToken, pid, acquiredAtMs, lockDev, lockIno });
  return handle;
}

/** Definite process-absence ('dead') is the ONLY result that authorizes
 * reclamation. 'alive' and 'ambiguous' both preserve exclusion. */
function probeLiveness(pid: number): 'alive' | 'dead' | 'ambiguous' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return 'dead';
    }
    // EPERM (process exists, different owner) or anything else unreadable
    // is ambiguous, NOT definite absence. This is the single most important
    // behavioral divergence from `src/utils/lock.ts`.
    return 'ambiguous';
  }
}

/**
 * Called whenever `.lock.d` is already occupied (by any means -- a live
 * holder, a dead holder, or a partially-written/corrupt slot). Decides
 * refuse-vs-reclaim and, on reclaim, performs the tombstone-and-swap.
 */
function tryReclaim(lockRoot: string, lockPath: string, ownerToken: string): StoreLockHandle | null {
  const identity = readIdentity(lockPath);
  if (!identity) {
    // Missing or corrupt identity file -- "holder mid-acquire" or unreadable
    // slot. Never steal on ambiguity.
    return null;
  }

  const liveness = probeLiveness(identity.pid);
  if (liveness !== 'dead') {
    // 'alive' -> genuinely held. 'ambiguous' -> preserve exclusion.
    return null;
  }

  // Definite absence. Ownership is revalidated during partial acquisition:
  // re-stat now, then again right before the swap, to guard against a race
  // where another process reclaimed between this read and this attempt.
  let preStat;
  try {
    preStat = statSync(lockPath);
  } catch {
    return null; // disappeared already -- someone else is mid-swap.
  }

  const stagingDir = writeStaging(lockRoot, ownerToken);

  let confirmStat;
  try {
    confirmStat = statSync(lockPath);
  } catch {
    cleanupDir(stagingDir);
    return null;
  }
  if (confirmStat.dev !== preStat.dev || confirmStat.ino !== preStat.ino) {
    // The directory was replaced between our read and our attempt -- lost
    // the race. Refuse rather than guess.
    cleanupDir(stagingDir);
    return null;
  }

  const tombstonePath = join(
    lockRoot,
    `.lock.d.tombstone-${Date.now()}-${sanitizeTokenFragment(identity.ownerToken)}` +
      `-superseded-by-${sanitizeTokenFragment(ownerToken)}`,
  );

  try {
    renameSync(lockPath, tombstonePath);
  } catch {
    // Another process already reclaimed/removed it first.
    cleanupDir(stagingDir);
    return null;
  }

  // Best-effort tombstone metadata. Not fatal to reclamation if it fails.
  try {
    writeFileSync(
      join(tombstonePath, 'tombstone.json'),
      JSON.stringify({
        retention:
          'advisory-audit-trail-only; this module never auto-deletes tombstones; ' +
          'a periodic EXTERNAL cleanup process (not this module) may prune them',
        staleOwnerToken: identity.ownerToken,
        supersededByOwnerToken: ownerToken,
        tombstonedAtMs: Date.now(),
      }),
    );
  } catch {
    // Best-effort only.
  }

  try {
    renameSync(stagingDir, lockPath);
  } catch {
    // We already tombstoned the stale holder but lost the final race to
    // recreate `lockPath` (another reclaimer got there first). Leave the
    // tombstone in place -- it is advisory audit trail, never restored.
    cleanupDir(stagingDir);
    return null;
  }

  const lockStat = statSync(lockPath);
  return buildHandle(lockPath, ownerToken, process.pid, Date.now(), lockStat.dev, lockStat.ino);
}

/**
 * Attempt to acquire the lifecycle store lock rooted at `lockRoot`.
 *
 * Single-shot: never spins or retries internally. Returns `null` on any
 * contention (held by a live process, ambiguous liveness, or a lost
 * takeover race) or on a refused ambiguous/corrupt slot. Throws only on a
 * genuine filesystem failure (EACCES, EROFS, ENOSPC, etc.).
 */
export function acquireStoreLock(lockRoot: string, ownerToken: string): StoreLockHandle | null {
  mkdirSync(lockRoot, { recursive: true });
  const lockPath = lockDirPath(lockRoot);

  // If a `.lock.d` slot already exists in ANY state (live holder, dead
  // holder, or partially-written/empty), never attempt a bare rename onto
  // it -- POSIX rename() silently succeeds (and replaces) when the target
  // is an *empty* directory, which would let us steal a mid-acquire slot
  // by accident. Route every "something is already there" case through
  // the same triage/reclaim decision instead.
  if (existsSync(lockPath)) {
    return tryReclaim(lockRoot, lockPath, ownerToken);
  }

  const stagingDir = writeStaging(lockRoot, ownerToken);
  try {
    renameSync(stagingDir, lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    cleanupDir(stagingDir);
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      // Lost the race to a concurrent acquirer between our existsSync
      // check and our rename attempt. Fall through to the same triage.
      return tryReclaim(lockRoot, lockPath, ownerToken);
    }
    // Real filesystem failure -- propagate, do not swallow into null.
    throw err;
  }

  const lockStat = statSync(lockPath);
  return buildHandle(lockPath, ownerToken, process.pid, Date.now(), lockStat.dev, lockStat.ino);
}

/**
 * Release a previously-acquired handle. A stale handle (the lock directory
 * was replaced out from under it, or a different owner token now holds it)
 * is silently a no-op -- this function never blindly `rmSync`s by path.
 */
export function releaseStoreLock(handle: StoreLockHandle): void {
  const state = HANDLE_STATE.get(handle);
  if (!state) {
    return; // Not a handle this module recognizes.
  }

  let currentStat;
  try {
    currentStat = statSync(state.lockPath);
  } catch {
    return; // Already gone -- no-op.
  }

  if (currentStat.dev !== state.lockDev || currentStat.ino !== state.lockIno) {
    // The directory was deleted and recreated (or replaced) since we
    // acquired -- this handle no longer refers to the live lock. No-op.
    return;
  }

  const identity = readIdentity(state.lockPath);
  if (!identity || identity.ownerToken !== state.ownerToken) {
    // A different owner now holds this slot. No-op.
    return;
  }

  cleanupDir(state.lockPath);
}

/**
 * Single-attempt wrapper: acquire once, run `fn`, always release (even if
 * `fn` throws). Returns `null` immediately on contention -- no retry loop,
 * no `Atomics.wait`/`setTimeout` spin. Callers that need "wait for the
 * lock" semantics must implement their own defer/reject policy on top of
 * this; this module intentionally does not spin the daemon event loop in
 * a retry sleep.
 */
export function withStoreLock<T>(lockRoot: string, ownerToken: string, fn: () => T): T | null {
  const handle = acquireStoreLock(lockRoot, ownerToken);
  if (!handle) {
    return null;
  }
  try {
    return fn();
  } finally {
    releaseStoreLock(handle);
  }
}
