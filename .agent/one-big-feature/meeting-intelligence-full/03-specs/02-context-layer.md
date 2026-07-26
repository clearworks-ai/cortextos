# Spec 02 — §4.2 Context layer: the thing that has never existed

**Repo:** `/Users/joshweiss/code/cortextos`
**Status this run:** materialized, NOT dispatched. Per Google Doc §5 "smallest first build," this is the Doc's own recommended FIRST piece to build (ahead of the webhook and the trust ladder) — flagged for priority in a follow-up dispatch run.

**Source (verbatim, Google Doc §4.2):** "This is the fix for Root cause #1 and the heart of the whole design... What it holds: Clearworks identity/ICP/goal (from company.md/offer.md/STATE.md) + per-client deal stage, open commitments, who's who (from crm/meetings/ + contacts.json, which are the real populated data)... Where it lives: populate knowledge/clients/\<client\>.md (currently only _template.md). This is the exact substrate all three tracking crons already try to read — they just have nothing to read... How it's loaded (OpenViking-style): L0 (~100 tok, always) / L1 (~2k tok, if active-deal match) / L2 (on demand: full client history file)... How it stays current: a once-daily synthesis pass updates each client file's Open Items table... Injection: ff-extractor.py:86 ACTION_ITEMS_PROMPT gets a new {client_context} slot. ~10-line prompt change + a context-loader function."

Also Google Doc §5 concrete build steps (verbatim, lines 505-521):
1. "Populate knowledge/clients/\<client\>.md for the live deals (Alloi, MSIA, OCG, active pipeline). Source from the 50 real files already in crm/meetings/ + crm/contacts.json — data exists, wrong dir. Use the existing _template.md structure with the Open Items table the overdue-chase already expects. (Data-migration task, route to crm/larry.)"
2. "Add a context-loader to ff-extractor.py: given a transcript's attendees/organizer, match to a client file, return an L0 block (~100 tokens). ~30 lines."
3. "Inject it: add {client_context} to ACTION_ITEMS_PROMPT (:86). ~5 lines. Instruct in-prompt: 'only surface items material to an active Clearworks engagement or a dated commitment; drop the rest.'"

## Verified live

- `orgs/clearworksai/knowledge/clients/` = `_template.md` only (zero real client files).
- `orgs/clearworksai/agents/crm/crm/meetings/` = 55 real meeting files (verified count via find, 2026-07-26).
- `orgs/clearworksai/agents/crm/crm/contacts.json` exists.
- `frank2/scripts/ff-extractor.py:86` — `ACTION_ITEMS_PROMPT` constant, confirmed line number.

## Build

1. **Data migration** (route to crm/larry per Doc's own routing note): populate `knowledge/clients/<client>.md` for live deals (Alloi, MSIA, OCG, active pipeline) sourced from the 55 real `crm/meetings/*.md` files + `crm/contacts.json`. Use `_template.md`'s exact structure (Contacts / Current state / What we're delivering / Financials / History / Open Items table).
2. **Context-loader function** in `ff-extractor.py`: given a transcript's attendees/organizer, match to a `knowledge/clients/<client>.md` file, return an L0 block (~100 tokens: "Clearworks = AI-ops/integration-failure consulting. This meeting's attendees map to client=X, deal stage=Y."). ~30 lines per Doc estimate.
3. **Prompt injection**: add a `{client_context}` slot to `ACTION_ITEMS_PROMPT` (line 86), ~5 lines, with the in-prompt instruction verbatim from the Doc: "only surface items material to an active Clearworks engagement or a dated commitment; drop the rest."
4. **Daily synthesis pass** (how it stays current, per 4.2): a once-daily job that updates each client file's Open Items table from new activity — this is a NEW small cron/worker, not yet named in the Doc beyond "a once-daily synthesis pass"; needs its own scheduling decision at build time (candidate: extend `weekly-review`/`daily-ops-dashboard` cadence or add a dedicated daily cron).

## Note on CRM source-of-truth (from §8, spec 07)

§8 clarifies this context layer is a DERIVED READ-CACHE from CRM data, not a new parallel store — `knowledge/clients/<client>.md` is populated FROM `crm/meetings/` + `crm/contacts.json`, refreshed daily, CRM stays source of truth. This constrains how the daily synthesis pass (build step 4 above) should be designed: it re-derives from CRM, it does not accept direct edits that could drift from CRM. Coordinate with spec 07 before finalizing the synthesis-pass design.

## Files to touch (once dispatched)

| File | Change |
|---|---|
| `orgs/clearworksai/knowledge/clients/*.md` | NEW — data-migration output, one file per live client |
| `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` | context-loader function + `{client_context}` injection into `ACTION_ITEMS_PROMPT` (line 86) |
| new daily-synthesis cron/worker (name TBD at build time) | NEW |

## Test plan

- Data migration: spot-check 3 client files against source `crm/meetings/` content for accuracy, no invented facts.
- Context-loader: unit test attendee→client matching (exact match, fuzzy/no-match fallback to no context block).
- Prompt injection: confirm `ACTION_ITEMS_PROMPT.format(...)` still renders correctly with the new slot when `client_context` is empty (graceful no-context fallback for unmatched meetings).
- Live proof (per Doc §5): "prove the next commitments run surfaces <=3 relevant items instead of a flood."
