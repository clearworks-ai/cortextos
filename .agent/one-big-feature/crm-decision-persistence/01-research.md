# Research — crm-decision-persistence

## Problem statement (Josh, 2026-08-04)

A real MSIA meeting (`CW/MSIA Catchup`, meeting_id `01KZ71M4876B6NKT8V3TFCQBRW`,
2026-08-04) produced concrete **decisions** — "Agreed to proceed with automation
for Wendy's spreadsheet", "Agreed to explore automation with Julie's travel
process" — and an implied **deal trajectory** change. None of it landed anywhere
durable: no engagement update in `pipeline.json`, no decision row in
`interactions.jsonl`, no task/followup. The decisions evaporated.

## First hypothesis (WRONG — already corrected)

pa's initial theory was "the commitment classifier doesn't recognize passive
phrasing." That is wrong and out of scope. `ACTION_ITEMS_PROMPT` deliberately
requires named owner + concrete due date + explicit "I will" language, and
`DECISIONS_PROMPT` is a *separate* category whose own text says a decision "is
NOT a task, NOT a follow-up." Loosening the action-item bar to catch decisions
would spam weak commitments into `followups.jsonl`. The classifier is correct.

## Verified root cause (direct source read, this session)

The decisions ARE extracted correctly on every run — they are then **discarded**
because `run_full()` has no write path.

- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:121` — `DECISIONS_PROMPT`,
  a deliberately separate category from `ACTION_ITEMS_PROMPT:93`. Not to be
  touched.
- `ff-extractor.py:800` — `extract_decisions_and_deal_state()` calls
  `DECISIONS_PROMPT` and returns `(decisions, deal_state)`. Confirmed working.
  Its docstring (`:807`) names the gap: "the two extractions the writeback
  hardcoded as none."
- `ff-extractor.py:1532` — `build_recap_meeting()` calls
  `extract_decisions_and_deal_state()` and, at `:1588-1589`, includes
  `"decisions": decisions` and `"deal_state": deal_state` in the returned dict.
  The comment at `:1530-1531` confirms these were deliberately carried forward
  into the payload as a partial fix.
- `ff-extractor.py:1714-1720` — `run_full()` (the `--mode full` webhook
  fast-path AND periodic poll) does ONLY `print(json.dumps({..., "meetings":
  meetings, ...}))`. **There is no write step.** decisions/deal_state are
  computed correctly, printed to stdout, and thrown away.

The gap is a half-finished wiring: the *payload* got the fields (`:1588-1589`),
but the *persistence* was never built. Everything downstream of stdout is
missing.

## What the CRM side already provides (reuse targets)

Persistence machinery already exists on the crm agent — this feature wires ff
output INTO it, it does not invent new stores.

### interactions.jsonl writer — `add-interaction.py`
- `orgs/clearworksai/agents/crm/crm/add-interaction.py` is the sole interaction
  writer. Idempotent: dedups on `source_ref + contact_id`
  (`add-interaction.py:46`) and prints `{"skipped":"duplicate",...}` on re-run.
- Its record schema (`:24-33`) hardcodes `"commitments": []` and
  `"followups_created": []` and has **no** `decisions`/`deal_state` field and
  **no** `--engagement-id`. `--type` choices (`:18`) do not include a decision
  type. It is invoked by `calendar-backfill.py:186`, `comms-backfill.py:63`,
  `log-telegram.py:102`.
- Verified: **zero** rows in `interactions.jsonl` (369 rows) carry a `decisions`
  or `deal_state` key today.

### pipeline.json stage writer — `upsert-engagement.py`
- `orgs/clearworksai/agents/crm/crm/upsert-engagement.py` is the **canonical**
  pipeline mutation writer (its docstring: "Use this instead of editing
  pipeline.json directly so stage drift is auditable").
- Keys on `--clearpath-id` (`:39`), matches the engagement (`:55`), and on a
  stage change appends a `stage_history` entry and updates `stage` +
  `stage_changed_at` (`:62-73`). **No-op if the new stage equals current**
  (`:62` guard + `:94` `noop` branch) — inherently idempotent.
- `--stage` is constrained to `KNOWN_STAGES` (`:27-30`): `lead, qualified,
  proposal_sent, negotiation, won, active_client, dormant, closed_won,
  closed_lost, lost`. deal_state is free text and must be MAPPED to one of these,
  not written raw.

### MSIA engagement (the affected record) — verified
- `pipeline.json` engagement `name: "MSIA Busywork Audit"`, `clearpath_id: 19`,
  `primary_contact_id: "mark-lurie"`, `service_type: "busy_work_audit"`.
- **CITATION CORRECTION:** its current `stage` is **`won`**, `stage_changed_at`
  `2026-06-24T18:45:20`. It is NOT in an "audit" or "implementation" stage — the
  CRM stage vocabulary has no such values (see `KNOWN_STAGES` above; `pipeline.json`
  `stage_mapping` only knows lead/qualified/committed/won/lost). The task brief's
  "advanced from audit to implementation" describes *delivery-phase* language
  from the transcript, which does not map onto the CRM sales-stage enum.

## Consequence for design

- The affected meeting **already has an interaction row** written to
  `interactions.jsonl` (`ts 2026-08-05T02:03:08`, `source_ref
  "fireflies:01KZ71M4876B6NKT8V3TFCQBRW"`, `contact_id "mark-lurie"`) — with
  `commitments: []` and no decisions. So a meeting row exists; what's missing is
  the *decisions attached to it*. This argues for FOLDING decisions into the
  existing meeting interaction (same `source_ref`), not minting a separate
  "decision" interaction type that would double-log the meeting.
- `fireflies-ingest.py` only lists new transcript IDs (`--mark` dedup); it does
  NOT write interactions. The interaction rows are written by the calendar/comms
  backfills and by agent judgment — the ff `--mode full` extraction side and the
  crm interaction-writer side are currently **unconnected**. This feature builds
  the connector.

## Open design questions (resolved in 02-master-plan.md)

1. Fold decisions into the existing meeting interaction row, or new type? →
   Fold, via an additive `--decisions` arg on `add-interaction.py` that upgrades
   an existing same-`source_ref` row instead of skipping it.
2. deal_state → which `upsert-engagement.py --stage`? → deal_state is advisory
   free text; do NOT auto-flip a sales stage from an LLM sentence. Persist
   deal_state as a decision-adjacent note; only call `upsert-engagement.py` when
   a deterministic stage-word is present. For MSIA specifically, no CRM sales
   stage change is warranted (already `won`) — persist the delivery decisions,
   leave stage untouched.
3. Idempotency for the new write → reuse the `source_ref + contact_id` dedup
   already in `add-interaction.py:46`, extended so a re-run UPDATES the decisions
   on the matched row rather than skipping, and is a no-op if decisions are
   unchanged.
