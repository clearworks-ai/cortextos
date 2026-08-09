# Master plan — autonomous fan-out ledger pilot

**Slug:** `autonomous-fanout-ledger`  
**Owner:** Larry/Codex coordinator  
**Framework:** one-big-feature pilot; no UI or production deploy in this run.

## Goal

Make one Larry-owned pipeline run durable and restartable, proving the existing task bus,
worker runtime, signed provenance ledger, and analytics event stream form one observable trace.
This first goal does not claim staging/true-verify or general fan-out; those are a second goal.

## Workstreams

### WS1 — signed plan/spec wiring pilot (first)

Add a file-backed run/workstream projection and a coordinator reconciliation tick around the
existing primitives. Dispatch exactly one `GATE: plan` worker-dispatch through
`cortextos bus send-message` using the frozen fixture and isolated `CTX_ROOT`/secret described
in the spec. Record worker-produced heartbeat, receipt, ledger emission, and analytics event with
one run/workstream ID. Missing transcript/SHA mismatch are blockers, never successful rows.

### WS2 — recovery and fencing (depends on WS1)

Persist leases, expiry, attempt, and fencing token in the Larry daemon-owned supervisor. Reconcile
a killed worker/supervisor, reject stale completion, and resume without duplicate completion or
unsigned ledger rows.

### WS3 — bounded fan-out (separate follow-up goal; depends on WS2)

Create three disjoint worktrees from a plan DAG, dispatch independent lanes concurrently, and
join only after signed artifact receipts. Do not dispatch this until an approved staging profile,
safe scenario, and evidence contract are named and re-specified.

## Hard gates

For this WS1/WS2 goal: `/specify` pass; `/goalify` condition installed; planner confirmed;
worker receipt bound to exact plan artifact SHA; analytics dispatch/receipt trace; lease recovery;
signed `plan` row. Review, specs, staging, true-verify, and PR are follow-up-goal gates, not gates
for this pilot.

## Acceptance

The first goal is complete only when WS1 and WS2 hold with reproducible evidence. WS3 and
production promotion remain explicitly deferred and Josh-gated.
