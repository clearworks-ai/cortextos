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
| FR-001 | ✅ | meeting_type + confidence in output (ff-extractor.py:2162-2163); conf<0.6→other+NEEDS-REVIEW real (:1074-1075, :2105-2111). |
| FR-002 | ✅ | daemon onDone code path (agent-manager.ts:1247-1260, meeting-event-emit.ts:110-191); exactly-once dedup `crm.meeting.completed:<id>`; failure→`crm.meeting.failed`; per-meeting payload file (no /tmp collision). |
| FR-003 | ✅ | ordered match email>name>unique-first (ff-extractor.py:377-447); NEEDS-OWNER routed not dropped; commitmentId sha1 per spec (:450-457); contacts[0] blanket bypassed (retired path). |
| FR-004 | ✅ | triple-sink all present (meeting-fanout.py:294/304-315/346); approval only client-facing; dedup by commitmentId; Telegram batched per-meeting; NEEDS-OWNER→triage. 20/20 tests. |
| FR-005 | ✅ | daemon spawns coordinator all types (meeting-consumer-dispatch.ts:191-216); dedup `meeting-coord:<id>`; creates NO followups (recap+tracker only). Minor: dedup-undo comment/code mismatch on skip (non-blocking). |
| FR-006 | ✅ | sales-only gate real (meeting-consumer-dispatch.ts:220 `=== 'sales'`); non-sales excluded; dedup `meeting-debrief:<id>`; daemon-spawned. Minor: strict-lowercase compare, no case-normalize (non-blocking). |
| FR-007 | 🟡 | universal interaction + sales-only deal-stage correct. **PARTIAL: 4/26 engagements have clearpath_id:null → deal-stage write silently skipped (meeting-crm-sync.py:296-309), fails-safe. `--engagement-name` fallback exists but unused.** → FIX in Phase 1b. |
| FR-008 | ✅ | idempotency + zero-commitment OK. "Race" was vs `sync_client_context`, which is DEAD in prod (no cron/worker) → writeback is sole live `.md` writer, already locked. NO fix needed. Latent note: don't revive sync as a `.md` writer. |

---

## PHASE 1b — Gap fixes (from Phase 1 verification)
- ✅ **FR-007 fix**: `meeting-crm-sync.py` now selects the matched engagement via
  `--engagement-name` when `clearpath_id` is null. Regression test added (11/11 pass).
  **PR #352** (`fix/fr-007-name-only-engagement-dealstage`) — pending merge + staging receipt.
- ✅ **FR-008**: CLOSED, no fix needed. The second writer (`sync_client_context`) is dead in prod;
  writeback is sole live `.md` owner, already locked. Option A was built + rejected at staging
  (would drop curated History). See Phase 2 + the spec. Net: no code change.

---

## PHASE 2 — Staging validation (autonomous, `cortextos-staging`)
Staging-first is non-negotiable. Inject a synthetic meeting event through the chain on the
staging instance; capture receipts; confirm coverage-equivalence vs the 2 dupes.
Scripts: `scripts/staging/{staging-up,staging-seed,staging-verify,staging-down}.sh`.

### FR-008 — CLOSED, NO FIX NEEDED (2026-08-10)
The flagged "race" is writeback vs `sync_client_context`. But `sync_client_context` is DEAD in
prod (no live cron, missing worker skill) → there is no second live `.md` writer. Writeback is
sole owner and already lock-guarded for writeback-vs-writeback. **No live data-loss risk; no code
required.** (Confirmed the inverse the hard way: building Option A + validating on real `alloi.md`
showed a CRM-rebuild would DROP curated multi-source History — the `.md` is a curated accumulator,
not a read-cache. `fix/fr-008-client-md-single-owner` abandoned, not merged.) Latent caveat only:
never revive `sync_client_context` as a `.md` writer; a CRM view goes to a separate file.

### Meeting-chain end-to-end staging (still to run once FR-008 is settled)
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

## PHASE 4 — Josh-gated
- ✅ FR-007 fix merged to main (PR #352 → 40037d5c). `dist/` clean-rebuilt from main (removed a
  stale FR-008-branch build the subagent left in dist — restart landmine, now gone).
- ⚠️ **BLOCKER — no safe restart mechanism.** Prod daemon (pm2 `cortextos-daemon`, id 1) is
  supervised ONLY by pm2, but the GOAL bans `pm2 restart cortextos-daemon` (fleet kill-switch).
  The prescribed `/tmp/josh-approved-daemon-restart-*` gate has NO watcher in code (grep empty).
  So arming the chain (loading new `dist/`) has no documented safe path. **Needs Josh: the actual
  restart procedure, or Josh restarts.**
- ⏳ prod live receipt: consumers have NEVER fired live (no `meeting-fanout`/`meeting-crm-sync`
  worker logs in prod). After a clean restart, the next REAL fireflies meeting produces the
  receipt (bus task + interaction + deal-stage + recap doc) — true-verify it.
- ⏳ merge retirement PR (only after that prod live receipt confirms coverage).
- ⏳ PR #338 (`--bare` lean worker) promote before real spawns run lean.

---

## LOG
- 2026-08-10: Tracker created. Established FR-001–008 all merged to main, FR-009 done (doc),
  FR-010 deferred. Both dupes confirmed still present. Staging scripts present. Kicking off
  Phase 1 adversarial code verification.
- 2026-08-10: Phase 1 complete (8 parallel skeptics). FR-001/002/003/004/005/006 PASS.
  FR-007 PARTIAL (name-only engagements drop deal-stage). FR-008 GAP (two-writer `.md` conflict).
- 2026-08-10: Phase 1b — FR-007 fixed + tested → PR #352. FR-008 documented as a design
  decision (spec FR-008-client-md-writer-conflict) — needs Josh's A/B call + staging.
- NEXT (blocked on Josh): Phase 2 staging validation needs a running staging daemon; Phase 4
  prod daemon restart + prod live receipt are Josh-gated HALT points. Autonomous work is at
  its gate — merged code verified, one fix PR'd, one design decision surfaced.
