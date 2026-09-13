/**
 * Task 3.7: cron ingress ownership.
 *
 * `CronScheduler.tick()` (`cron-scheduler.ts`) treats "onFire resolved
 * without throwing" as delivery — its `fireWithReceiptRetry` retry/backoff
 * loop is driven entirely by throw-vs-no-throw. Before this task,
 * `startAgentCronScheduler`'s `onFire` (`agent-manager.ts`) satisfied that
 * contract by calling the bare boolean `injectAgent()` and throwing a
 * generic `Error` on `false` — a fire that landed mid-teardown (agent
 * stopped, or its EffectToken revoked by an intervening stop/restart) was
 * therefore indistinguishable, at the throw site, from a transient
 * NOT_RUNNING or a genuine ledger conflict.
 *
 * This module is the extracted, dependency-injected dispatch body so it is
 * unit-testable without a live `AgentManager`/`AgentProcess`/PTY (see
 * `tests/unit/daemon/lifecycle-dispatch.test.ts`). It durably accepts the
 * cron's payload via `AgentLifecycleSupervisor.acceptBatch()` (Task 3.1-3.3's
 * ledger) BEFORE ever attempting delivery, then dispatches through the
 * `DispatchResult`-returning `injectAgentDetailed()` path (Task 3.5) instead
 * of the bare boolean. `CronScheduler`'s own throw-to-retry contract is left
 * completely unchanged: every failure path here still throws (so the
 * existing 4-attempt backoff/give-up behavior in `cron-scheduler.ts` is
 * preserved byte-for-byte), but the thrown value is now a structured
 * `CronDispatchError` carrying the real `DispatchResult` code instead of an
 * opaque message string — callers/tests can `instanceof`+`.code` it instead
 * of pattern-matching text.
 */

import type { DispatchResult, EffectToken } from './lifecycle/types.js';

export type AcceptBatchFn = (
  inputs: Array<{ sourceKey: string; payload: string; payloadDigest: string }>,
) => Promise<{ ok: true; workIds: string[]; batchId: string } | { ok: false; reason: string }>;

export interface CronDispatchDeps {
  acceptBatch: AcceptBatchFn;
  mintEffect: () => EffectToken;
  injectDetailed: (text: string, effect: EffectToken, workIds: string[]) => Promise<DispatchResult>;
}

/**
 * Structured cron-dispatch failure. `code` is either one of
 * `DispatchResult`'s four failure codes (a real dispatch outcome from
 * `injectAgentDetailed`) or the synthetic `'ACCEPT_FAILED'` (the durable
 * `acceptBatch` write itself failed — before any dispatch was even
 * attempted, so none of the four real codes apply).
 */
type ExtractFailureCode<T> = T extends { ok: false; code: infer C } ? C : never;
export type CronDispatchErrorCode = ExtractFailureCode<DispatchResult>;

export class CronDispatchError extends Error {
  readonly code: CronDispatchErrorCode | 'ACCEPT_FAILED';
  readonly retryable: boolean;

  constructor(code: CronDispatchErrorCode | 'ACCEPT_FAILED', message: string, retryable: boolean) {
    super(message);
    this.name = 'CronDispatchError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Durably accept then dispatch one cron fire attempt.
 *
 * Resolves (no throw) only when `injectAgentDetailed` reports `ok: true`.
 * Every other outcome throws `CronDispatchError` — `cron-scheduler.ts`'s
 * `fireWithReceiptRetry` treats any throw as "this attempt failed, retry per
 * the existing backoff/give-up policy", exactly as it did for the old bare
 * `Error`. `DUPLICATE` is intentionally still a thrown (non-retryable)
 * outcome here, not a silent success: a duplicate on a FIRST dispatch
 * attempt for a fresh `sourceKey` should not happen, and surfacing it as a
 * structured, non-retryable failure lets an operator see the anomaly rather
 * than have it silently swallowed as "delivered".
 */
export async function dispatchCronFire(
  sourceKey: string,
  injection: string,
  payloadDigest: string,
  deps: CronDispatchDeps,
): Promise<void> {
  const acceptResult = await deps.acceptBatch([{ sourceKey, payload: injection, payloadDigest }]);
  if (!acceptResult.ok) {
    // A durable-write failure is a transient infrastructure condition (disk,
    // lock contention), not a business-logic rejection — retryable.
    throw new CronDispatchError('ACCEPT_FAILED', `durable acceptance failed: ${acceptResult.reason}`, true);
  }

  const effect = deps.mintEffect();
  const dispatchResult = await deps.injectDetailed(injection, effect, acceptResult.workIds);
  if (!dispatchResult.ok) {
    throw new CronDispatchError(dispatchResult.code, dispatchResult.message, dispatchResult.retryable);
  }
}
