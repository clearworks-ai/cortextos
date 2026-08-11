# Meeting-Intelligence Chain — Completion Tracker (Spec 1 of 3)

> Durable work-tracking doc. Backing spec: `state/specs/meeting-intelligence-chain-spec-2026-08-10.md`
> (validator-PASS, adversarial-converged r3). GOAL condition: `state/specs/meeting-intelligence-chain-GOAL-2026-08-10.md`.
> **Marked off as work completes.** Started 2026-08-10.

## DONE definition (from GOAL)
An FR is DONE only when a REAL meeting event yields the REAL artifact on the running daemon
(filed `knowledge/meetings/*.md`, bus task, crm interaction row, deal-stage row), true-verified —
config/test-green is NOT done. Chain complete = all FRs live-verified + 2 dupes retired.

## Legend
- ✅ done + verified   🟡 in progress   ⏳ blocked (gate)   ⬜ not started   ❌ gap found

---

## PHASE 0 — Code merge status (source: git log on main)

| FR | Requirement | PR | Merged | Code-verify | Live receipt |
|----|-------------|----|--------|-------------|--------------|
| FR-001 | `meeting_type` classify (sales/delivery/internal/other) + confidence | #341 | ✅ | ⬜ | ⬜ |
| FR-009 | root-cause emit miss (verdict doc) | — | ✅ | ✅ (doc) | n/a |
| FR-002 | emit `crm.meeting.completed` via daemon onDone code path, exactly-once | #342 | ✅ | ⬜ | ⬜ |
| FR-003 | owner→attendee ordered match (abbey bug gone) | #344 | ✅ | ⬜ | ⬜ |
| FR-004 | A6 triple-sink (bus task + approval + BRIEFS + Telegram), dedup by commitmentId | #346 | ✅ | ⬜ | ⬜ |
| FR-005 | followup-coordinator daemon-dispatched ALL types, consumes fanout rows | #347 | ✅ | ⬜ | ⬜ |
| FR-006 | deal-debrief sales-only | #348 | ✅ | ⬜ | ⬜ |
| FR-007 | CRM interaction universal + deal-stage sales-only | #345 | ✅ | ⬜ | ⬜ |
| FR-008 | idempotent + concurrency-safe (locks) | #350 | ✅ | ⬜ | ⬜ |
| FR-010 | inbound-comms deal-signal + commitment-completion | — | ⏳ DEFERRED | — | — |

FR-010 is explicitly deferred until Spec-2's email lane is active. Out of scope for this pass.

---

## PHASE 1 — Adversarial code verification (autonomous, read-only)
Each merged FR gets an independent skeptic: does the code on `main` actually implement the spec
requirement? Cite file:line. Flag any gap between "merged" and "correct."

| FR | Verdict | Notes |
|----|---------|-------|
| FR-001 | ⬜ | |
| FR-002 | ⬜ | |
| FR-003 | ⬜ | |
| FR-004 | ⬜ | |
| FR-005 | ⬜ | |
| FR-006 | ⬜ | |
| FR-007 | ⬜ | |
| FR-008 | ⬜ | |

---

## PHASE 2 — Staging validation (autonomous, `cortextos-staging`)
Staging-first is non-negotiable. Inject a synthetic meeting event through the chain on the
staging instance; capture receipts; confirm coverage-equivalence vs the 2 dupes.
Scripts: `scripts/staging/{staging-up,staging-seed,staging-verify,staging-down}.sh`.

- ⬜ staging daemon up (cwd=FW_ROOT, `CTX_INSTANCE_ID=cortextos-staging` pinned every call)
- ⬜ synthetic sales meeting injected → receipts captured
- ⬜ synthetic delivery meeting injected → NO deal-stage touched
- ⬜ coverage-equivalence: fanout BRIEFS rows == old frank2 worker rows
- ⬜ coverage-equivalence: crm-sync upsert+interaction == old fireflies-ingest (minus abbey blanket)
- ⬜ zero-commitment meeting → doc filed, event emitted, 0 followups

---

## PHASE 3 — Retirement PR (prepared, HELD until live gate)
Per `state/specs/retirement-plan-2026-08-10.md`. Both dupes still present as of 2026-08-10:
- `orgs/clearworksai/agents/frank2/.claude/skills/meeting-commitments-worker/` + paired cron
- `crm/fireflies-ingest.py` `build_followups` (`:509`) + `contacts[0]` blanket (`:590`)

- ⬜ retirement diff prepared on a branch (NOT merged)
- ⬜ frank2 skill + paired cron removed in same change
- ⬜ crm `build_followups` deleted, upsert redirected to FR-007 crm-sync
- ⬜ crm `AGENTS.md` runbook updated (daemon dispatches, not LLM-notices)

---

## PHASE 4 — Josh-gated (HALT — do NOT auto-execute)
- ⏳ prod-promote new `dist/` + daemon restart (`touch /tmp/josh-approved-daemon-restart-<YYYYMMDDHH>`)
- ⏳ prod live receipt: a REAL fireflies meeting through the running daemon → real artifacts
- ⏳ merge retirement PR (only after prod live receipt confirms coverage)
- ⏳ PR #338 (`--bare` lean worker) promote before real spawns run lean

---

## LOG
- 2026-08-10: Tracker created. Established FR-001–008 all merged to main, FR-009 done (doc),
  FR-010 deferred. Both dupes confirmed still present. Staging scripts present. Kicking off
  Phase 1 adversarial code verification.
