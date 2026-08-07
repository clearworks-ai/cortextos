# Master Plan — crm-decision-persistence

## Feature Summary

Meeting **decisions** and **deal_state** are extracted correctly by
`ff-extractor.py` on every `--mode full` run, then thrown away because
`run_full()` only prints JSON and has no write path. This feature builds the
missing persistence connector so decisions land durably in the CRM:

1. Extend `add-interaction.py` (the sole, idempotent interaction writer) with an
   additive `--decisions` argument that attaches decisions to the meeting
   interaction row, and — critically — makes a re-run against an existing
   same-`source_ref` row UPGRADE it with decisions instead of silently skipping.
2. Add a small connector that reads `ff-extractor --mode full` output and calls
   `add-interaction.py` (for decisions) and, conditionally,
   `upsert-engagement.py` (for a genuine sales-stage change). This is the wiring
   `run_full()` never got.
3. Backfill the specific affected meeting via that same connector — proving the
   mechanism on real data, not a hand-edit.

**No classifier changes. No merge-queue / approval-queue / deletion changes.**

## Root Cause (verified file:line, this session)

- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:1714-1720` — `run_full()`
  does ONLY `print(json.dumps({"mode":"full","meetings":meetings,...}))`. No
  persistence. This is THE bug.
- `ff-extractor.py:1588-1589` — `build_recap_meeting()` DOES return
  `"decisions"` and `"deal_state"` in the payload; the half-fix stopped here.
- `ff-extractor.py:800-818` — `extract_decisions_and_deal_state()` works; its
  docstring names the gap ("hardcoded as none").
- `ff-extractor.py:121` `DECISIONS_PROMPT` / `:93` `ACTION_ITEMS_PROMPT` — two
  deliberately separate categories. Out of scope, do not touch either.

## Chosen Persistence Design (and why — reusing, not reinventing)

### Decisions → fold into the meeting interaction row via `add-interaction.py`

**Reuse `add-interaction.py`.** Verified facts driving this:
- The affected meeting already has ONE meeting interaction row
  (`source_ref "fireflies:01KZ71M4876B6NKT8V3TFCQBRW"`, `contact_id
  "mark-lurie"`) with `commitments: []` and no decisions. Minting a separate
  "decision"-type row would double-log the same meeting and fragment its record.
- `add-interaction.py` already dedups on `source_ref + contact_id`
  (`add-interaction.py:46`). We extend that path: instead of skip-on-duplicate,
  a matched row is UPDATED in place to carry the decisions (write the whole file
  back). This keeps one row per meeting and makes the operation idempotent.

**Additive change to `add-interaction.py` (additive only, no behavior change when
`--decisions` is omitted):**
- New arg `--decisions` (repeatable, or a single JSON-array string — implementer
  picks the simpler shape that survives shell quoting; prefer repeatable
  `--decision "..."` to avoid JSON-in-argv quoting bugs).
- Record schema gains a `"decisions": [...]` field (default `[]`, so existing
  callers and existing rows are unaffected).
- Duplicate-match branch (`:46`) changes from unconditional skip to:
  - if the matched row's `decisions` already equals the incoming decisions →
    print `{"skipped":"duplicate"}` and exit 0 (true no-op, idempotent).
  - else set the matched row's `decisions` to the incoming list, rewrite
    `interactions.jsonl` atomically, print `{"updated":"decisions", ...}`.
- No `source_ref` match → append a new row exactly as today, now with the
  `decisions` field populated.

**Rejected alternative:** a brand-new `decisions.jsonl` store or a new
`--type decision`. Rejected because a separate store fragments the meeting record
and needs its own reader/dedup; `interactions.jsonl` is already the queried
meeting substrate (`query.py`, `interactions-to-notes.py`, timeline feeds).

### deal_state → `upsert-engagement.py`, but GATED (do not auto-flip stages from an LLM sentence)

**Reuse `upsert-engagement.py`** — it is the canonical, auditable, idempotent
stage writer (`--clearpath-id`, `stage_history` append, no-op on unchanged
stage). **Do NOT build a fresh stage writer.**

But `deal_state` from `DECISIONS_PROMPT` is a free-text sentence ("Moved from
proposal to verbal yes"). Auto-mapping arbitrary LLM prose onto the strict
`KNOWN_STAGES` enum and flipping a real pipeline stage is dangerous (a wrong flip
corrupts the sales pipeline). So:
- The connector maps deal_state to a stage ONLY via a small **explicit,
  deterministic keyword map** (e.g. "verbal yes"/"signed" → `won`, "proposal
  sent" → `proposal_sent`, "went cold"/"stalled" → `dormant`). No fuzzy/LLM
  mapping.
- If deal_state does not deterministically map to a known stage, it is NOT
  written as a stage change. It is preserved as text on the interaction row (a
  `deal_state` field alongside `decisions`) so the signal is not lost — but the
  pipeline is not mutated on a guess.
- Requires the connector to resolve the engagement `clearpath_id` from the
  meeting's `contact_id` (match `primary_contact_id` or `contact_ids` in
  `pipeline.json`). If no engagement matches the contact → skip the stage call,
  keep the interaction-row `deal_state` text, emit a warning line.

This keeps the design **additive and safe**: worst case, deal_state is preserved
as text and a human decides the stage — never a silent wrong flip.

### The connector

A thin script (crm side, e.g. `crm/ingest-meeting-decisions.py`) that:
1. Takes ff `--mode full` JSON on stdin or `--meeting-id` + runs it.
2. For each meeting with a non-empty `decisions`: resolve `contact_id` from
   attendees/organizer (reuse the same contact-resolution the calendar backfill
   uses — do NOT reinvent contact matching), call `add-interaction.py --type
   meeting --source-ref fireflies:<id> --contact-id <id> --decision ...`.
3. For non-empty `deal_state`: apply the deterministic keyword→stage map; if it
   maps AND an engagement is found for the contact, call `upsert-engagement.py
   --clearpath-id <n> --stage <mapped> --source-ref fireflies:<id> --note
   "<deal_state text>"`. Else record deal_state as text only.

Implementer note: prefer wiring this connector as a follow-on the crm agent runs
after `fireflies-ingest.py` surfaces a new transcript, rather than adding a write
side-effect directly inside `ff-extractor.py run_full()`. Rationale: `run_full()`
is pa-owned diagnostic/stdout; keeping writes on the crm side preserves the
existing pa(extract) / crm(persist) separation and keeps `run_full()` a pure
function. If Josh prefers the write inside `run_full()`, that is a one-line
scope fork — flag, don't guess.

## File Ownership

- `orgs/clearworksai/agents/crm/crm/add-interaction.py` — EDIT (additive
  `--decisions`, update-on-duplicate). crm-owned.
- `orgs/clearworksai/agents/crm/crm/ingest-meeting-decisions.py` — NEW connector.
  crm-owned.
- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py` — **NO EDIT** unless Josh
  picks the in-`run_full` write fork. `run_full()`'s payload already carries the
  fields; the connector consumes stdout.
- `orgs/clearworksai/agents/crm/crm/upsert-engagement.py` — **NO EDIT** (reused
  as-is).

## Idempotency / Dedup Approach

- Decisions: `source_ref + contact_id` match in `add-interaction.py:46`, extended
  to update-in-place; re-run with identical decisions = true no-op. This mirrors
  the existing `load_ledger`/`skipped_ledger` "id as first token" dedup
  convention used in `ff-extractor.py:1454-1471` — same spirit (a stable key,
  skip on seen), applied to the interaction store's natural key.
- deal_state stage change: `upsert-engagement.py:62` is already a no-op when the
  stage is unchanged — re-running never double-appends `stage_history`.

## MSIA Backfill Plan (proves the mechanism on real data)

Meeting `01KZ71M4876B6NKT8V3TFCQBRW`, contact `mark-lurie`, engagement "MSIA
Busywork Audit" (`clearpath_id 19`).

Run the connector (or, for backfill, call `add-interaction.py` directly with the
same args the connector would):
```
python3 crm/add-interaction.py \
  --contact-id mark-lurie --type meeting \
  --source-ref fireflies:01KZ71M4876B6NKT8V3TFCQBRW \
  --sentiment positive \
  --decision "Agreed to proceed with automation for Wendy's spreadsheet" \
  --decision "Agreed to explore automation with Julie's travel process"
```
Expected: the EXISTING `mark-lurie` / `fireflies:01KZ71M...` meeting row is
UPDATED with `decisions:[...]` (not a new duplicate row). Re-running is a no-op.

**deal_state for MSIA: no CRM stage change.** The engagement is already `won`;
the transcript's "audit → implementation" is delivery-phase language, not a sales
stage in `KNOWN_STAGES`. Per the gated design, deal_state does not
deterministically map to a stage, so `upsert-engagement.py` is NOT called — the
delivery-phase note is preserved as `deal_state` text on the interaction row.
Do not invent an "implementation" stage.

## Test Strategy

**Existing tests that must still pass (regression):**
- `orgs/clearworksai/agents/crm/crm/test_*.py` (e.g. `test_reconcile_intake.py`,
  `test_sync_board.py`, `test_upsert_contact.py`) — the additive
  `add-interaction.py` change must not break any interaction/pipeline consumer.
- Any `ff-extractor` test suite on the pa side — since `ff-extractor.py` is NOT
  edited, these must pass unchanged (proves we stayed out of the classifier).

**New tests (crm side):**
1. `test_add_interaction_decisions` — calling `add-interaction.py --decision ...`
   on a fresh `source_ref` writes a row with the `decisions` field populated;
   omitting `--decisions` writes `decisions: []` (back-compat).
2. `test_add_interaction_decisions_update_not_duplicate` — calling twice with the
   SAME `source_ref + contact_id` and same decisions leaves exactly ONE row and
   reports a no-op; calling with the same key but new decisions UPDATES the row
   (still one row) — proves idempotency + the fold-not-duplicate behavior.
3. `test_ingest_meeting_decisions_connector` — feed a stub ff `--mode full`
   payload (non-empty decisions, empty deal_state) and assert the connector
   produces exactly the `add-interaction.py` call and NO `upsert-engagement.py`
   call; feed a payload whose deal_state maps deterministically (e.g. "signed")
   and assert an `upsert-engagement.py --stage won` call is produced; feed
   free-text deal_state and assert NO stage call + deal_state preserved as text.

Tests must use a temp/fixture `interactions.jsonl` and `pipeline.json` — never
the live files (staging-first discipline for anything touching pipeline.json).

## Rollout Risk

- **Wrong stage flip** — highest risk. Mitigated by the deterministic-keyword
  gate: an LLM sentence never flips a stage unless it contains an explicit
  mapped word, and unmatched deal_state is preserved as text only.
- **Duplicate meeting rows** — mitigated by update-in-place on `source_ref +
  contact_id`; new test #2 locks it.
- **pipeline.json corruption** — mitigated by reusing `upsert-engagement.py`
  (already the auditable canonical writer) and never hand-editing pipeline.json.
- **Contact-resolution miss** (meeting attendee not matched to a CRM contact) —
  connector skips the write and warns rather than writing under a wrong/guessed
  contact_id. No silent misattribution.
- **Atomic write** — `add-interaction.py`'s update-in-place must rewrite the file
  atomically (temp + rename) so a crash mid-write can't truncate
  `interactions.jsonl`.

## Non-Goals (explicit)

- NO change to `ACTION_ITEMS_PROMPT` / `DECISIONS_PROMPT` / the commitment
  classifier (`ff-extractor.py:93`, `:121`) — the classifier is correct; this is
  a persistence gap, not a classification gap.
- NO change to the Mark Lurie 3-way merge, approval-queue, or any deletion /
  dedup-of-contacts logic.
- NO new deal *sales* stage values; no "audit"/"implementation" stages.
- NO auto-flip of pipeline stage from free-text LLM output.
