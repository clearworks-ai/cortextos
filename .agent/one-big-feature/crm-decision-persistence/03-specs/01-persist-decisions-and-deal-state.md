# Spec 01 — Persist meeting decisions + deal_state

## Objective

Stop discarding the `decisions` / `deal_state` that `ff-extractor.py`'s
`run_full()` already computes. Persist decisions onto the meeting's interaction
row, and conditionally advance the engagement stage — reusing the existing
idempotent writers. Prove it by backfilling meeting
`01KZ71M4876B6NKT8V3TFCQBRW`.

## Scope — files

| File | Action |
|------|--------|
| `orgs/clearworksai/agents/crm/crm/add-interaction.py` | EDIT (additive) |
| `orgs/clearworksai/agents/crm/crm/ingest-meeting-decisions.py` | NEW connector |
| `orgs/clearworksai/agents/crm/crm/test_add_interaction.py` | NEW/EXTEND tests |
| `orgs/clearworksai/agents/crm/crm/test_ingest_meeting_decisions.py` | NEW tests |
| `orgs/clearworksai/agents/pa/scripts/ff-extractor.py` | **DO NOT EDIT** |
| `orgs/clearworksai/agents/crm/crm/upsert-engagement.py` | **DO NOT EDIT** (reuse) |

## Task 1 — Extend `add-interaction.py` (additive, back-compatible)

Current relevant lines: record built `:24-33` (`commitments`/`followups_created`
hardcoded `[]`); duplicate guard `:36-48` (dedup on `source_ref + contact_id`,
skip-on-match); append `:49-51`.

Changes:
1. Add arg `--decision` (repeatable via `action="append"`, dest `decisions`,
   default `[]`). Use repeatable flag NOT a JSON string arg — avoids shell
   quoting bugs.
2. Add `"decisions": args.decisions or []` to the record dict (`:24-33`).
   Existing callers that never pass `--decision` get `decisions: []` — no
   behavior change for them.
3. Change the duplicate-match branch (`:46-48`). On `source_ref + contact_id`
   match to an existing row:
   - If `existing.get("decisions", []) == (args.decisions or [])` →
     `print(json.dumps({"skipped":"duplicate", ...}))`, return 0. **True no-op.**
   - Else set `existing["decisions"] = args.decisions or []`, rewrite the ENTIRE
     `interactions.jsonl` with the mutated row in place, atomically (write temp
     file in same dir + `os.replace`), print `{"updated":"decisions",
     "source_ref":..., "contact_id":...}`, return 0.
4. When no match: append as today, with `decisions` populated.

Constraints:
- Atomic rewrite only (temp + `os.replace`) — never truncate-in-place; a crash
  must not corrupt `interactions.jsonl`.
- Preserve all other fields on the matched row untouched (only `decisions`
  changes on update).
- Do NOT change `--type` choices, `commitments`, or `followups_created` behavior.

## Task 2 — NEW connector `ingest-meeting-decisions.py`

Purpose: consume `ff-extractor --mode full` output and drive the two writers.

Behavior:
1. Input: `--meeting-id <id>` (runs `ff-extractor.py --mode full --meeting-id
   <id>` via subprocess and parses stdout JSON) OR `--stdin` (reads a
   pre-captured `--mode full` payload). Support both; `--stdin` is what tests use.
2. For each `meeting` in payload with non-empty `decisions`:
   - Resolve `contact_id`: reuse the SAME contact-resolution the calendar backfill
     relies on (match meeting attendees/organizer against `contacts.json`; do NOT
     invent new matching). If no contact resolves → warn to stderr, skip this
     meeting's writes (no guessed contact_id).
   - Call `add-interaction.py --contact-id <id> --type meeting --source-ref
     fireflies:<meeting_id> --sentiment <derived-or-unknown>` plus one
     `--decision "<d>"` per decision. (Via subprocess to the sibling script — do
     not duplicate its logic.)
3. For non-empty `deal_state`, apply the deterministic keyword→stage map (Task 3).
   - If it maps AND an engagement is found for the resolved contact (match
     `primary_contact_id` or `contact_ids` in `pipeline.json`, read
     `clearpath_id`): call `upsert-engagement.py --clearpath-id <n> --stage
     <mapped> --source-ref fireflies:<meeting_id> --note "<deal_state text>"`.
   - Else: do NOT call `upsert-engagement.py`. deal_state is preserved as text on
     the interaction row — extend the `add-interaction.py` call with the raw
     deal_state (implementer: either add a parallel `--deal-state` text arg to
     `add-interaction.py` in Task 1, OR append the deal_state sentence to the
     decisions list prefixed `deal-state:`; prefer a dedicated `--deal-state`
     field for cleanliness — add it in Task 1 the same additive way as
     `--decision`).
4. Emit a JSON summary of actions taken (rows written/updated, stage calls made,
   skips + reasons) to stdout.

## Task 3 — Deterministic deal_state → stage map (in the connector)

A small hardcoded dict, NO LLM/fuzzy mapping. Suggested seed (implementer may
refine, keep it explicit and case-insensitive substring match):

| deal_state contains | → stage |
|---------------------|---------|
| "signed", "verbal yes", "closed won", "won" | `won` |
| "proposal sent", "sent the proposal", "SOW sent" | `proposal_sent` |
| "negotiat" | `negotiation` |
| "qualified" | `qualified` |
| "went cold", "stalled", "dormant" | `dormant` |
| "closed lost", "lost", "passed" | `closed_lost` |

Any deal_state not matching ANY key → no stage change (text-preserved only). All
target stages MUST be in `upsert-engagement.py` `KNOWN_STAGES` (`:27-30`) — reject
at review any mapping to a stage not in that set.

## Task 4 — MSIA backfill (real-data proof)

Run:
```
python3 crm/add-interaction.py \
  --contact-id mark-lurie --type meeting \
  --source-ref fireflies:01KZ71M4876B6NKT8V3TFCQBRW \
  --sentiment positive \
  --decision "Agreed to proceed with automation for Wendy's spreadsheet" \
  --decision "Agreed to explore automation with Julie's travel process"
```
Expected result: the EXISTING `mark-lurie` / `fireflies:01KZ71M...` meeting row
(currently `commitments: []`, no decisions) is UPDATED in place to carry the two
decisions — NOT a second duplicate row. Verify:
```
grep 01KZ71M4876B6NKT8V3TFCQBRW crm/interactions.jsonl | wc -l   # must stay 1
```
Then re-run the identical command → must report `{"skipped":"duplicate"}` and
leave the row unchanged (idempotency proof).

**deal_state: NO stage call.** "MSIA Busywork Audit" (`clearpath_id 19`) is
already `stage: won`; "audit → implementation" is delivery-phase language with no
mapping in Task 3. Do not call `upsert-engagement.py`. Do not invent an
"implementation" stage. If a `--deal-state` text field was added, set it to the
delivery-phase sentence for the record; otherwise leave deal_state empty.

## Task 5 — Tests

`test_add_interaction.py` (new or extend):
- `test_decisions_field_populated_on_new_row` — `--decision` writes `decisions:
  [...]`; no `--decision` → `decisions: []` (back-compat).
- `test_decisions_update_not_duplicate` — same `source_ref + contact_id` twice
  with same decisions → exactly ONE row + `skipped:duplicate`; same key with new
  decisions → row UPDATED (still one row), reports `updated:decisions`.
- `test_atomic_write_preserves_other_fields` — updating decisions leaves
  `type/summary/sentiment/source_ref` untouched.

`test_ingest_meeting_decisions.py` (new):
- `test_connector_writes_decisions_no_stage_when_dealstate_empty` — stub payload,
  asserts add-interaction called, upsert-engagement NOT called.
- `test_connector_maps_dealstate_to_stage` — deal_state "verbal yes, signed" →
  `upsert-engagement --stage won` call produced.
- `test_connector_freetext_dealstate_no_stage` — unmapped deal_state → no stage
  call, deal_state preserved as text.
- `test_connector_skips_on_unresolved_contact` — attendee not in contacts.json →
  no writes, warning emitted.

All tests use temp fixture `interactions.jsonl` / `pipeline.json` — never live
files.

## Acceptance Criteria

- [ ] `add-interaction.py --decision` populates `decisions`; omitting it keeps
      `decisions: []` (existing callers unaffected).
- [ ] Re-running the same meeting is a no-op; changing decisions updates the row
      in place (never a duplicate).
- [ ] Writes are atomic (temp + `os.replace`).
- [ ] Connector never flips a pipeline stage from unmapped free-text deal_state;
      only deterministic keyword matches call `upsert-engagement.py`.
- [ ] MSIA meeting `01KZ71M4876B6NKT8V3TFCQBRW` interaction row carries the two
      decisions after backfill, still ONE row, re-run is a no-op, NO stage change.
- [ ] `ff-extractor.py` and `upsert-engagement.py` are unchanged.
- [ ] All existing crm `test_*.py` pass; the 7 new tests pass.

## Explicit Non-Goals

- No `ACTION_ITEMS_PROMPT` / `DECISIONS_PROMPT` / classifier edits.
- No Mark Lurie 3-way merge / approval-queue / deletion changes.
- No new sales-stage values; no auto-flip from LLM prose.
- No edit to `ff-extractor.py run_full()` unless Josh picks the in-`run_full`
  write fork (scope fork — flag, don't guess).
