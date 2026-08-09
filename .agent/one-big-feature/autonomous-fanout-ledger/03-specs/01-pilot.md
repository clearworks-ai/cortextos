# Spec — Larry-owned autonomous fan-out ledger pilot

## Specify: PASS (final bytes recorded in `05-specify-evidence.json`)

This is backend-only; UI mockup gate is N/A. The spec is grounded by `01-research.md`, the
live source probes listed there, the Fable analysis in `01-fable-analysis.md`, and a Codex
adversarial review. No external API or database write is required for WS1/WS2.

## Requirements

**FR-001 — durable run projection.** WHEN Larry starts the pilot THE SYSTEM SHALL persist a
run ID, goal, workstream ID, state, attempt, route, input SHA, lease/fence, and event path
using atomic writes.

**FR-002 — real dispatch trace.** WHEN the coordinator dispatches the pilot worker THE SYSTEM
SHALL emit status events for dispatch, heartbeat, receipt, and observed result, all carrying
the same run/workstream/attempt/fence identifiers.

**FR-003 — provenance binding.** WHEN the pilot dispatches the `plan` worker-dispatch fixture
`fixtures/autonomous-fanout-ledger/plan-worker/` THE SYSTEM SHALL bind artifact
`02-master-plan.md`, its frozen scope SHA, `reply_to`, the worker return-message JSON, and the
same-slug signed `research` predecessor through `pipeline-stage-emit`. The expected terminal
row is `plan`; missing transcript, missing `reply_to`, or SHA mismatch SHALL block. A generic
worker success is not a ledger row.

**FR-004 — recovery.** WHEN the coordinator or worker is killed after dispatch THE SYSTEM
SHALL reclaim the expired lease, reject stale completion, and resume or retry without duplicate
completion or unsigned stage advancement.

**FR-005 — fan-out readiness (deferred).** A follow-up goal, not this pilot, SHALL dispatch
three independent, file-disjoint workstreams concurrently in isolated worktrees only after a
staging profile and evidence contract are approved.

**FR-006 — real finish gate (deferred).** The follow-up fan-out goal SHALL run staging
verification and true-verify with non-empty evidence; this wiring pilot SHALL not claim PR-ready.

## Grounding ledger

| ID | Claim | Probe/evidence | Verdict |
|---|---|---|---|
| G-01 | Signed ledger exists | `src/pipeline/ledger.ts`, `bin/pipeline-stage-emit` | VERIFIED |
| G-02 | Staging verify is real code | `src/pipeline/staging-verify/runner.ts`, `cli.ts`, `evidence.ts` | VERIFIED |
| G-03 | `/goal` is one-shot today | `src/pty/codex-app-server-pty.ts`, `src/daemon/goal-runner.ts` | VERIFIED |
| G-04 | Existing DAG supervisor exists | `rg` over `src/daemon` finds none | FALSE |
| G-05 | Dynamic pipeline is proven | no successful end-to-end run found; required stages absent | FALSE |

## Frozen fixture and runtime contract

WS1 uses a fixture directory containing the exact plan artifact, a signed research predecessor
for the same slug, and a manifest that records their SHA-256 values at fixture setup. The worker
return message is captured at runtime; its random message ID is never precommitted. The test
sets `CTX_ROOT` to an isolated temporary bus root and `PIPELINE_SECRET_PATH` to an isolated test
secret; it never reads the user's live ledger or inbox. The real configured worker writes its
receipt to the isolated bus processed path. The coordinator emits a `pipeline_dispatch/v1`
analytics event containing run/workstream/attempt/fence, message ID, stage, artifact SHA, and
scope SHA. It then runs `bin/pipeline-stage-emit --slug autonomous-fanout-ledger --stage plan
--artifact <fixture-plan> --provenance-mode worker-dispatch --runner opencode --session
<captured-return-message-id> --transcript <captured-return-message-json> --bus-store-root
<CTX_ROOT> --ctx-root <CTX_ROOT> --ledger <fixture-ledger> --secret <fixture-secret>`. The
assertion is RED unless the worker-produced receipt, `pipeline_dispatch/v1` event, and terminal
`plan` row contain the same run/workstream/attempt/fence and artifact SHA, and the existing
`agent_message_sent` event contains the matching transport message ID and `reply_to`.

## Supervisor ownership

The future implementation owns the tick in Larry's daemon `AgentProcess` lifecycle: start one
`PipelineSupervisor` after agent startup, acquire a singleton lock under the run root, tick every
15 seconds, scan on startup, renew leases every 60 seconds, and stop/release the lock during
shutdown. WS2 kills that owner and starts a second owner against the same run root; only the
fenced owner may mutate the projection.

## Hard-gate scope

WS1/WS2 gates are limited to run projection, real worker receipt, analytics event trace, lease
recovery, and signed `plan` provenance. Review, staging-verify, true-verify, PR, and three-lane
fan-out are explicitly out of scope for this goal and require a new Specify/Goalify run.

## Concrete WS1 trace contract

The coordinator uses exactly `node dist/cli.js bus send-message <worker> normal "GATE: plan ..."`
with `CTX_ROOT` set to the Larry runtime root. The message is written to
`CTX_ROOT/inbox/<worker>/` by `src/bus/message.ts`; the sender logs `agent_message_sent` to
`<analyticsDir>/events/<agent>/YYYY-MM-DD.jsonl` through `src/bus/event.ts`. The acceptance
trace requires existing `agent_message_sent` transport fields (`msg_id`, `to`, `reply_to`) and
separately joins run/workstream/attempt/fence/artifact SHA from the worker receipt and the new
`pipeline_dispatch/v1` event to the terminal ledger row. The worker must be observed in the
target inbox/processed receipt, not simulated by the coordinator.

## Lease contract

Lease TTL is 5 minutes, heartbeat cadence 60 seconds, and reclaim requires an atomic revision
compare-and-swap plus monotonically increasing fence. Every dispatch, heartbeat, and completion
carries `(runId, workstreamId, attempt, fence, leaseToken, inputSha)`. Expired leases retry with
60s/120s/240s backoff, max 3 attempts. Blockers are `PROVENANCE_PENDING`, `WORKER_TRANSIENT`,
`HUMAN_APPROVAL`, and `TERMINAL_POLICY`; only a matching receipt or explicit resume wakes a
blocked workstream.

## Out of scope

No Rust rewrite, provider-adapter rewrite, staging deploy, three-lane fan-out, production
promotion, broad fleet migration, or automatic merge to main.
