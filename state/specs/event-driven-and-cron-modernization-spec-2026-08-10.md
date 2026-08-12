# Spec — Event-Driven Fleet + Cron Modernization (grounded 2026-08-10)

> Scope: the three intertwined subsystems that finish v9's event-driven architecture, all part of the
> P1–P6 / WAVE master plan (`state/FINISH-PLAN-v9-2026-08-09.md`, `state/REPLAN-original-purpose-2026-08-09.md`).
> Grounded by 3 read-only subagents (file:line ledger below). NOT yet through the /specify adversarial
> rounds or clarification gate — that's the next step. NO code claimed built here.
>
> **The unifying idea:** every recurring job is either an EVENT (fires on a real trigger) or a
> DETERMINISTIC cron (script core + thin-LLM verify). LLM-driven polling is the anti-pattern being removed.

## SUBSYSTEM 1 — Meeting-intelligence chain (full downstream, meeting-type-aware)

**Today's reality (Cindy Wu/Alloi 01KZPX0 + CalAsia 01KZKXSYY):** only spawn + writeback + client-resolution
fire. The action/CRM downstream does NOT. Grounded gaps:

- **G-M1 — event never emitted.** `orgs/clearworksai/skills/meeting-writeback-worker/SKILL.md:529-534`
  emits `EVENT crm.meeting.completed` conditionally on writeback success + FF_MEETING_ID — but it did NOT
  fire today for either meeting. This single miss blocks every downstream event consumer. **FR-M1: the
  writeback worker MUST reliably emit `crm.meeting.completed` (with meeting_id + attendees + client + type)
  on every successful writeback.**
- **G-M2 — abbey blank-followup ROOT CAUSE.** `orgs/clearworksai/agents/crm/crm/fireflies-ingest.py:590`
  `primary_contact = contacts[0]` (first alphabetical external attendee) + `:525-548` assigns ALL action
  items to that one contact — ignoring each item's real `owner`. → 12 spurious empty followups for abbey (a
  mere attendee) while John's real commitments are orphaned (`followups.jsonl:186,202-211`). **FR-M2:
  followups MUST be created per REAL commitment, matched to the owner attendee (owner→attendee resolution),
  never blanket to contacts[0]; deduped by commitment id; skip attendees with no commitment.**
- **G-M3 — commitments route off-bus.** `meeting-commitments-worker/SKILL.md:65-70` POSTs commitments to
  the external `$BRIEFS_INGEST_URL`, NOT cortextos bus. So no bus human-tasks / approval cards. **FR-M3:
  each real commitment MUST fan to the A6 triple-sink — `bus create-task --assignee human` (+ `create-approval`
  if client-facing) + BRIEFS + Telegram — idempotent by one commitment id.**
- **G-M4 — followup-coordinator not wired.** Skill `orgs/clearworksai/skills/followup-coordinator/` exists;
  crm has no event handler that invokes it on `crm.meeting.completed` (AGENTS.md says it should; dispatcher
  absent). **FR-M4: crm.meeting.completed MUST invoke followup-coordinator (owner-aware OUR/THEIR split +
  recap + tracker).**
- **G-M5 — deal-debrief not wired.** Ran today only ad-hoc via auditmaster-codex
  (`outputs/deal-debrief-analyst/2026-08-10-calasia-construction.md`), not event-triggered. **FR-M5: SALES
  meetings MUST trigger deal-debrief on the event.**
- **G-M6 — deal-stage extracted then DROPPED.** ff-extractor extracts `deal_state`
  (`ff-extractor.py:876-894`) but `fireflies-ingest.py` never calls `upsert-engagement.py` to persist it.
  **FR-M6: SALES meetings MUST persist contact/interaction upsert + deal-stage to crm/{contacts,interactions,pipeline}.**
- **G-M7 — meeting-type classification DOES NOT EXIST (the keystone).** No `meeting_type` output anywhere.
  Needed to gate: sales → CRM+deal-debrief; delivery/internal → skip CRM deal. Cindy correctly got no deal
  today only by accident (0 commitments). **FR-M7: ff-extractor MUST output meeting_type
  (sales|delivery|internal|other); the chain routes downstream by it.**
- **WORKING (keep):** spawn `webhook-bridge.ts:331-391`; client-domain resolution
  `meeting-writeback-worker/SKILL.md:268-319` (cindy@alloi.us→alloi.md, abbey@calasiaconstruction.com→calasia.md
  — correct, appends History + Open Items, NO per-person files). Lean-worker fix = PR #338 (unpromoted).

## SUBSYSTEM 2 — Event lanes (Track E: replicate the spawn backbone)

| Surface | State | Code | To activate | Retires |
|---|---|---|---|---|
| Fireflies | ACTIVE | `webhook-bridge.ts:331-391` | — | ff polls |
| Gmail (mail.human) | SHADOW-only | `provider-shadow-ingress.ts:103-113` (`ShadowRouter('shadow')` :92) | flip router→active + spawn comms-check-worker | pa comms-check 15m |
| Calendar | SHADOW-only | `provider-shadow-ingress.ts:126-134` | same | frank2 pre-meeting-brief-page */15 |
| Slack | ABSENT | — | build lane (reuse template) | — |
| omi | ABSENT | — | build lane | — |
| pr/ci | ABSENT | — | build lane | — |

- **FR-E1:** extract the fireflies spawn into a generic `planWorkerSpawn(template, eventId, env)` +
  `trySpawnWorkerForEvent(integration, planFn)` so every lane reuses it.
- **FR-E2:** add a shadow→active flag (`provider-config.json`, per-lane) so a lane is flipped deliberately
  with a receipt (plan's "ledger G-12"); confirm no double-fire with the poll before retiring the poll.
- **FR-E3:** activate Gmail (feeds comms-check triage → EA cluster) FIRST per Josh's ordering, then
  Calendar, then Slack → omi → pr/ci.

## SUBSYSTEM 3 — Cron modernization (deterministic core + thin-LLM verify)

Authoritative disposition doc: `state/CRON-ACCOUNTABILITY-2026-08-04.md` (78 crons; **17 DETERMIN, 4 EVENT,
4 RETIRE, rest KEEP**, every cell source-verified). Refreshed live 2026-08-10 (this is the second revision).
Principle: `memory/feedback_deterministic_cron_core_llm_verify_layer.md` + `feedback_521_deterministic_means_flow_not_remove_llm.md`
— deterministic ≠ remove LLM; it means deterministic bulk FLOW + thin LLM VERIFY on candidates only.

- **Cron engine:** `src/daemon/cron-scheduler.ts` (30s tick, cron-expr + `4h`/`15m` shorthands, retry-backoff,
  logs to `logs/<agent>/execution.log`). **Live store = `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json`**
  (NOT config.json — config migrates ONCE via `.crons-migrated`; later config edits silently ignored:
  `src/daemon/cron-migration.ts:317`; edit via `cortextos bus add/update/remove-cron`).
- **FR-C1 (RETIRE-via-event):** the event-replaceable polls — pa comms-check, ff-extractor, meeting-recap-draft;
  frank2 meeting-commitments, transcript-scanner, pre-meeting-brief-page; crm fireflies-ingest (→ backstop only)
  — disable EACH only after its event lane fires live; keep ONE wide safety-sweep per source; assert one version fires.
- **FR-C2 (MODERNIZE to deterministic+verify):** the LLM-driven KEEP crons — frank2 {daily-trending-repos,
  weekly-review/prep/synthesis/cleanup, client-health, pipeline-review, nightly-fleet-analysis, session-archaeology};
  pa evening-wrap; crm {daily-checkin, weekly-brief, deal-enrichment}; scout {creator-expansion, morning-digest};
  muse morning-digest; larry {repo-health, upstream-sync} — rewrite each as deterministic bulk core (script filters
  candidates) + thin LLM verify only on candidates.
- **FR-C3 (KEEP):** heartbeats, already-deterministic scripts, approval-gated hygiene, low-freq backstops.
- **FR-C4 (bug):** repair the daemon step-value cron parser (`cron-scheduler.ts:~85-96`) — crm comms-ingest +
  calendar-ingest crons died at daemon level, currently piggybacked on crm heartbeat as a workaround.

## GROUNDING LEDGER (file:line, from the 3 read-only passes 2026-08-10)
See each FR's G-note above. Key citations: webhook-bridge.ts:331-391 (spawn), :730-740 (HMAC), :317-321
(meeting_id); provider-shadow-ingress.ts:92/103-113/126-134 (shadow lanes); meeting-writeback-worker/SKILL.md:268-319
(client resolution), :529-534 (event emit gap); fireflies-ingest.py:590 + :525-548 (abbey bug), :594-608
(interaction), no upsert-engagement (deal-stage drop); ff-extractor.py:876-894 (deal_state extract, no type);
cron-scheduler.ts (engine), cron-migration.ts:317 (config drift); CRON-ACCOUNTABILITY-2026-08-04.md (dispositions).

## MASTER-PLAN FRAMING (this is not new scope — it's the unfinished v9)
- Meeting chain = TRACK A (backbone) + A6 (triple-sink) — this spec completes the full downstream.
- Event lanes = TRACK E (gsuite-first).
- Cron retire = TRACK D; cron MODERNIZE = the ungapped principle now made concrete here.
- Sits under the P1–P6 / WAVE structure in FINISH-PLAN-v9.

## NEXT (per /specify)
Clarification gate → adversarial rounds (Codex grounds every G-note file:line; Fable attacks logic/scope) →
validator → handoff to /goalify or plan mode. Meeting-type classification (FR-M7) is the keystone dependency
for M4/M5/M6.
