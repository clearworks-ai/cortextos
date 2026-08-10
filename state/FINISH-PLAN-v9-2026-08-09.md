# v9 Finish-and-Execute Plan (2026-08-09)

> Built from tonight's live audit (`AUDIT-master-plan-live-status-2026-08-09.md`) + the traced
> mechanism. This is the "what's left and in what order" to actually finish the plan and run it.
> Companion: `REPLAN-original-purpose-2026-08-09.md` (why the 3 jobs are one plan).

## The throughline (one root cause)
The system is **code-complete, not live-operational.** "Done" was scored on a merged PR / green
test, never on a **live receipt** (a real thing flowing through the running system). Every gap
below is a liveness gap, not a build gap. Two structural fixes carry most of the finish:

- **BACKBONE FIX — deterministic event→worker spawn.** Today an event (Fireflies webhook) lands as
  a **natural-language nudge in pa's inbox** ("cd pa and spawn meeting-writeback-worker…"), and the
  pa **LLM must notice and act**. It often doesn't (Friday: 3 meetings delivered, 0 filed; writeback
  ledger last entry Aug 4). Fix: the **daemon spawns the writeback worker deterministically on the
  event**, LLM only in the extract/verify layer. This one fix unblocks P1.7, P3 rail, P3.4, P5-B —
  and is the template for google/slack/omi.
- **LIVENESS DISCIPLINE.** Crons rot silently (P1.1 + P1.6 died Aug 5, unnoticed). Any "automated"
  item needs a real recent-output check, not a config grep.

## Verified status snapshot (live, tonight)
DONE-live: P1.0/1.3/1.4/1.5, P3.0a/0b, **P4.1 ①②④⑤ (deliveries confirmed)**, P4.4 detector,
P5-A kills, P5-C sub-slices, P7 fork-deltas. Fixed tonight: ff-extractor Marcos suppression.

---

## Remaining work — dependency-ordered tracks

### TRACK B — Stop the bleeding (cheap, do first)
| Item | State | Finish action | Live-verify |
|---|---|---|---|
| P1.1 kb-reconcile | REGRESSED, dead since Aug 5 | find why cron stopped after last larry restart; re-arm on larry-codex | new ledger row appears nightly, 3 green days |
| P1.6 claude-mem-export | REGRESSED, dead since Aug 5 | same restart-survival fix | export ledger row within 24h |
| liveness check | none | one script: each "automated" cron's last-fire vs interval → alert on stale | emits one stale/clean row |

### TRACK A — Backbone: make the meeting chain durably FILE (the keystone)
| Item | State | Finish action | Live-verify |
|---|---|---|---|
| meeting writeback | delivers but never files (LLM-spawn miss) | make daemon spawn meeting-writeback-worker deterministically on the fireflies event; drop reliance on pa noticing the inbox nudge | 1 real meeting → file in knowledge/meetings + client history, ledger row, `EVENT crm.meeting.completed` |
| hardcoded pa path | skill hardcodes `/agents/pa/` while `pa-codex` runs | parameterize to the running agent dir | worker runs clean under pa-codex |
| Marcos backfill | months silently dropped (fixed tonight) | replay his past Fireflies meetings once filing is reliable | Marcos client file has dated history |
| P1.7 transcripts store | 0 files (blocked on above) | unblocks once writeback files | `ls .../transcripts` ≥1 per new meeting |

### ~~TRACK C — Multica rail~~ — CUT (Josh decision 2026-08-09)
**Multica is dropped from the path** (reverses v9 D1/D2). It was a pure bus mirror — 558 links,
555 bus-origin, 0 meeting — adding no signal for a whole sync layer + dead cron. See
`memory/project_multica_cut_from_path_2026-08-09.md`. This deletes rail activation entirely, makes
P3.0a/0b (reverse-import, dup-recovery) dead code, and drops the Multica half of P4.3.

**New surface for meeting/comms output — commitments fan out to THREE sinks (Josh 2026-08-09):**
- meeting content → file to KB (knowledge/meetings + clients)
- **extracted commitments / action items → ALL of:**
  1. **Telegram** (surface to Josh — kept)
  2. **BUS human tasks** — `cortextos bus create-task --assignee human` (`[HUMAN]` class exists,
     10 live) with `--needs-approval` for client-visible → approval card (`bus/approval.ts`). NEW sink.
  3. **BRIEFS** — the existing `$BRIEFS_INGEST_URL` POST — **KEPT** (do NOT retire yet).
- CRM deltas → **CRM writeback** (`EVENT crm.meeting.completed` stays; CRM ≠ Multica).

Rationale: keep BRIEFS as a parallel sink so Josh can decide to retire it later on his terms, not
forced. Triple-write must be **idempotent** — one deterministic commitment id shared across sinks so
re-runs don't duplicate (BRIEFS already dedups server-side; bus needs a dedup key; Telegram must not
re-spam). Bus is the task store; the other two are additional surfaces.

**Revised P3.4 (the real rewire):** meeting-commitments-worker + writeback today send commitments
to BRIEFS + raw Telegram only — the bus never sees them. **ADD** the bus-human-task + approval-card
sink alongside the existing two (do not remove BRIEFS/Telegram). Satisfies Josh's requirement:
human tasks creatable on the bus, straight from meeting commitments, without losing BRIEFS.

### TRACK C2 — Multica teardown (small)
Disable `multica-sync-inbound` (larry) + any multica cron; stop the real-time bus→Multica mirror in
`src/bus/multica`. Archive (don't delete) secrets/code in case of reversal. Verify: no multica cron
fires, sync-state stops mutating.

### TRACK D — Retire the poll crons (needs A + event lanes live)
P5-B: the 11 event-replaceable poll crons (comms-check, transcript-scanner, meeting-commitments,
ff-extractor, etc.) still run. Once their event lanes are proven live, **remove/disable each old
poll** (the remove-old-cron rule) and keep only the weekly safety-sweep. Verify: only one version
fires.

### TRACK E — Replicate backbone to the other surfaces (GSUITE FIRST)
Ordering (Josh 2026-08-09): **Google suite first — it feeds the comms-check triage** (the Proactive
EA cluster's inbound trigger). Then Slack, then the rest.
| Order | Lane | State | Finish action |
|---|---|---|---|
| **1st** | **google/gmail + calendar** | shadow-ingress only (observe, never wakes a worker) | flip shadow→active using TRACK-A deterministic spawn; **Gmail push feeds comms-check triage → EA cluster**; retire the 45m comms-check poll |
| 2nd | slack.message | not built | build event lane + worker (D5b: full workspace) |
| 3rd | omi.memory | handler in legacy clearpath | repoint onto the bridge |
| 3rd | pr.opened / ci.failed | not built | GitHub event lane |

### TRACK F — P2 jobs: prove the loop, don't boil the ocean
0 of 25 jobs wired to a live trigger; the spot-run wrote synthetic fixtures. Finish action: pick
**3 real jobs** (Meeting Follow-Ups, Pre-Call Briefing, Status Updates), wire each to a real trigger
with **real-path output + a structured Multica/bus row**, prove on one real client. Then scale.

### TRACK G — P1.2 deliverables fold-in
Only 20 of 1,680 agent deliverables mirrored, no manifest. Finish: run the P1.0 content-type router
across all agents + emit the source→target manifest; add to ingest roots. (Parallelizable with F.)

### TRACK H — P6 weekly-review (last)
Upgrade weekly-review to read Multica + approval-queue + MOVEMENT report; needs real rail data
(A+C+F) to exist first. Verify: 4 consecutive real reports at the content-type path.

---

## Execution order (revised — Multica cut)
**B (now, cheap) → A (backbone) → C2 (multica teardown) → D (retire polls) → E (other providers) → F + G (parallel) → H.**

## Quarantine (NOT part of finishing v9 — separate goals)
durable goal-runner (branch `larry/goal-durable-runner` = lineage B, do not merge; lineage C dead
code delete), autonomous-fanout-ledger, obf-ledger-specs-supersession. See REPLAN doc.

## Open human-gates (only true blockers on Josh)
1. ~~multica round-trip~~ — VOID (Multica cut).
2. P7 #172 merge (re-baseline daemon onto upstream) — and a valid clearworks-ai gh token (audit hit 401).

With Multica cut, there are effectively **no pending human build-gates** except #172 — the finish
is now almost entirely deterministic-spawn + liveness work Claude can execute.
