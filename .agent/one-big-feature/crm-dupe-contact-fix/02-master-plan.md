# Master Plan — crm-dupe-contact-fix

## Feature Summary

Two CRM backfill scripts create duplicate contact records because they pass an
explicit, freshly-slugified `--id` to `upsert-contact.py` on every run. This
bypasses `upsert-contact.py`'s already-built, already-tested email-match lookup.
Result: the same person is re-minted under a new id each time their display name
or the slug derivation differs (e.g. "Mark Lurie" now has 3 records:
`mark-lurie`, `markmsiaorg`, and a bare `mark`).

The fix: stop passing `--id` from the two backfill scripts and pass
`--match-email` instead, so `upsert-contact.py`'s own `find_contact_by_email()`
resolves the existing contact by email, falling back to `slugify(name)` only when
no email match exists. No change to `upsert-contact.py` — its logic is correct.

## Root Cause (verified against current source, this session)

The correct dedup mechanism already lives in `upsert-contact.py` and is
gated to run ONLY when no explicit id is passed:

- `orgs/clearworksai/agents/crm/crm/upsert-contact.py:103` —
  `find_contact_by_email(contacts, emails)` matches an existing contact by any
  overlapping normalized email.
- `orgs/clearworksai/agents/crm/crm/upsert-contact.py:143` — the `--match-email`
  flag (`action="store_true"`).
- `orgs/clearworksai/agents/crm/crm/upsert-contact.py:158` — the gate:
  `if args.match_email and not args.contact_id:` — the lookup fires ONLY when
  `--match-email` is set AND no `--id` was passed. Passing `--id` at all
  short-circuits the lookup.
- `orgs/clearworksai/agents/crm/crm/upsert-contact.py:160` — id resolution:
  `contact_id = args.contact_id or matched_contact.get("id") if matched_contact else args.contact_id or slugify(args.name)`.
  When `--match-email` is passed without `--id` and a match is found →
  `matched_contact.get("id")` (reuse existing). No match → `slugify(args.name)`
  (create new). This is the desired behavior; the fallback is preserved.

The two callers defeat this by always supplying `--id`:

- **calendar-backfill.py** — attendee upsert loop:
  - `orgs/clearworksai/agents/crm/crm/calendar-backfill.py:165` —
    `cid = slugify(a.get("displayName") or em.split("@")[0])`
  - `orgs/clearworksai/agents/crm/crm/calendar-backfill.py:166-171` — the
    `run_helper("upsert-contact.py", [...])` call passes `"--id", cid` as the
    first two list elements. This is the ONLY upsert-contact.py call in this file
    (line 186's `run_helper` targets `add-interaction.py`, out of scope).

- **comms-backfill.py** — single `upsert()` wrapper reused by both SENT and
  RECEIVED loops:
  - `orgs/clearworksai/agents/crm/crm/comms-backfill.py:54-59` — `def upsert(cid, name, email, company=None)` builds
    `args = [..., "--id", cid, "--name", name, ...]` at **line 56** and shells out
    at line 59. This is the ONLY upsert-contact.py invocation in the file.
  - Callers of `upsert()` that compute `cid` locally:
    - `orgs/clearworksai/agents/crm/crm/comms-backfill.py:127` (SENT loop):
      `cid = email_to_id.get(em) or slugify(nm) or em.split("@")[0]`
    - `orgs/clearworksai/agents/crm/crm/comms-backfill.py:129` — `upsert(cid, ...)`
    - `orgs/clearworksai/agents/crm/crm/comms-backfill.py:152` (RECEIVED loop):
      `cid = email_to_id.get(em) or slugify(nm) or em.split("@")[0]`
    - `orgs/clearworksai/agents/crm/crm/comms-backfill.py:154` — `upsert(cid, ...)`

> Note on comms-backfill.py's local `email_to_id` map: it already resolves an
> existing id by email *within the script's own in-memory view* (line 127/152).
> But it only knows emails that were loaded at startup (line 93-97) and only the
> emails already stored on a contact — it will still mint a fresh slug for any
> contact whose email isn't in that map, and it seeds `contacts`/`email_to_id`
> with a stub `{"id": cid, "emails": [em]}` (line 131/156) rather than the
> canonical id. Delegating the id decision to `upsert-contact.py --match-email`
> is the single source of truth and fixes both scripts uniformly.

## Fix Approach

Delegate id resolution to `upsert-contact.py`. In both callers, remove the
`--id <cid>` argument pair and add the `--match-email` flag. `upsert-contact.py`
then reuses the existing contact's id on an email match and falls back to
`slugify(name)` when there's no match — identical new-contact naming to today.

## Finding — do NOT fix here (flag only)

`upsert-contact.py:160` relies on Python precedence (ternary binds looser than
`or`), so it parses as
`(args.contact_id or matched_contact.get("id")) if matched_contact else (args.contact_id or slugify(args.name))`.
This produces the correct result for all paths in scope (verified: match →
existing id; no match → slugify), and the existing test
`test_upsert_contact.py::test_match_email_reuses_existing_contact_and_updates_industry`
covers the match path. It is fragile-looking but not broken. **Out of scope — do
not touch `upsert-contact.py`.** Recorded here so codexer does not "helpfully"
rewrite it.

## File Ownership

Codexer owns and edits exactly:
- `orgs/clearworksai/agents/crm/crm/calendar-backfill.py`
- `orgs/clearworksai/agents/crm/crm/comms-backfill.py`
- NEW: `orgs/clearworksai/agents/crm/crm/test_backfill_match_email.py` (test coverage; see below)

Codexer must NOT touch:
- `orgs/clearworksai/agents/crm/crm/upsert-contact.py` (correct as-is)
- Any Mark Lurie merge/dedup path or the crm approval/data-deletion queue (separate, intentional, out of scope)

## Test Strategy

Existing tests:
- `orgs/clearworksai/agents/crm/crm/test_upsert_contact.py` EXISTS and already
  proves `--match-email` reuses an existing contact id
  (`test_match_email_reuses_existing_contact_and_updates_industry`). It uses a
  `subprocess.run` harness with `CRM_CONTACTS_PATH` / `CRM_SUPPRESSION_PATH` env
  overrides pointed at a `tempfile.TemporaryDirectory()`. Reuse this harness
  pattern for the new test.
- NO test file currently exists for `calendar-backfill.py` or `comms-backfill.py`.
  Codexer must ADD one new test file (not update an existing backfill test).

New test file `test_backfill_match_email.py` must assert:
1. **Argument contract (static):** `calendar-backfill.py`'s upsert-contact.py
   invocation passes `--match-email` and does NOT pass `--id`; likewise
   `comms-backfill.py`'s `upsert()` wrapper. This can be a source-level assertion
   (read the file, assert `"--id"` is absent from the upsert-contact.py arg list
   and `"--match-email"` is present) OR a monkeypatched-subprocess capture if the
   functions are refactored to be importable. Prefer the source-level assertion —
   it is robust, requires no gws/network mocking, and directly encodes the bug's
   invariant.
2. **No-duplicate-on-rerun (behavioral, end-to-end through upsert-contact.py):**
   Seed a temp `contacts.json` with one contact `{"id":"mark-lurie","emails":["mark@msia.org"]}`.
   Invoke `upsert-contact.py --match-email --name "Mark" --email "mark@msia.org"`
   (simulating the corrected backfill call where the display name would slugify to
   a different id). Assert the result is still `mark-lurie`, contact count stays 1,
   and no `mark` / `mark-msia-org` record is created. This proves the corrected
   call path no longer mints a duplicate.
3. **New-contact fallback preserved:** Invoke
   `upsert-contact.py --match-email --name "Jane New" --email "jane@newco.com"`
   against a contacts.json with no matching email. Assert a new contact is created
   with id `jane-new` (slugify of the name) — proving the fallback naming is
   unchanged from pre-fix behavior.

Whole suite must still pass: `python3 -m pytest orgs/clearworksai/agents/crm/crm/`
(or at minimum `test_upsert_contact.py` + the new `test_backfill_match_email.py`).

## Rollout Risk — LOW

- Reuses an already-tested code path (`--match-email` lookup). No new logic in
  `upsert-contact.py`.
- Scripts are idempotent backfills; worst case a re-run is a no-op.
- Not a schema change, not multi-repo, no migration. Single-repo OBF-scope.
- No production data deletion — this only stops NEW duplicates from being created.
  Existing duplicates (Mark Lurie x3) are handled separately by crm's approval
  queue and are explicitly out of scope.

## Non-Goals

- No changes to `upsert-contact.py` (logic is correct; line-160 fragility is
  flagged, not fixed).
- No Mark Lurie 3-way merge / dedup — held in crm's approval queue behind a
  data-deletion gate; separate and already-correct.
- No changes to `add-interaction.py` or interaction-logging paths.
- No refactor of comms-backfill.py's local `email_to_id` map beyond what's
  required to drop `--id` and add `--match-email` (it can stay as a best-effort
  in-memory hint; the authoritative id now comes from upsert-contact.py).
