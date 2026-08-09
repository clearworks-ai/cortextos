# Autonomous fan-out goal ledger — Fable analysis (design only)

Date: 2026-08-08  
Scope: architecture/migration proposal; this document does **not** claim that any proposal is implemented.

## Executive finding

The repository has two useful but disconnected mechanisms. The pipeline ledger is a signed, append-only **linear stage chain** (`research → synthesize → plan → specs → implement → review → staging-verify → true-verify`) with artifact hashes, HMAC signatures, transcript replay, and worker-dispatch attestation. The durable `/goal` control plane is an atomically-written per-run JSON record with a single lease, one Codex thread, one prompt, and build/test verification. Neither is a durable scheduler for a multi-workstream DAG. The observed “stall” is therefore expected: one `processTick()` is kicked by `/goal`, executes one turn, and exits; provenance errors are terminal exceptions rather than recoverable ledger work; there is no daemon supervisor that wakes, fans out ready work, renews leases, or reconciles stale workers.

## Live versus documented/proposed

| Surface | Status observed | Consequence |
|---|---|---|
| `src/pipeline/ledger.ts` + `bin/pipeline-stage-emit` | **Live** signed JSONL chain; HMAC, hash chaining, transcript replay for authored stages, signed bus replies for plan/specs, evidence required for staging/true verify | Protects artifact provenance, but one slug/stage and latest predecessor are selected; no run/workstream identity, attempts, leases, or fan-out edges |
| `src/pipeline/staging-verify/*` | **Live** in-process apply/deploy/migrate/seed/drive/read-state/verify loop, bounded transient retries, atomic evidence, signed emit after review | Recovery is only while the process remains alive; a daemon restart loses loop position; not a general goal scheduler |
| `GoalRunStore`, `GoalStateMachine`, `GoalLeaseProtocol`, `GoalRunner` | **Live but opt-in** (`CXR_GOAL_DURABLE=true`); atomic per-file records and one 5-minute lease; `processTick()` claims candidates and runs one thread turn then verifier | No periodic supervisor, heartbeat renewal, workstream records, DAG, stage dispatch, or automatic continuation after a turn unless another tick occurs |
| `CodexAppServerPTY` | **Live** adapter; `/goal` enqueues and calls `processTick()` asynchronously; dedicated thread is created/resumed | Invocation is one-shot; `dispatchPrompt` does not provide completion/heartbeat semantics to the ledger |
| `PIPELINE.md` | **Documented canonical design** (Gemini research, Opus synthesis/review, Fable/Opus plan, DeepSeek light, Codex heavy, staging + true verify + PR) | It is a runbook, not an executable scheduler; it explicitly notes routing gaps |
| `dynamic-pipeline.js` | **Documented/code artifact, not operationally proven**: it declares explore/plan/implement/merge/review/PR, but no successful end-to-end autonomous run was found; it also lacks research/synthesize/staging-verify/true-verify and durable fan-out | Do not treat this file as a working scheduler or migration foundation; require an end-to-end proof before retaining any part |
| `routing-config.json` | **Live config**: explore Gemini, plan Fable/confirmation, implement Codex, review Opus; missing research/synthesize/true-verify and light implementation | `routing-config.proposed.json` is reconciliation proposal only, not live |
| goal-run control-plane spec, Graphify/goalify/specify docs | **Documented**; goalify hard-requires Specify and demands concurrent isolated lanes, but no implementation binds those requirements to GoalRunner | Treat as acceptance policy and migration source, not evidence of runtime behavior |

## Transcript root causes (Larry rollout 2026-08-07/08)

The transcript repeatedly reports a valid research/plan/spec/implementation artifact being unable to advance because the emitter required a terminal signed `specs` row. The normal transcript path rejected the Codex session with `TRANSCRIPT_MISSING`; the worker path then rejected replies when the recomputed artifact SHA differed from the frozen expected SHA (`b0a3befb` vs `9bb2d544`, followed by stale `9c4b1d84`). Larry explicitly stopped rather than fake a row. This is correct safety behavior, but there was no alternate reconciliation state, no durable “provenance pending” queue, and no supervisor to retry after the correct transcript/worker receipt arrived. The run also shows one build dispatch rejected with `No terminal row for ...:specs`, then review/remediation messages arriving while other lanes were stopped. In short: strict gates are present; orchestration around gate failures is absent, and multi-lane work was serialized behind a single global gate. Josh's correction is important: `dynamic-pipeline.js` has never been proven operational; the only partially working coordinator was Larry's direct harness flow. The two Codex/control-plane attempts also failed to deliver autonomous execution. The repair should therefore operationalize one Larry-owned coordinator/supervisor, using Codex as a worker/main Larry runtime only where a live path proves it, rather than assuming the dynamic script or control-plane design is salvageable.

## Proposed ledger model

Keep the existing signed JSONL as the immutable evidence spine. Add a separate atomically-written run aggregate (or SQLite later) under `state/goal-runs/<agent>/<runId>/`:

```ts
type RunState = 'queued'|'gating'|'fanout'|'joining'|'reviewing'|'staging_verify'|
  'true_verify'|'pr_ready'|'blocked'|'retry_wait'|'done'|'exhausted'|'cancelled';
type WorkState = 'pending'|'ready'|'leased'|'running'|'succeeded'|'failed'|
  'retry_wait'|'blocked'|'cancelled';
interface PipelineRun {
  runId: string; slug: string; goal: string; repo: string; worktreeRoot: string;
  state: RunState; specPath: string; specifyPassSha?: string; goalConditionSha?: string;
  planner: 'fable'|'opus'|'kimi-k3'; plannerConfirmed: boolean;
  maxAttempts: number; attempt: number; revision: number;
  workstreams: Workstream[]; gates: GateState[]; eventsPath: string;
  createdAt: string; updatedAt: string;
}
interface Workstream {
  id: string; phase: 'research'|'explore'|'synthesize'|'plan'|'specs'|'implement_light'|
    'implement_heavy'|'review'|'staging-verify'|'true-verify'|'pr';
  deps: string[]; files: string[]; lane: string; route: Route;
  state: WorkState; attempt: number; maxAttempts: number;
  lease?: Lease; artifact?: ArtifactRef; blocker?: Blocker;
}
interface Lease { owner: string; token: string; expiresAt: string; heartbeatAt: string; fence: number; }
interface GateState { name: string; status: 'pending'|'pass'|'fail'|'exempt'|'blocked';
  required: boolean; artifactSha?: string; evidencePath?: string; reason?: string; }
```

Every state mutation is a CAS/atomic write carrying `revision`; every event is append-only and includes `runId`, `workstreamId`, `attempt`, `from/to`, lease fence, route/model, action, observed result, causal event ID, and artifact/evidence SHA. Store the signed ledger row ID/SHA on `ArtifactRef`; never replace or edit signed rows.

## State machine and DAG

At intake: `queued → gating` only after a planner choice is recorded (`plannerConfirmed=true`). `gating` requires Graphify freshness for large repos, research/explore, Opus synthesis, then **Specify PASS before Goalify**, and a signed `plan` plus signed `specs` row. Plan output defines a DAG. Independent domains become `ready` concurrently in isolated worktrees; dependencies move to `ready` only after all predecessor artifact hashes are present. A join waits for every required lane; a failed lane retries itself, not the entire run. Join → `reviewing` (cheap diff-scoped lens then Opus review as configured), then `staging_verify` (if applicable), then `true_verify` with live evidence, then `pr_ready`; PR creation is a final signed action and merge remains Josh-gated. Any required gate failure routes to the owning implementation lane with the exact failure/evidence; missing credential, approval, ambiguous spec, or exhausted retries enters `blocked`/`exhausted` with no silent bypass.

Gate semantics:

* Specify and Goalify are hard prerequisites; a draft spec/goal condition is not trusted until its signed artifact SHA is bound.
* `pipeline-stage-emit` remains the only way to earn stage completion. For Claude-authored stages retain transcript replay; for Opencode plan/spec replies retain HMAC bus signature, `reply_to` dispatch, exact slug/stage/scope SHA, and worker-attested artifact SHA.
* `staging-verify` and `true-verify` require non-empty evidence; true verify must include live run, acceptance comparison, and saved screenshot/output/log. A build/test pass alone never promotes.
* Review/verify failures are retryable work items (bounded); only a signed, evidence-bearing pass advances the DAG. Exempt is a signed row with reason and only for non-runnable artifacts.

## Supervisor and recovery loop

Add one daemon-owned `PipelineSupervisor` (started with agent manager, stopped cleanly) ticking every 15–30 seconds and on event notifications. Each tick: load runs, recover malformed/partial records into `blocked`; reclaim expired leases by incrementing fence; renew leases for active workers; reconcile worker message stores and artifact hashes; evaluate gate/DAG readiness; dispatch up to a configured concurrency; emit rich action/result events; and schedule next tick at the earliest retry/lease expiry. Dispatch is idempotent on `(runId, workstreamId, attempt, inputSha)`.

Workers heartbeat at least every leaseTTL/3. A worker completion must include run/workstream/attempt/fence and artifact SHA; stale completions are rejected and logged. Crash after dispatch but before completion is recovered by lease expiry and either receipt reconciliation or a new attempt. Backoff is exponential with jitter and a global max; classify failures as retryable (transport/429/transient process), gate-fail (return to owner lane), human (credentials/approval/ambiguity), or terminal (policy violation/provenance mismatch after bounded repair). “Blocked” is observable and wakes on a matching external event or manual resume; it does not spin.

## Smallest viable migration path (no claim this is done)

1. Choose Larry's direct coordinator as the single owner. Instrument one real pilot run end-to-end first (task bus → worker → signed ledger → status/activity), and prove existing MultiCA/task bus/ledger/staging primitives are actually wired before adding types. Treat `dynamic-pipeline.js` and prior Codex control-plane attempts as references/failure evidence, not runtime dependencies.
2. Introduce `PipelineRun`/`Workstream`/event types and a file-backed `PipelineRunStore` reusing existing atomic/lock utilities; add supervisor tick lifecycle to the Larry daemon. Keep current `GoalRun` as a compatibility projection.
3. Refactor `GoalRunner.processTick()` into `reconcileTick()` that is safe to call repeatedly; add lease renewal, expired-run discovery, `nextReadyWorkstreams()`, and bounded dispatch adapter. Initially dispatch one workstream at a time behind a feature flag, then raise concurrency only after a live fan-out proof.
4. Persist DAG generated by the existing plan schema; enforce worktree per independent lane and route table (Gemini/Opus/Fable/DeepSeek/Codex/Opus). Add deterministic `specifyPassSha`, `goalConditionSha`, and planner confirmation checks before dispatch.
5. Make provenance failures first-class `blocked` events with retry instructions and a reconciliation command that rechecks transcript roots/bus receipts; do not weaken `ledger.ts` checks. Bind every successful workstream to the existing signed row and retain append-only ledger history.
6. Add staging/true-verify workers as resumable adapters around `runLoop`; serialize `RunContext`/stage records and evidence path after each stage so restart resumes at the first incomplete stage. PR remains a signed gate and Josh approval.
7. Enable supervisor for one pilot slug; then migrate existing goal runs by creating a single synthetic workstream from their current state, preserving IDs/artifact SHAs, never rewriting history.

## Acceptance tests (minimum)

1. Restart recovery: kill supervisor after dispatch; next process reclaims expired lease, resumes the exact thread/worktree, and does not duplicate completion.
2. Fan-out: a plan with three independent lanes dispatches all three concurrently, each in a distinct worktree; dependent lane remains pending until all required predecessor artifact SHAs are signed.
3. Lease fencing: two supervisors race; exactly one lease wins; stale heartbeat/completion cannot mutate state and yields an event.
4. Provenance repair: missing transcript and SHA mismatch produce `blocked` with exact code/paths; arrival of a valid signed worker receipt wakes only that workstream and advances it; no unsigned/manual row can pass.
5. Gate routing: review fail returns to owning implementation lane; staging/true-verify failure returns exact evidence; evidence-less or build-only success cannot advance.
6. Retry policy: transient failures back off and retry up to bound; human/credential blockers become `blocked`; exhausted attempts become `exhausted` with final evidence.
7. Event/status contract: every dispatch, heartbeat, reclaim, gate, blocker, retry, and transition event contains run/workstream/attempt/fence, observed result, and causal ID; status survives restart.
8. Provenance regression: existing ledger tests for HMAC chain, transcript replay, worker `reply_to`/scope binding, stale artifact rejection, phase locks, and staging evidence remain green.
9. End-to-end pilot: Larry direct coordinator drives Graphify freshness → research → Opus synthesize → Specify PASS → confirmed Fable/Opus plan → Goalify → parallel implementation → review loop → staging verify → true verify evidence → PR-ready; no step requires a manual prompt, while merge remains human-gated. A passing unit test or a run through `dynamic-pipeline.js` alone is insufficient.

## Risks and mitigations

* **Concurrent worktree/file collisions:** require planner-declared ownership and reject overlap; serialize only shared merge/review.
* **Duplicate external side effects:** idempotency keys per dispatch/attempt, staging safety boundary, and no automatic production writes.
* **Lease split-brain:** fencing token checked by every store mutation and worker receipt; short TTL plus heartbeat.
* **Provenance deadlock:** never bypass signatures; add bounded repair/reconciliation and explicit blocker wakeups.
* **Event/ledger divergence:** signed ledger remains authority for stage completion; run aggregate is scheduling projection and can be rebuilt from events/ledger.
* **Cost/runaway loops:** concurrency and retry budgets, exponential backoff, per-stage caps, and terminal `exhausted` state with evidence.
* **Compatibility:** feature-flag supervisor, preserve native `/goal` projection and old linear runs, and migrate one pilot before fleet rollout.
* **Disconnected existing primitives:** MultiCA, task bus, signed ledger, goal runner, staging verifier, and activity/status are present but not guaranteed live. Add a wiring/health check and reject “green” until observed worker dispatch, receipt, ledger row, and status event form one trace.
