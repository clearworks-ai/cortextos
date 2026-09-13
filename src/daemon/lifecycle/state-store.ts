import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { BusPaths } from '../../types/index.js';
import type { AgentId, DesiredState, LifecycleSnapshot } from './types.js';
import { withStoreLock } from './store-lock.js';
import { atomicWriteDurableSync } from '../../utils/atomic.js';

/**
 * Durable lifecycle state store.
 *
 * Persists a single `LifecycleSnapshot` (Task 1.1) per agent at
 * `<BusPaths.stateDir>/lifecycle/supervisor.json`, guarded by the
 * generation-bound store lock (Task 1.2, `./store-lock.ts`) and written via
 * the fsynced durable atomic write (Task 1.3, `atomicWriteDurableSync`).
 *
 * DESIGN DECISION -- first adoption (Task 1.4 Step 5):
 * `load()` never fabricates an initial snapshot. When no record exists yet
 * it returns `{ corrupt: true, reason: 'not-yet-adopted' }` -- a value that
 * fits the class's existing `load()` return type without inventing a third
 * shape. Creating the *first* record is instead the job of the separate
 * `adopt()` method below, which takes an explicit initial `DesiredState`
 * from its caller (never a silent default) and fails closed -- via the
 * existing `CommitResult` codes, no new codes added -- if a record already
 * exists (whether a valid prior snapshot for this same agent, or a
 * corrupt/foreign one): that is "conflicting legacy evidence" and adoption
 * is blocked rather than guessed at. Task 1.5's supervisor must call
 * `adopt(initialDesiredState)` once, up front, before ever calling
 * `commit()` against a fresh agent.
 *
 * Corruption, persist failure, or an agent-identity mismatch on `load()`
 * NEVER trigger a silent repair or a `.bak` restore -- the caller (Task
 * 1.5's supervisor) is expected to surface these as a blocked owner.
 *
 * SCHEMA UPGRADE PATH (Task 3.2 Step 2): schemaVersion 1 (Phase 1: ownership
 * only, `outstandingWork` always empty because nothing populated it yet) ->
 * schemaVersion 2 (Phase 3: `outstandingWork` populated by
 * `AgentLifecycleSupervisor.acceptBatch`). `load()` upgrades a structurally
 * valid schemaVersion-1 record in place -- normalizing a missing/absent
 * `outstandingWork` to `[]` before the standard shape check runs -- rather
 * than rejecting it as corrupt. This is a one-way, no-op-on-Phase-1-data
 * upgrade (Phase 1 never wrote any work records, so there is nothing to
 * migrate besides the version tag itself); it does NOT apply to a genuinely
 * CORRUPT record (unreadable JSON, invalid shape once normalized, etc.),
 * which still fails closed exactly as before. The upgraded shape is only
 * held in memory until the next successful `commit()`, which persists
 * `schemaVersion: SCHEMA_VERSION` (2) as part of its normal deep-cloned
 * write -- there is no separate migration write.
 */

/** The pre-Phase-3 schema version: ownership state only, `outstandingWork`
 * always empty. Records at this version are upgraded in place by `load()`
 * (see the SCHEMA UPGRADE PATH note above), never rejected as corrupt. */
const PHASE_1_SCHEMA_VERSION = 1;

/** Current schema version (Task 3.2): `outstandingWork` is populated by
 * `AgentLifecycleSupervisor.acceptBatch`. */
export const SCHEMA_VERSION = 2;

export interface StoreCommitExpectation {
  supervisorEpoch: number;
  revision: number;
}

export type CommitResult =
  | { ok: true; snapshot: LifecycleSnapshot }
  | {
      ok: false;
      code: 'STALE_REVISION' | 'EPOCH_MISMATCH' | 'LOCK_UNAVAILABLE' | 'PERSIST_FAILED' | 'CORRUPT';
      message: string;
    };

function isValidSnapshotShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.agentId === 'string' &&
    typeof value.schemaVersion === 'number' &&
    typeof value.revision === 'number' &&
    typeof value.supervisorEpoch === 'number' &&
    typeof value.desiredState === 'string' &&
    (value.desiredStateReason === null || typeof value.desiredStateReason === 'string') &&
    (value.desiredStateRequestId === null || typeof value.desiredStateRequestId === 'string') &&
    typeof value.intentRevision === 'number' &&
    (value.currentGeneration === null || typeof value.currentGeneration === 'number') &&
    typeof value.nextGeneration === 'number' &&
    typeof value.phase === 'string' &&
    Array.isArray(value.resources) &&
    Array.isArray(value.retiringResources) &&
    Array.isArray(value.outstandingWork) &&
    Array.isArray(value.pendingRequests) &&
    typeof value.recoveryBudgets === 'object' &&
    value.recoveryBudgets !== null &&
    (value.blockedReason === null || typeof value.blockedReason === 'string')
  );
}

function buildInitialSnapshot(
  agentId: AgentId,
  desiredState: DesiredState,
  opts?: { desiredStateReason?: string | null; desiredStateRequestId?: string | null },
): LifecycleSnapshot {
  return {
    agentId,
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    // No daemon-owner term has been established for a brand-new record yet;
    // Task 1.5's supervisor stamps the real epoch in on its first commit
    // once `admitDaemonWriter` has run. 0 is a sentinel, never a live epoch.
    supervisorEpoch: 0,
    desiredState,
    desiredStateReason: opts?.desiredStateReason ?? null,
    desiredStateRequestId: opts?.desiredStateRequestId ?? null,
    intentRevision: 0,
    currentGeneration: null,
    nextGeneration: 1,
    phase: 'absent',
    resources: [],
    retiringResources: [],
    outstandingWork: [],
    pendingRequests: [],
    recoveryBudgets: {},
    blockedReason: null,
  };
}

/**
 * Task 3.2 Step 3: durably persist one work item's payload to its own
 * immutable ref, BEFORE any snapshot commit references it. Written via
 * `atomicWriteDurableSync` (Task 1.3) so the write itself is crash-durable.
 * Returns `{ ok: false, reason }` on any thrown error (disk full,
 * permission, etc.) instead of throwing -- callers (`acceptBatch`) must be
 * able to abort a whole batch cleanly on a payload-write failure without a
 * partial commit ever being attempted.
 *
 * A crash between this write and the snapshot commit that would reference
 * it leaves an orphaned payload file under `<stateDir>/lifecycle/payloads/`
 * -- harmless, cleaned up later by a separate process; this module never
 * reads that directory back to reconcile it.
 */
export function writePayloadDurably(
  stateDir: string,
  workId: string,
  payload: string,
): { ok: true; ref: string } | { ok: false; reason: string } {
  const ref = join(stateDir, 'lifecycle', 'payloads', `${workId}.json`);
  try {
    atomicWriteDurableSync(ref, payload);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, ref };
}

export class LifecycleStateStore {
  constructor(
    private readonly paths: BusPaths,
    private readonly agentId: AgentId,
  ) {}

  private lockRoot(): string {
    return join(this.paths.stateDir, 'lifecycle');
  }

  private recordPath(): string {
    return join(this.lockRoot(), 'supervisor.json');
  }

  /** Task 3.2 Step 3: thin instance-scoped wrapper over `writePayloadDurably`
   * so callers (`AgentLifecycleSupervisor.acceptBatch`) never need to know
   * this store's `stateDir` directly. */
  writeWorkPayload(workId: string, payload: string): { ok: true; ref: string } | { ok: false; reason: string } {
    return writePayloadDurably(this.paths.stateDir, workId, payload);
  }

  /**
   * Load the current on-disk snapshot. Returns `{ corrupt: true, reason }`
   * for: no record yet (`'not-yet-adopted'`), unreadable/truncated JSON
   * (`'json-parse-failed'`), a non-object root (`'non-object-root'`), a
   * schema version mismatch, a shape that's missing/mistyped required
   * fields (`'invalid-snapshot-shape'`), or a record whose persisted
   * `agentId` doesn't match this instance's `agentId`
   * (`'agent-identity-mismatch'` -- see the cross-org/name rejection note
   * below). Never attempts a silent repair or `.bak` fallback.
   */
  load(): LifecycleSnapshot | { corrupt: true; reason: string } {
    const recordPath = this.recordPath();
    if (!existsSync(recordPath)) {
      return { corrupt: true, reason: 'not-yet-adopted' };
    }

    let raw: string;
    try {
      raw = readFileSync(recordPath, 'utf-8');
    } catch (err) {
      return { corrupt: true, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { corrupt: true, reason: 'json-parse-failed' };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return { corrupt: true, reason: 'non-object-root' };
    }

    const candidate = parsed as Record<string, unknown>;

    if (candidate.schemaVersion !== SCHEMA_VERSION) {
      if (candidate.schemaVersion !== PHASE_1_SCHEMA_VERSION) {
        return {
          corrupt: true,
          reason: `schema-version-mismatch: expected ${SCHEMA_VERSION} (or upgradable ${PHASE_1_SCHEMA_VERSION}), found ${String(candidate.schemaVersion)}`,
        };
      }
      // Upgrade path: a Phase-1-shaped record. Normalize BEFORE the shape
      // check below runs, so a hand-constructed fixture with `outstandingWork`
      // missing entirely (not just `[]`) upgrades cleanly too.
      candidate.schemaVersion = SCHEMA_VERSION;
      if (!Array.isArray(candidate.outstandingWork)) {
        candidate.outstandingWork = [];
      }
    }

    if (!isValidSnapshotShape(candidate)) {
      return { corrupt: true, reason: 'invalid-snapshot-shape' };
    }

    // Cross-org/name identity rejection (Task 1.4 Step 3): `paths.stateDir`
    // is derived from `agentName` alone, so two different orgs with the
    // same agent name under the same instanceId physically collide on the
    // same record path. Never coalesce -- fail closed on a mismatch.
    if (candidate.agentId !== this.agentId) {
      return { corrupt: true, reason: 'agent-identity-mismatch' };
    }

    return candidate as unknown as LifecycleSnapshot;
  }

  /**
   * Compare-and-commit: acquire the store lock, re-read the current
   * snapshot (never trusting anything cached before the lock), verify
   * `expected.{supervisorEpoch,revision}` against it, apply `mutate` to a
   * deep clone, bump the revision, and persist durably. Lock release
   * happens automatically via `withStoreLock`'s own `finally`, regardless
   * of outcome.
   */
  commit(expected: StoreCommitExpectation, mutate: (draft: LifecycleSnapshot) => void): CommitResult {
    const ownerToken = `commit-${process.pid}-${randomBytes(4).toString('hex')}`;

    const result = withStoreLock(this.lockRoot(), ownerToken, (): CommitResult => {
      const loaded = this.load();
      if ('corrupt' in loaded) {
        return { ok: false, code: 'CORRUPT', message: loaded.reason };
      }

      if (loaded.supervisorEpoch !== expected.supervisorEpoch) {
        return {
          ok: false,
          code: 'EPOCH_MISMATCH',
          message: `expected supervisorEpoch ${expected.supervisorEpoch}, found ${loaded.supervisorEpoch}`,
        };
      }

      if (loaded.revision !== expected.revision) {
        return {
          ok: false,
          code: 'STALE_REVISION',
          message: `expected revision ${expected.revision}, found ${loaded.revision}`,
        };
      }

      // Deep clone so `mutate`'s in-place edits never corrupt the
      // pre-mutation snapshot we've already validated against `expected`.
      const draft: LifecycleSnapshot = JSON.parse(JSON.stringify(loaded));
      mutate(draft);
      draft.revision = loaded.revision + 1;

      try {
        atomicWriteDurableSync(this.recordPath(), JSON.stringify(draft, null, 2));
      } catch (err) {
        // Persist failed -- nothing was written, so any subsequent load()
        // still reflects pre-attempt disk content. The in-memory `draft`
        // is discarded here, never returned as if it were committed.
        return {
          ok: false,
          code: 'PERSIST_FAILED',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      return { ok: true, snapshot: draft };
    });

    if (result === null) {
      return { ok: false, code: 'LOCK_UNAVAILABLE', message: 'could not acquire the lifecycle store lock' };
    }
    return result;
  }

  /**
   * First-adoption entry point (see the DESIGN DECISION note at the top of
   * this file). Creates the very first record for this agent with an
   * explicitly supplied initial desired state. If a record already exists
   * -- valid or corrupt, for this agent or a colliding one -- adoption is
   * blocked rather than guessed at; it is never silently overwritten.
   */
  adopt(
    initialDesiredState: DesiredState,
    opts?: { desiredStateReason?: string | null; desiredStateRequestId?: string | null },
  ): CommitResult {
    const ownerToken = `adopt-${process.pid}-${randomBytes(4).toString('hex')}`;

    const result = withStoreLock(this.lockRoot(), ownerToken, (): CommitResult => {
      const recordPath = this.recordPath();

      if (!existsSync(recordPath)) {
        const snapshot = buildInitialSnapshot(this.agentId, initialDesiredState, opts);
        try {
          atomicWriteDurableSync(recordPath, JSON.stringify(snapshot, null, 2));
        } catch (err) {
          return {
            ok: false,
            code: 'PERSIST_FAILED',
            message: err instanceof Error ? err.message : String(err),
          };
        }
        return { ok: true, snapshot };
      }

      // Conflicting legacy evidence: something is already on disk. Surface
      // whatever `load()` finds -- a real prior snapshot (possibly for a
      // colliding identity) or corruption -- as a blocked adoption.
      const loaded = this.load();
      if ('corrupt' in loaded) {
        return { ok: false, code: 'CORRUPT', message: loaded.reason };
      }
      return {
        ok: false,
        code: 'STALE_REVISION',
        message: `adoption blocked: a lifecycle record already exists for this agent (revision ${loaded.revision})`,
      };
    });

    if (result === null) {
      return { ok: false, code: 'LOCK_UNAVAILABLE', message: 'could not acquire the lifecycle store lock for adoption' };
    }
    return result;
  }
}

// --- Daemon writer election -------------------------------------------------

interface DaemonElectionRecord {
  daemonUuid: string;
  pid: number;
  epoch: number;
  processBirth: string | null;
}

function daemonElectionRecordPath(ctxRoot: string): string {
  return join(ctxRoot, 'lifecycle-daemon.json');
}

function daemonElectionLockRoot(ctxRoot: string): string {
  // Deliberately NOT under any `state/<agent>/lifecycle/` path -- this lock
  // guards the single per-instance election record at `ctxRoot` level, one
  // directory above the per-agent state directories, so it can never
  // collide with a `LifecycleStateStore`'s per-agent lock root.
  return join(ctxRoot, '.lifecycle-daemon.lock');
}

/**
 * Same definite-vs-ambiguous liveness discipline as Task 1.2's store lock:
 * only ESRCH ("no such process") counts as definite absence. EPERM (a live
 * process owned by someone else) or anything else unreadable is ambiguous
 * and must NOT authorize a takeover.
 */
function probeProcessLiveness(pid: number): 'alive' | 'dead' | 'ambiguous' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return 'dead';
    }
    return 'ambiguous';
  }
}

/**
 * Best-effort OS process-birth evidence. On Linux, `/proc/<pid>/stat`'s
 * `starttime` field (in clock ticks since boot) is a real kernel-provided
 * value that can't be spoofed by PID reuse alone. macOS has no equivalent
 * `/proc` filesystem, so callers fall back to a recorded wall-clock
 * timestamp -- a deliberately weaker proxy, documented as such wherever
 * it's used.
 *
 * Exported so other lifecycle callers (e.g. Task 2.1's
 * `AgentProcessRuntimeAdapter`, capturing `pty-host` resource evidence) reuse
 * this exact platform-conditional logic instead of re-deciding, per-caller,
 * whether birth evidence is available on the current platform.
 */
export function getProcessBirthEvidence(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      // Per proc(5): fields after `(comm) state` are 0-indexed here at
      // `state`; `starttime` is the 22nd whitespace-separated field overall,
      // i.e. index 19 in this post-comm array (state=0, ppid=1, pgrp=2,
      // session=3, tty_nr=4, tpgid=5, flags=6, minflt=7, cminflt=8,
      // majflt=9, cmajflt=10, utime=11, stime=12, cutime=13, cstime=14,
      // priority=15, nice=16, num_threads=17, itrealvalue=18, starttime=19).
      const startTimeTicks = fields[19];
      if (startTimeTicks) {
        return `linux-proc-starttime-ticks:${startTimeTicks}`;
      }
    } catch {
      // Unreadable -- fall through to the weaker wall-clock proxy below.
    }
  }
  return null;
}

/**
 * Elect (or re-elect, on a definitively-dead previous holder) this process
 * as the lifecycle daemon writer for `ctxRoot`. No timeout-based theft: a
 * live or ambiguously-identified previous daemon always blocks takeover,
 * regardless of how old its record is.
 */
export function admitDaemonWriter(
  ctxRoot: string,
  daemonUuid: string,
): { ok: true; epoch: number } | { ok: false; reason: string } {
  const ownerToken = `daemon-admit-${process.pid}-${randomBytes(4).toString('hex')}`;

  const result = withStoreLock(
    daemonElectionLockRoot(ctxRoot),
    ownerToken,
    (): { ok: true; epoch: number } | { ok: false; reason: string } => {
      const recordPath = daemonElectionRecordPath(ctxRoot);
      const birth = getProcessBirthEvidence(process.pid) ?? `wall-clock:${Date.now()}`;

      if (!existsSync(recordPath)) {
        const record: DaemonElectionRecord = { daemonUuid, pid: process.pid, epoch: 1, processBirth: birth };
        try {
          atomicWriteDurableSync(recordPath, JSON.stringify(record, null, 2));
        } catch (err) {
          return {
            ok: false,
            reason: `failed to persist first election record: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return { ok: true, epoch: 1 };
      }

      let existing: DaemonElectionRecord;
      try {
        const raw = readFileSync(recordPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as Record<string, unknown>).daemonUuid !== 'string' ||
          typeof (parsed as Record<string, unknown>).pid !== 'number' ||
          typeof (parsed as Record<string, unknown>).epoch !== 'number'
        ) {
          return { ok: false, reason: 'existing election record has an invalid shape -- refusing to admit ambiguously' };
        }
        existing = parsed as DaemonElectionRecord;
      } catch {
        return { ok: false, reason: 'existing election record is unreadable/corrupt -- refusing to admit ambiguously' };
      }

      const liveness = probeProcessLiveness(existing.pid);
      if (liveness !== 'dead') {
        // 'alive' -> genuinely held. 'ambiguous' -> preserve exclusion.
        // Either way: no timeout-based theft.
        return { ok: false, reason: `previous daemon (pid ${existing.pid}) is ${liveness} -- no timeout-based theft` };
      }

      const nextEpoch = existing.epoch + 1;
      const record: DaemonElectionRecord = { daemonUuid, pid: process.pid, epoch: nextEpoch, processBirth: birth };
      try {
        atomicWriteDurableSync(recordPath, JSON.stringify(record, null, 2));
      } catch (err) {
        return {
          ok: false,
          reason: `failed to persist reclaimed election record: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true, epoch: nextEpoch };
    },
  );

  if (result === null) {
    return { ok: false, reason: 'could not acquire the daemon election lock' };
  }
  return result;
}
