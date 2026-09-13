import { randomUUID } from 'crypto';
import type {
  AgentId,
  DesiredState,
  DispatchResult,
  EffectToken,
  GenerationToken,
  LifecycleRequest,
  LifecycleSnapshot,
  ObservedPhase,
  OwnedResource,
  RequestReceipt,
  RetirementResult,
  StartMode,
  WorkPhase,
  WorkRecord,
} from './types.js';
import { CAUSE_SEVERITY } from './types.js';
import type { LifecycleStateStore, CommitResult } from './state-store.js';
import { SCHEMA_VERSION as LIFECYCLE_SCHEMA_VERSION } from './state-store.js';
import {
  accept as ledgerAccept,
  archiveTerminal as ledgerArchiveTerminal,
  outstandingWork as ledgerOutstandingWork,
  markDispatched as ledgerMarkDispatched,
  markRuntimeAccepted as ledgerMarkRuntimeAccepted,
  markExecuting as ledgerMarkExecuting,
  complete as ledgerComplete,
  fail as ledgerFail,
  cancel as ledgerCancel,
  needsReview as ledgerNeedsReview,
} from './work-ledger.js';

/**
 * Task 1.5: Supervisor transition core.
 *
 * `AgentLifecycleSupervisor` is the serialized per-agent transition/effect
 * arbiter. It owns generation allocation, intent-revision fencing, request
 * arbitration (severity-wins/causes-retained, PRD.md Open Question 2), and
 * effect coordination against an injected `RuntimeAdapter`. It has **zero
 * knowledge of `AgentProcess`, `FastChecker`, or `AgentManager`** -- Phase 2
 * wires real producers to call `request()`, and a real `RuntimeAdapter` over
 * `AgentProcess` (Task 2.1). Do not import from any of those three modules
 * here -- Task 1.6's isolation gate source-scans for exactly that.
 */

// --- Step 1: local types not part of Task 1.1's Shared Contract -----------

export interface LifecycleObservation {
  kind: 'runtime-exited' | 'stall-detected' | 'watchdog-heartbeat' | string;
  token: GenerationToken;
  atMs: number;
  evidence: Record<string, string | number | boolean | null>;
}

export interface OperationStatus {
  operationId: string;
  phase: ObservedPhase;
  coalescedWith: string[];
  blockedReason: string | null;
}

// --- Step 2: RuntimeAdapter (interface only -- Task 2.1 implements it) ---

export interface RuntimeAdapter {
  startGeneration(
    effect: EffectToken,
    mode: StartMode,
  ): Promise<{ ok: boolean; resources: OwnedResource[]; error?: string }>;
  retireGeneration(token: GenerationToken, resources: OwnedResource[]): Promise<RetirementResult>;
  deliver(effect: EffectToken, payload: string, workIds: string[]): Promise<DispatchResult>;
}

interface PendingEntry {
  req: LifecycleRequest;
  seq: number;
  resolve: (receipt: RequestReceipt) => void;
}

function sameGeneration(a: GenerationToken, b: GenerationToken): boolean {
  return a.agentId === b.agentId && a.supervisorEpoch === b.supervisorEpoch && a.generation === b.generation;
}

function isAutonomousArbitrable(req: LifecycleRequest): boolean {
  return req.kind === 'start' || req.kind === 'restart' || req.kind === 'refresh';
}

function allOf(entries: PendingEntry[]): string[] {
  return entries.map((e) => e.req.requestId);
}

function otherIds(entries: PendingEntry[], self: string): string[] {
  return entries.filter((e) => e.req.requestId !== self).map((e) => e.req.requestId);
}

/**
 * Task 3.4 Step 5: `LifecycleObservation.evidence`'s value type has no array
 * member, so `WorkCorrelationEvent.workIds` crosses that boundary
 * JSON-encoded as a string (see `WORK_OBSERVATION_KINDS`'s doc comment).
 * Any decode failure (missing field, malformed JSON, non-array, non-string
 * elements) is treated as "no correlated workIds" rather than thrown.
 */
function decodeWorkIds(raw: string | number | boolean | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/**
 * Task 3.4 Step 5: applies one correlated work-observation `kind` to a
 * single `WorkRecord`, walking through whatever intermediate
 * `WORK_PRE_EXECUTION_CHAIN` phases the record hasn't reached yet first.
 * This exists here (not in `work-ledger.ts`) because it is policy about
 * HOW a runtime observation maps onto the pure per-transition functions --
 * `work-ledger.ts` stays exactly what Task 3.1 built it as: pure
 * single-transition functions with no opinion on multi-hop sequencing.
 * Throws (propagated to the caller's try/catch) if the record is already in
 * a phase this kind cannot legally reach at all -- e.g. already terminal.
 */
function applyWorkCorrelation(
  record: WorkRecord,
  kind: string,
  turnId: string | null,
  reason: string,
  nowMs: number,
): WorkRecord {
  switch (kind) {
    case 'work-runtime-accepted': {
      // The actual RPC-level acceptance moment IS the same moment Codex
      // begins executing the turn -- there is no separately-observable
      // "accepted but not yet executing" state for this runtime, so this
      // walks the record all the way to 'executing' in one call.
      const walked = advanceWorkRecordToward(record, 'executing', turnId, nowMs);
      return walked;
    }
    case 'work-progress':
      // Advisory only -- PHASES.md/this task's plan: "do not make anything
      // depend on progress events arriving." No ledger mutation.
      return record;
    case 'work-completed': {
      const executing = advanceWorkRecordToward(record, 'executing', turnId, nowMs);
      return ledgerComplete(executing, reason, nowMs);
    }
    case 'work-failed':
      return ledgerFail(record, reason, nowMs);
    case 'work-needs-review':
      return ledgerNeedsReview(record, reason, nowMs);
    case 'work-cancelled':
      return ledgerCancel(record, reason, nowMs);
    default:
      return record;
  }
}

/**
 * Walks `record` forward through `WORK_PRE_EXECUTION_CHAIN` up to (and
 * including) `target`, applying `markDispatched`/`markRuntimeAccepted`/
 * `markExecuting` for each hop not yet reached. A record already at or past
 * `target` (including any terminal/needs-review phase, which is outside the
 * chain entirely) is returned unchanged -- the caller's own final action
 * (e.g. `ledgerComplete`) is what will legally reject an out-of-order call
 * on a genuinely wrong phase.
 */
function advanceWorkRecordToward(
  record: WorkRecord,
  target: WorkPhase,
  turnId: string | null,
  nowMs: number,
): WorkRecord {
  const startIdx = WORK_PRE_EXECUTION_CHAIN.indexOf(record.phase);
  const targetIdx = WORK_PRE_EXECUTION_CHAIN.indexOf(target);
  if (startIdx === -1 || targetIdx === -1 || startIdx >= targetIdx) return record;

  let current = record;
  for (let i = startIdx + 1; i <= targetIdx; i += 1) {
    const phase = WORK_PRE_EXECUTION_CHAIN[i];
    if (phase === 'dispatched') {
      current = ledgerMarkDispatched(current, current.batchId ?? `work-${current.workId}`, nowMs);
    } else if (phase === 'runtime-accepted') {
      current = ledgerMarkRuntimeAccepted(current, turnId ?? current.runtimeTurnId ?? `turn-${current.workId}`, nowMs);
    } else if (phase === 'executing') {
      current = ledgerMarkExecuting(current, nowMs);
    }
  }
  return current;
}

/**
 * Task 3.2: bounds how many TERMINAL (`completed`/`failed`/`cancelled`)
 * `WorkRecord`s a snapshot retains (`work-ledger.ts`'s `archiveTerminal`
 * always keeps every non-terminal and `needs-review` record regardless of
 * this count -- archival never expires unresolved work). 500 is a
 * documented, arbitrary-but-reasonable default; not derived from any
 * measured workload.
 */
const MAX_RETAINED_TERMINAL_WORK_RECORDS = 500;

/**
 * Task 3.4 Step 5: the minimal consumer wiring for `CodexAppServerPTY`'s
 * `WorkCorrelationEvent`s. `LifecycleObservation.kind` is already typed as
 * `... | string` (Task 1.5's own doc comment anticipated `observe()` growing
 * one recognized kind at a time) -- these six additions are namespaced
 * `work-*` so they can never collide with `'pty-host-cleanup-candidate'` or
 * any future non-work kind. `agent-process.ts`'s `CodexAppServerPTY`
 * construction site is what actually emits these, via
 * `onWorkCorrelation((event) => owner.observe({ kind: `work-${event.type}`, ... }))`.
 *
 * `evidence.workIds` carries the correlated work-id array JSON-encoded as a
 * string, since `LifecycleObservation.evidence`'s value type
 * (`string | number | boolean | null`) has no array member -- this is the
 * "extend it minimally" Task 3.4's plan explicitly allows rather than
 * widening the Shared Contract type itself.
 */
const WORK_OBSERVATION_KINDS: ReadonlySet<string> = new Set([
  'work-runtime-accepted',
  'work-progress',
  'work-completed',
  'work-failed',
  'work-needs-review',
  'work-cancelled',
]);

/** `WorkPhase` values a `WorkRecord` passes through on its way toward `executing`, in order. */
const WORK_PRE_EXECUTION_CHAIN: WorkPhase[] = ['accepted', 'dispatched', 'runtime-accepted', 'executing'];

/**
 * Task 3.2 Step 4: internal signal thrown from inside `acceptBatch`'s
 * `commitWithRetry` mutate callback to abort the WHOLE in-progress batch
 * when one input conflicts (same `sourceKey`, different `payloadDigest`) --
 * mirroring Task 3.1's "same sourceKey with a different payloadDigest is a
 * conflict, never silently overwritten" rule at the batch layer. Caught
 * immediately around the `commitWithRetry` call in `acceptBatch` and never
 * allowed to escape it.
 */
class AcceptBatchConflictError extends Error {
  constructor(
    public readonly sourceKey: string,
    public readonly existingWorkId: string,
  ) {
    super(
      `acceptBatch: sourceKey '${sourceKey}' was already accepted with a different payloadDigest (existing workId ${existingWorkId})`,
    );
  }
}

export class AgentLifecycleSupervisor {
  private cached: LifecycleSnapshot | null = null;
  private pending: PendingEntry[] = [];
  private flushScheduled = false;
  private seqCounter = 0;
  private readonly operations = new Map<string, OperationStatus>();
  /** Task 2.7: see `handlePtyHostCleanupCandidate`/`lastPtyHostCleanupCandidate`. */
  private lastPtyHostCandidate: { hostPid: number; stillClaimed: boolean; atMs: number } | null = null;
  /** Task 3.6: see `handleWatchdogHeartbeat`/`lastWatchdogHeartbeatObservation`. */
  private lastWatchdogHeartbeat: { agentId: string; generation: number; atMs: number; evidence: Record<string, string | number | boolean | null> } | null = null;

  constructor(
    private readonly agentId: AgentId,
    private readonly store: LifecycleStateStore,
    private readonly runtime: RuntimeAdapter,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  // --- Public surface (Task 1.5 contract) ---------------------------------

  /**
   * Step 3: the mailbox. `request()` never awaits a runtime call itself --
   * it only enqueues the request and schedules a microtask-tick flush. Every
   * request that lands in the *same* synchronous stretch of caller code
   * (i.e. before the pending flush's microtask actually runs) is decided
   * together as one "transition window" -- this is the documented
   * definition of "window" PHASES.md leaves to the implementation: batching
   * granularity is one JS microtask tick, not a fixed time budget. Real
   * runtime work (`startGeneration`/`retireGeneration`/`deliver`) is kicked
   * off only *after* the durable commit for the window, as a detached async
   * chain the mailbox does not await.
   */
  request(req: LifecycleRequest): Promise<RequestReceipt> {
    return new Promise<RequestReceipt>((resolve) => {
      this.seqCounter += 1;
      this.pending.push({ req, seq: this.seqCounter, resolve });
      this.scheduleFlush();
    });
  }

  /**
   * Phase 1 scope: observation ingestion had no behavior yet. Phase 2 tasks
   * (2.1 real RuntimeAdapter, 2.3 pure recovery policy) are what turn a
   * `runtime-exited`/`stall-detected` observation into an actual `request()`
   * call with a real cause -- still a documented no-op here for those kinds.
   *
   * Task 2.7 is the first kind this method actually handles:
   * `'pty-host-cleanup-candidate'`, submitted by the PTY-host reaper's Tier 3
   * sweep instead of the reaper deciding to kill unilaterally. This keeps the
   * public surface additive rather than reworked -- still just
   * `request`/`observe`/`snapshot`/`operation`, with `observe()` growing one
   * more recognized `kind` at a time, exactly as Task 1.5's own doc comment
   * anticipated.
   */
  observe(event: LifecycleObservation): void {
    if (event.kind === 'pty-host-cleanup-candidate') {
      this.handlePtyHostCleanupCandidate(event);
      return;
    }
    if (event.kind === 'watchdog-heartbeat') {
      this.handleWatchdogHeartbeat(event);
      return;
    }
    if (WORK_OBSERVATION_KINDS.has(event.kind)) {
      this.handleWorkObservation(event);
      return;
    }
    // Every other kind remains a documented no-op -- see doc comment above.
  }

  /**
   * Task 2.7: confirm or refute a PTY-host reaper Tier 3 candidate against
   * THIS owner's own authoritative resource bundle, rather than the
   * reaper's coarse single-current-host registry view. Deliberately
   * READ-ONLY against the reaper's own decision: Task 2.7's acceptance
   * criteria require the reaper's existing preserve+log conservatism
   * (5499f344) to be RETAINED, not replaced, so no retire/kill is triggered
   * from this observation -- `stillClaimed` is recorded for introspection
   * (`lastPtyHostCleanupCandidate()`) so a later task has the confirm/refute
   * check already in place rather than needing to design it from scratch.
   */
  private handlePtyHostCleanupCandidate(event: LifecycleObservation): void {
    const hostPid = event.evidence['hostPid'];
    if (typeof hostPid !== 'number') return;
    const snapshot = this.snapshot();
    const stillClaimed = [...snapshot.resources, ...snapshot.retiringResources].some(
      (r) => r.kind === 'pty-host' && r.pid === hostPid,
    );
    this.lastPtyHostCandidate = { hostPid, stillClaimed, atMs: event.atMs };
  }

  /**
   * Task 2.7 introspection: the most recent PTY-host cleanup candidate this
   * owner was asked to evaluate via `observe()`, and whether its own
   * resource bundle still claimed that host pid as of that check. Read-only
   * -- see `handlePtyHostCleanupCandidate`'s doc comment for why no action
   * is taken from it in this task's scope.
   */
  lastPtyHostCleanupCandidate(): { hostPid: number; stillClaimed: boolean; atMs: number } | null {
    return this.lastPtyHostCandidate;
  }

  /**
   * Task 3.6: `FastChecker`'s 50-minute idle-session watchdog publishes each
   * tick here as `kind: 'watchdog-heartbeat'`, generation-bound via
   * `event.token`. This is deliberately the ENTIRE handling: record it in an
   * in-memory field for introspection (`lastWatchdogHeartbeatObservation()`)
   * and nothing else. It must NEVER be folded into `outstandingWork()`,
   * never committed to the durable store, and never read by
   * `detectWedge()`'s activity-staleness computation (that clock is owned
   * exclusively by completed-turn evidence -- Task 3.4/`turn-activity.ts`).
   * The watchdog only proves "the daemon subprocess that owns this checker
   * instance is alive enough to run `execFile`" -- it is daemon-liveness
   * evidence about its own producer, never runtime work-progress evidence.
   */
  private handleWatchdogHeartbeat(event: LifecycleObservation): void {
    this.lastWatchdogHeartbeat = {
      agentId: event.token.agentId,
      generation: event.token.generation,
      atMs: event.atMs,
      evidence: event.evidence,
    };
  }

  /**
   * Task 3.6 introspection: the most recent watchdog-heartbeat observation
   * recorded via `observe()`, or null if none has arrived yet. Read-only --
   * nothing in this class consults it to make a lifecycle decision.
   */
  lastWatchdogHeartbeatObservation(): { agentId: string; generation: number; atMs: number; evidence: Record<string, string | number | boolean | null> } | null {
    return this.lastWatchdogHeartbeat;
  }

  /**
   * Step 10: returns the in-memory snapshot, kept in sync with every
   * successful `commit()` this supervisor performs. Before the very first
   * request (nothing adopted/cached yet), falls back to `store.load()`; if
   * even that is corrupt/not-yet-adopted, returns a non-persisted
   * placeholder snapshot (never thrown) so a caller polling `snapshot()`
   * before the first `request()` gets a safe, obviously-inert value instead
   * of an exception.
   */
  snapshot(): LifecycleSnapshot {
    if (this.cached) return this.cached;
    const loaded = this.store.load();
    if ('corrupt' in loaded) {
      return {
        agentId: this.agentId,
        schemaVersion: LIFECYCLE_SCHEMA_VERSION,
        revision: 0,
        supervisorEpoch: 0,
        desiredState: 'stopped',
        desiredStateReason: null,
        desiredStateRequestId: null,
        intentRevision: 0,
        currentGeneration: null,
        nextGeneration: 1,
        phase: 'absent',
        resources: [],
        retiringResources: [],
        outstandingWork: [],
        pendingRequests: [],
        recoveryBudgets: {},
        blockedReason: loaded.reason,
      };
    }
    this.cached = loaded;
    return loaded;
  }

  operation(operationId: string): OperationStatus | null {
    const rec = this.operations.get(operationId);
    if (!rec) return null;
    return { ...rec, coalescedWith: [...rec.coalescedWith] };
  }

  /**
   * Task 3.2: the wiring layer between Task 3.1's pure `work-ledger.ts`
   * transitions and the real durable store. This is the direct mechanical
   * requirement behind Scenario A's closure (PRD.md S2.5): `acceptBatch`
   * persists every input's payload AND its `WorkRecord` durably before it
   * ever resolves -- Task 3.3's rewired `FastChecker.pollCycle()` calls this
   * at the exact seam BEFORE it splices the peeked Telegram/Slack prefix or
   * calls `ackInbox()`, so a bus/inbox ack only ever happens after this
   * method has already returned `ok: true`.
   *
   * Durability ordering (Step 3/4): every input's payload is written to its
   * own immutable ref FIRST, synchronously, before the single snapshot
   * `commit()` below -- if ANY one payload write fails, the whole batch
   * aborts here and nothing is committed (no 2-of-3 partial acceptance). A
   * batch-level conflict (same `sourceKey`, different `payloadDigest` than
   * an already-accepted record) aborts the whole batch the same way, via
   * `AcceptBatchConflictError` thrown from inside the mutate callback and
   * caught immediately below -- never a partially-applied batch.
   *
   * Reuses `commitWithRetry` (not a bare `store.commit()` call) for the same
   * reason every other mutation path in this class does: a `STALE_REVISION`
   * race against this supervisor's OWN other in-flight commits (e.g. a
   * concurrent stop/start decided by the mailbox) is a transient,
   * same-process retry case, not a business-logic conflict -- the mutate
   * callback recomputes the whole batch from the freshly reloaded draft on
   * each attempt, so a retry is still exactly one atomic snapshot
   * transition, never two partial ones layered on top of each other.
   */
  async acceptBatch(
    inputs: Array<{ sourceKey: string; payload: string; payloadDigest: string }>,
  ): Promise<{ ok: true; workIds: string[]; batchId: string } | { ok: false; reason: string }> {
    const batchId = `batch-${randomUUID()}`;

    if (inputs.length === 0) {
      return { ok: true, workIds: [], batchId };
    }

    // Step 3: every payload written durably BEFORE the snapshot commit that
    // will reference it. Abort the whole batch on the first failure.
    const prepared: Array<{ sourceKey: string; payloadDigest: string; payloadRef: string; workId: string }> = [];
    for (const input of inputs) {
      const workId = `work-${randomUUID()}`;
      const written = this.store.writeWorkPayload(workId, input.payload);
      if (!written.ok) {
        return {
          ok: false,
          reason: `payload write failed for sourceKey '${input.sourceKey}': ${written.reason}`,
        };
      }
      prepared.push({ sourceKey: input.sourceKey, payloadDigest: input.payloadDigest, payloadRef: written.ref, workId });
    }

    const nowMs = this.clock();
    const resultWorkIds: string[] = [];

    let result: CommitResult;
    try {
      result = this.commitWithRetry((draft) => {
        // A retried attempt (STALE_REVISION) re-runs this whole callback
        // against a freshly reloaded draft -- reset the accumulator so a
        // retry never double-counts a prior attempt's workIds.
        resultWorkIds.length = 0;

        const owner: GenerationToken = {
          agentId: this.agentId,
          supervisorEpoch: draft.supervisorEpoch,
          // Work can be accepted before any generation is running yet; 0 is
          // a sentinel meaning "no live generation at acceptance time" --
          // real generations start at 1 (state-store.ts's
          // buildInitialSnapshot initializes nextGeneration to 1), mirroring
          // that same file's `supervisorEpoch: 0` "not yet established"
          // sentinel convention.
          generation: draft.currentGeneration ?? 0,
        };

        let runningSnapshot: LifecycleSnapshot = draft;
        for (const item of prepared) {
          const outcome = ledgerAccept(
            runningSnapshot,
            { sourceKey: item.sourceKey, payloadDigest: item.payloadDigest, payloadRef: item.payloadRef, batchId },
            owner,
            item.workId,
            nowMs,
          );
          if ('conflict' in outcome) {
            throw new AcceptBatchConflictError(item.sourceKey, outcome.existing.workId);
          }
          // A duplicate resubmission (existing record, same payloadDigest)
          // still contributes its EXISTING workId to the batch's receipt --
          // a duplicate is a receipt for existing work, not an exclusion.
          runningSnapshot = outcome.snapshot;
          resultWorkIds.push(outcome.record.workId);
        }

        // Step 6: bound terminal history on every accept-batch commit too;
        // future tasks (3.3-3.8) are what actually populate terminal
        // phases, but the archival call belongs here from the start.
        draft.outstandingWork = ledgerArchiveTerminal(runningSnapshot, MAX_RETAINED_TERMINAL_WORK_RECORDS);
      });
    } catch (err) {
      if (err instanceof AcceptBatchConflictError) {
        return { ok: false, reason: err.message };
      }
      throw err;
    }

    if (!result.ok) {
      // Step 8 (mirrored here for work acceptance): fail closed. The caller
      // (Task 3.3's pollCycle) must not ACK the bus/telegram/inbox source.
      return { ok: false, reason: `${result.code}: ${result.message}` };
    }

    return { ok: true, workIds: resultWorkIds, batchId };
  }

  /**
   * Task 3.2 Step 5: work that is not yet resolved (see
   * `work-ledger.ts`'s `outstandingWork` doc comment -- `needs-review`
   * counts as outstanding). Deliberately built on top of the public
   * `snapshot()` getter rather than a raw `store.load()` so a corrupt/
   * not-yet-adopted store is surfaced the exact same way `snapshot()`
   * already surfaces it elsewhere (a non-persisted placeholder with
   * `blockedReason` set, `outstandingWork: []`) -- never silently hiding
   * unresolved work behind a bare empty array with no visible signal.
   */
  outstandingWork(): WorkRecord[] {
    return ledgerOutstandingWork(this.snapshot());
  }

  /**
   * Task 3.5: public wrapper over the existing revalidation fence
   * (`isEffectStale`, Task 1.5 Step 6) so an external dispatch caller (the
   * narrow `LifecycleRequestOwner` interface `agent-process.ts` consults)
   * can apply the exact same "a revoked generation must never reach the
   * runtime" rule this class already applies to its own spawn/retire
   * effects -- true iff `effect`'s `{supervisorEpoch, intentRevision,
   * generation}` still matches the live snapshot.
   */
  isEffectLive(effect: EffectToken): boolean {
    return !this.isEffectStale(effect);
  }

  /**
   * Task 3.5: read-only -- which of `workIds` are already past `'accepted'`
   * (a genuine prior dispatch/execution), for `AgentProcess.injectMessageDetailed()`'s
   * dedup-as-hint check (PHASES.md Task 3.5's Research Findings: the real
   * dedup/idempotency authority is `sourceKey`/`workId` phase progression,
   * not a `MessageDedup` content-hash coincidence). Never mutates. A workId
   * with no matching record at all (unknown/already archived) is omitted --
   * not reported as either dispatched or not.
   */
  dispatchedWorkIds(workIds: string[]): string[] {
    if (workIds.length === 0) return [];
    const idSet = new Set(workIds);
    return this.snapshot()
      .outstandingWork.filter((r) => idSet.has(r.workId) && r.phase !== 'accepted')
      .map((r) => r.workId);
  }

  /**
   * Task 3.5: durably transitions every still-`'accepted'` record among
   * `workIds` to `'dispatched'`, tagged with `batchId` -- the literal
   * "dispatch intent is persisted before external submission" acceptance
   * criterion. Idempotent: a workId already past `'accepted'` (dispatched by
   * an earlier attempt -- e.g. this exact call is itself a retry) is left
   * untouched, never re-transitioned or errored. An unknown workId (no
   * matching record) is silently ignored -- a caller passing a stale/
   * unrecognized workId is not this method's failure to report; the whole
   * point is that a persist FAILURE (not an unknown id) is what must stop
   * the caller from ever reaching the runtime.
   */
  beginDispatch(workIds: string[], batchId: string): { ok: true } | { ok: false; error: string } {
    if (workIds.length === 0) return { ok: true };
    const nowMs = this.clock();
    const idSet = new Set(workIds);
    const result = this.commitWithRetry((draft) => {
      draft.outstandingWork = draft.outstandingWork.map((record) => {
        if (!idSet.has(record.workId) || record.phase !== 'accepted') return record;
        return ledgerMarkDispatched(record, batchId, nowMs);
      });
    });
    if (!result.ok) {
      return { ok: false, error: `${result.code}: ${result.message}` };
    }
    return { ok: true };
  }

  /**
   * Task 3.4 Step 5: apply one `WorkCorrelationEvent` (already namespaced
   * `work-*` by the caller, see `WORK_OBSERVATION_KINDS`) to every matching
   * `WorkRecord` in the ledger, durably. Best-effort by design: this is an
   * async runtime observation arriving out-of-band, not a caller awaiting a
   * receipt, so a commit failure or an illegal-transition record (already
   * terminal, already in a further-along phase, etc.) is silently skipped
   * for THAT record rather than throwing -- the alternative would be an
   * unhandled rejection inside a fire-and-forget adapter callback, which is
   * strictly worse than "this one observation didn't move anything."
   * `evidence.workIds` decode failure is likewise treated as a no-op, not a
   * thrown error.
   */
  private handleWorkObservation(event: LifecycleObservation): void {
    const workIds = decodeWorkIds(event.evidence['workIds']);
    if (workIds.length === 0) return;
    const turnId = typeof event.evidence['turnId'] === 'string' ? (event.evidence['turnId'] as string) : null;
    const reason =
      (typeof event.evidence['error'] === 'string' && (event.evidence['error'] as string)) ||
      (typeof event.evidence['reason'] === 'string' && (event.evidence['reason'] as string)) ||
      event.kind;
    const nowMs = event.atMs;

    this.commitWithRetry((draft) => {
      draft.outstandingWork = draft.outstandingWork.map((record) => {
        if (!workIds.includes(record.workId)) return record;
        try {
          return applyWorkCorrelation(record, event.kind, turnId, reason, nowMs);
        } catch {
          // Illegal transition for this record's current phase (e.g. already
          // terminal) -- leave it untouched rather than throw out of a
          // fire-and-forget runtime callback.
          return record;
        }
      });
      draft.outstandingWork = ledgerArchiveTerminal(draft, MAX_RETAINED_TERMINAL_WORK_RECORDS);
    });
  }

  // --- Mailbox plumbing ----------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.processWindow();
    });
  }

  private processWindow(): void {
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;

    const loaded = this.ensureAdopted();
    if ('corrupt' in loaded) {
      const operationId = randomUUID();
      for (const entry of batch) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: false,
          desiredState: 'stopped',
          phase: 'absent',
          generation: null,
          blockedReason: `store unavailable: ${loaded.reason}`,
          coalescedWith: otherIds(batch, entry.req.requestId),
        });
      }
      return;
    }

    this.cached = loaded;
    this.decideAndCommit(loaded, batch);
  }

  /** First-adoption bootstrap (Task 1.4's `adopt()`). Default initial
   * desired state is `'stopped'` -- a documented Phase 1 choice: nothing is
   * presumed running until an explicit `start`/`resume` request says so. */
  private ensureAdopted(): LifecycleSnapshot | { corrupt: true; reason: string } {
    const loaded = this.store.load();
    if (!('corrupt' in loaded)) return loaded;
    if (loaded.reason !== 'not-yet-adopted') return loaded;
    const adopted = this.store.adopt('stopped');
    if (adopted.ok) return adopted.snapshot;
    return this.store.load();
  }

  /** Compare-and-commit with a bounded retry only on `STALE_REVISION` (an
   * in-process race against the lock, not a business-logic conflict). Any
   * other failure code (`PERSIST_FAILED`, `EPOCH_MISMATCH`, `CORRUPT`,
   * `LOCK_UNAVAILABLE`) is returned immediately -- fail closed, no effect
   * may be scheduled off the back of it (Step 8). */
  private commitWithRetry(mutate: (draft: LifecycleSnapshot) => void, maxAttempts = 5): CommitResult {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const loaded = this.ensureAdopted();
      if ('corrupt' in loaded) {
        return { ok: false, code: 'CORRUPT', message: loaded.reason };
      }
      const result = this.store.commit({ supervisorEpoch: loaded.supervisorEpoch, revision: loaded.revision }, mutate);
      if (result.ok) {
        this.cached = result.snapshot;
        return result;
      }
      if (result.code === 'STALE_REVISION' && attempts < maxAttempts) continue;
      return result;
    }
  }

  private bumpBudget(draft: LifecycleSnapshot, cause: string): void {
    const now = this.clock();
    const existing = draft.recoveryBudgets[cause];
    if (existing) {
      existing.count += 1;
    } else {
      draft.recoveryBudgets[cause] = { count: 1, windowStartMs: now, pausedUntilMs: null };
    }
  }

  private setOperation(operationId: string, phase: ObservedPhase, coalescedWith: string[], blockedReason: string | null): void {
    this.operations.set(operationId, { operationId, phase, coalescedWith, blockedReason });
  }

  private updateOperation(operationId: string, patch: { phase: ObservedPhase; blockedReason: string | null }): void {
    const existing = this.operations.get(operationId);
    if (!existing) return;
    this.operations.set(operationId, { ...existing, ...patch });
  }

  // --- Step 5/9: decision routing ------------------------------------------

  private decideAndCommit(snapshot: LifecycleSnapshot, batch: PendingEntry[]): void {
    const operationId = randomUUID();

    // Absolutes first, unconditionally, before any severity/desired-state
    // gating is even consulted: explicit stop/halt always wins outright
    // over every autonomous cause, and over the halted/quarantined gate
    // below (a stop while already halted, or a halt while already
    // quarantined, both just re-affirm/transition -- never blocked).
    const stopHalt = batch.filter((e) => e.req.kind === 'stop' || e.req.kind === 'halt');
    if (stopHalt.length > 0) {
      this.handleStopHalt(snapshot, batch, stopHalt, operationId);
      return;
    }

    // Step 9: halted/quarantined desired state gates every autonomous
    // request except an explicit `resume`, which is accepted at the
    // arbitration level (deep quarantine reconciliation is Phase 2 scope).
    if (snapshot.desiredState === 'halted' || snapshot.desiredState === 'quarantined') {
      this.handleHaltedGate(snapshot, batch, operationId);
      return;
    }

    this.handleAutonomous(snapshot, batch, operationId);
  }

  // --- Stop / halt (always wins outright) ----------------------------------

  private handleStopHalt(
    snapshot: LifecycleSnapshot,
    batch: PendingEntry[],
    stopHalt: PendingEntry[],
    operationId: string,
  ): void {
    const authoritative = [...stopHalt].sort((a, b) => a.seq - b.seq)[0];
    const target: DesiredState =
      authoritative.req.kind === 'stop'
        ? 'stopped'
        : authoritative.req.cause === 'image-poison'
          ? 'quarantined'
          : 'halted';

    const oldGeneration = snapshot.currentGeneration;
    const oldResources = [...snapshot.resources, ...snapshot.retiringResources];
    const hasWorkToRetire = oldGeneration !== null && oldResources.length > 0;
    const nonAuthoritative = batch.filter((e) => e.req.requestId !== authoritative.req.requestId);

    // Step 4: committing stop/halt sets desiredState and bumps
    // intentRevision in the SAME commit, before any teardown effect begins
    // -- this is what makes "stop can be committed while a start/teardown
    // is in progress" true: the commit here is synchronous, the actual
    // retireGeneration call is scheduled only after, below.
    const result = this.commitWithRetry((draft) => {
      draft.desiredState = target;
      draft.desiredStateReason = authoritative.req.cause;
      draft.desiredStateRequestId = authoritative.req.requestId;
      draft.intentRevision += 1;
      draft.phase = hasWorkToRetire ? 'retiring' : 'absent';
      // Cancels pending start/refresh/delivery effects: any fresh-intent
      // marker carried in pendingRequests is dropped -- a stop/halt is an
      // explicit override, not a generic continue, so nothing survives it.
      draft.pendingRequests = [];
      for (const entry of nonAuthoritative) {
        this.bumpBudget(draft, entry.req.cause);
      }
    });

    if (!result.ok) {
      // Step 8: fail closed. No effect is granted on an uncommitted stop.
      for (const entry of batch) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: false,
          desiredState: snapshot.desiredState,
          phase: snapshot.phase,
          generation: snapshot.currentGeneration,
          blockedReason: `${result.code}: ${result.message}`,
          coalescedWith: otherIds(batch, entry.req.requestId),
        });
      }
      return;
    }

    const post = result.snapshot;
    this.setOperation(operationId, post.phase, allOf(batch), post.blockedReason);

    for (const entry of batch) {
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: true,
        desiredState: post.desiredState,
        phase: post.phase,
        generation: post.currentGeneration,
        blockedReason: post.blockedReason,
        coalescedWith: otherIds(batch, entry.req.requestId),
      });
    }

    if (hasWorkToRetire && oldGeneration !== null) {
      const oldToken: GenerationToken = { agentId: this.agentId, supervisorEpoch: post.supervisorEpoch, generation: oldGeneration };
      void this.runRetire(oldToken, oldResources, operationId);
    }
  }

  // --- Halted/quarantined gate ----------------------------------------------

  private handleHaltedGate(snapshot: LifecycleSnapshot, batch: PendingEntry[], operationId: string): void {
    const resumeEntries = batch.filter((e) => e.req.kind === 'resume');
    const autonomousEntries = batch.filter((e) => e.req.kind !== 'resume');

    if (resumeEntries.length === 0) {
      // Every autonomous cause is rejected outright while halted/quarantined.
      for (const entry of batch) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: false,
          desiredState: snapshot.desiredState,
          phase: snapshot.phase,
          generation: snapshot.currentGeneration,
          blockedReason: `rejected: desiredState is ${snapshot.desiredState}`,
          coalescedWith: otherIds(batch, entry.req.requestId),
        });
      }
      return;
    }

    const authoritative = [...resumeEntries].sort((a, b) => a.seq - b.seq)[0];

    const result = this.commitWithRetry((draft) => {
      draft.desiredState = 'running';
      draft.desiredStateReason = authoritative.req.cause;
      draft.desiredStateRequestId = authoritative.req.requestId;
      draft.intentRevision += 1;
      draft.blockedReason = null;
      for (const entry of autonomousEntries) {
        this.bumpBudget(draft, entry.req.cause);
      }
    });

    if (!result.ok) {
      for (const entry of batch) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: false,
          desiredState: snapshot.desiredState,
          phase: snapshot.phase,
          generation: snapshot.currentGeneration,
          blockedReason: `${result.code}: ${result.message}`,
          coalescedWith: otherIds(batch, entry.req.requestId),
        });
      }
      return;
    }

    const post = result.snapshot;
    this.setOperation(operationId, post.phase, allOf(batch), post.blockedReason);

    for (const entry of resumeEntries) {
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: true,
        desiredState: post.desiredState,
        phase: post.phase,
        generation: post.currentGeneration,
        blockedReason: post.blockedReason,
        coalescedWith: otherIds(batch, entry.req.requestId),
      });
    }

    // Autonomous requests submitted in the same window as the resume were
    // evaluated against the pre-resume halted/quarantined state; they are
    // rejected (their budgets were still charged above) and must be
    // resubmitted after the resume lands.
    for (const entry of autonomousEntries) {
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: false,
        desiredState: post.desiredState,
        phase: post.phase,
        generation: post.currentGeneration,
        blockedReason: `rejected: resubmit after resume (was ${snapshot.desiredState})`,
        coalescedWith: otherIds(batch, entry.req.requestId),
      });
    }
  }

  // --- Autonomous arbitration: severity-wins, causes-retained --------------

  private handleAutonomous(snapshot: LifecycleSnapshot, batch: PendingEntry[], operationId: string): void {
    // A `refresh` whose observedGeneration no longer matches current is
    // rejected as revoked -- individually, before it ever enters arbitration.
    const staleRefresh = batch.filter(
      (e) =>
        e.req.kind === 'refresh' && e.req.observedGeneration !== null && e.req.observedGeneration !== snapshot.currentGeneration,
    );
    for (const entry of staleRefresh) {
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: false,
        desiredState: snapshot.desiredState,
        phase: snapshot.phase,
        generation: snapshot.currentGeneration,
        blockedReason: 'revoked: observedGeneration is stale',
        coalescedWith: otherIds(batch, entry.req.requestId),
      });
    }

    // A `resume` while already running is trivially satisfied.
    const trivialResume = batch.filter((e) => e.req.kind === 'resume' && snapshot.desiredState === 'running');
    for (const entry of trivialResume) {
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: true,
        desiredState: snapshot.desiredState,
        phase: snapshot.phase,
        generation: snapshot.currentGeneration,
        blockedReason: null,
        coalescedWith: otherIds(batch, entry.req.requestId),
      });
    }

    const handled = new Set<string>([...staleRefresh, ...trivialResume].map((e) => e.req.requestId));
    const pool = batch.filter((e) => isAutonomousArbitrable(e.req) && !handled.has(e.req.requestId));
    const leftover = batch.filter((e) => !handled.has(e.req.requestId) && !pool.includes(e));

    for (const entry of leftover) {
      // Defensive: any request kind not otherwise routed (e.g. a `resume`
      // while not running and not halted/quarantined either -- shouldn't
      // occur given decideAndCommit's routing, but never silently dropped).
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: true,
        desiredState: snapshot.desiredState,
        phase: snapshot.phase,
        generation: snapshot.currentGeneration,
        blockedReason: null,
        coalescedWith: otherIds(batch, entry.req.requestId),
      });
    }

    if (pool.length === 0) return;

    // Step 5, rule 3: highest CAUSE_SEVERITY wins; deterministic tiebreak is
    // first-observed-at-this-severity (lowest arrival sequence number).
    const winner = [...pool].sort((a, b) => {
      const sevDiff = CAUSE_SEVERITY[b.req.cause] - CAUSE_SEVERITY[a.req.cause];
      if (sevDiff !== 0) return sevDiff;
      return a.seq - b.seq;
    })[0];

    // Step 5, rule 7 / fresh-intent stickiness: a fresh request already
    // in-flight (carried forward via `pendingRequests`) or present in this
    // window floors the final mode at 'fresh', regardless of which cause won
    // the severity contest.
    const freshFromPool = pool.find((e) => e.req.mode === 'fresh')?.req ?? null;
    const freshFromPrior = snapshot.pendingRequests.find((r) => r.mode === 'fresh') ?? null;
    const freshRequest = freshFromPool ?? freshFromPrior;
    const finalMode: StartMode = freshRequest ? 'fresh' : (winner.req.mode ?? 'continue');

    // Step 5, rule 6: every participating cause's own recovery budget is
    // charged, including the winner's -- Phase 2's recovery-policy.ts
    // (Task 2.3) is what actually consumes/branches on these counters; this
    // module only needs to prove observability of the losing causes'
    // counters, and charging the winner too keeps the accounting uniform.
    const mutateBudgets = (draft: LifecycleSnapshot): void => {
      for (const entry of pool) this.bumpBudget(draft, entry.req.cause);
    };

    // Step 7: a prior blocked retirement keeps the supervisor mapped and
    // refuses to spawn a replacement. The replacement request is still
    // durably accepted -- not rejected -- with phase 'blocked'.
    if (snapshot.phase === 'blocked') {
      const result = this.commitWithRetry(mutateBudgets);
      const post = result.ok ? result.snapshot : snapshot;
      this.setOperation(operationId, post.phase, allOf(pool), post.blockedReason);
      for (const entry of pool) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: true,
          desiredState: post.desiredState,
          phase: post.phase,
          generation: post.currentGeneration,
          blockedReason: post.blockedReason,
          coalescedWith: otherIds(pool, entry.req.requestId),
        });
      }
      return;
    }

    if (winner.req.kind === 'start' && snapshot.desiredState === 'running' && snapshot.phase !== 'absent') {
      // Already running/ready -- a redundant 'start' is trivially satisfied,
      // no new generation.
      const result = this.commitWithRetry(mutateBudgets);
      const post = result.ok ? result.snapshot : snapshot;
      this.setOperation(operationId, post.phase, allOf(pool), post.blockedReason);
      for (const entry of pool) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: result.ok,
          desiredState: post.desiredState,
          phase: post.phase,
          generation: post.currentGeneration,
          blockedReason: result.ok ? post.blockedReason : `${result.code}: ${result.message}`,
          coalescedWith: otherIds(pool, entry.req.requestId),
        });
      }
      return;
    }

    // 'start' (nothing currently running), 'restart', or 'refresh' (both
    // retire-then-start): allocate the new generation now, in the same
    // commit, per Step 4 -- only a *decided* start allocates, never a
    // merely-requested one.
    //
    // Task 2.4: a `refresh` (session-age rollover, or any future refresh
    // cause) performs the exact same retire-then-start allocation as
    // `restart` -- it IS a live generation's "restart in place," not a
    // distinct code path. Task 1.5 originally left `refresh` as a
    // budget-only no-op here (nothing submitted one yet at that point in the
    // build); this is the fix that actually closes deep-dive Scenario B,
    // since a `refresh`'s retire+start must run under ONE operationId with
    // the same isEffectStale() revalidation `restart`/`start` already get --
    // a stop/halt committed after a refresh has begun retiring must still be
    // able to revoke the pending start, exactly as it already does for a
    // restart.
    const oldGeneration = snapshot.currentGeneration;
    const oldResources = [...snapshot.resources];
    const isRestart = (winner.req.kind === 'restart' || winner.req.kind === 'refresh') && oldGeneration !== null;
    const newGen = snapshot.nextGeneration;

    const result = this.commitWithRetry((draft) => {
      mutateBudgets(draft);
      draft.currentGeneration = newGen;
      draft.nextGeneration = newGen + 1;
      draft.desiredState = 'running';
      draft.phase = 'starting';
      draft.blockedReason = null;
      if (isRestart) {
        draft.retiringResources = [...draft.retiringResources, ...oldResources];
        draft.resources = [];
      }
      // Fresh-intent stickiness carried forward as the sole pendingRequests
      // entry; consumed only by the successful start that observes it.
      draft.pendingRequests = freshRequest ? [freshRequest] : [];
    });

    if (!result.ok) {
      for (const entry of pool) {
        entry.resolve({
          requestId: entry.req.requestId,
          operationId,
          accepted: false,
          desiredState: snapshot.desiredState,
          phase: snapshot.phase,
          generation: snapshot.currentGeneration,
          blockedReason: `${result.code}: ${result.message}`,
          coalescedWith: otherIds(pool, entry.req.requestId),
        });
      }
      return;
    }

    const post = result.snapshot;
    this.setOperation(operationId, post.phase, allOf(pool), post.blockedReason);

    for (const entry of pool) {
      entry.resolve({
        requestId: entry.req.requestId,
        operationId,
        accepted: true,
        desiredState: post.desiredState,
        phase: post.phase,
        generation: post.currentGeneration,
        blockedReason: post.blockedReason,
        coalescedWith: otherIds(pool, entry.req.requestId),
      });
    }

    const effectToken: EffectToken = {
      agentId: this.agentId,
      supervisorEpoch: post.supervisorEpoch,
      generation: newGen,
      intentRevision: post.intentRevision,
      effectId: randomUUID(),
    };

    if (isRestart && oldGeneration !== null) {
      const oldToken: GenerationToken = { agentId: this.agentId, supervisorEpoch: post.supervisorEpoch, generation: oldGeneration };
      void this.runRestart(oldToken, oldResources, effectToken, finalMode, operationId);
    } else {
      void this.runStart(effectToken, finalMode, operationId);
    }
  }

  // --- Step 6: effect fencing / revalidation --------------------------------

  private isEffectStale(effect: EffectToken): boolean {
    const current = this.store.load();
    if ('corrupt' in current) return true;
    return (
      current.supervisorEpoch !== effect.supervisorEpoch ||
      current.intentRevision !== effect.intentRevision ||
      current.currentGeneration !== effect.generation
    );
  }

  private async runStart(effect: EffectToken, mode: StartMode, operationId: string): Promise<void> {
    if (this.isEffectStale(effect)) return;

    const result = await this.runtime.startGeneration(effect, mode);

    if (this.isEffectStale(effect)) {
      // Step 6/7: an already-issued spawn belongs to its generation and
      // must be retired, never forgotten -- feed it back as a resource
      // owned by the stale GenerationToken so it gets cleaned up, rather
      // than silently discarding a real spawn.
      if (result.ok && result.resources.length > 0) {
        const staleToken: GenerationToken = {
          agentId: effect.agentId,
          supervisorEpoch: effect.supervisorEpoch,
          generation: effect.generation,
        };
        this.commitWithRetry((draft) => {
          draft.retiringResources = [...draft.retiringResources, ...result.resources];
        });
        void this.runRetire(staleToken, result.resources, operationId);
      }
      return;
    }

    if (!result.ok) {
      const commit = this.commitWithRetry((draft) => {
        draft.phase = 'blocked';
        draft.blockedReason = result.error ?? 'startGeneration failed';
      });
      if (commit.ok) {
        this.updateOperation(operationId, { phase: commit.snapshot.phase, blockedReason: commit.snapshot.blockedReason });
      }
      return;
    }

    const commit = this.commitWithRetry((draft) => {
      draft.resources = result.resources;
      draft.phase = 'ready';
      draft.blockedReason = null;
      // Consume the fresh-intent marker only on the successful start that
      // observed it.
      draft.pendingRequests = draft.pendingRequests.filter((r) => r.mode !== 'fresh');
    });
    if (commit.ok) {
      this.updateOperation(operationId, { phase: commit.snapshot.phase, blockedReason: commit.snapshot.blockedReason });
    }
  }

  private async runRestart(
    oldToken: GenerationToken,
    oldResources: OwnedResource[],
    effect: EffectToken,
    mode: StartMode,
    operationId: string,
  ): Promise<void> {
    const retireResult = await this.runtime.retireGeneration(oldToken, oldResources);

    if (retireResult.status === 'blocked') {
      // Start authority is refused; cleanup authority (this same retire
      // call) still worked against the stale/outgoing generation, per Step 7.
      const commit = this.commitWithRetry((draft) => {
        draft.phase = 'blocked';
        draft.blockedReason = retireResult.reason;
        draft.retiringResources = retireResult.unresolved;
      });
      if (commit.ok) {
        this.updateOperation(operationId, { phase: commit.snapshot.phase, blockedReason: commit.snapshot.blockedReason });
      }
      return;
    }

    this.commitWithRetry((draft) => {
      draft.retiringResources = draft.retiringResources.filter((r) => !sameGeneration(r.owner, oldToken));
    });

    await this.runStart(effect, mode, operationId);
  }

  private async runRetire(token: GenerationToken, resources: OwnedResource[], operationId: string): Promise<void> {
    // Step 7: retireGeneration is never gated behind "is this the current
    // generation" -- cleanup authority works on stale generations too.
    const result = await this.runtime.retireGeneration(token, resources);

    const commit = this.commitWithRetry((draft) => {
      if (result.status === 'retired') {
        draft.resources = draft.resources.filter((r) => !sameGeneration(r.owner, token));
        draft.retiringResources = draft.retiringResources.filter((r) => !sameGeneration(r.owner, token));
        if (draft.phase === 'retiring') draft.phase = 'absent';
        draft.blockedReason = null;
      } else {
        draft.retiringResources = result.unresolved;
        draft.phase = 'blocked';
        draft.blockedReason = result.reason;
      }
    });

    if (commit.ok) {
      this.updateOperation(operationId, { phase: commit.snapshot.phase, blockedReason: commit.snapshot.blockedReason });
    }
  }
}
