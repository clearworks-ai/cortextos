# Spec 01 — Fix backfill `--id` passing (use `--match-email`)

## Objective

Stop `calendar-backfill.py` and `comms-backfill.py` from passing an explicit
`--id <slug>` to `upsert-contact.py`. Pass `--match-email` instead so
`upsert-contact.py`'s built-in `find_contact_by_email()` resolves the existing
contact by email, falling back to `slugify(name)` for genuinely-new contacts.
This eliminates duplicate-contact creation on every backfill run.

## Owned Files

Edit:
- `orgs/clearworksai/agents/crm/crm/calendar-backfill.py`
- `orgs/clearworksai/agents/crm/crm/comms-backfill.py`

Add:
- `orgs/clearworksai/agents/crm/crm/test_backfill_match_email.py`

Do NOT edit:
- `orgs/clearworksai/agents/crm/crm/upsert-contact.py` (correct as-is)
- Anything in the Mark Lurie merge / dedup / approval-queue path

## Implementation Steps

Line numbers are from a verified read this session. Confirm the exact text before
editing (do not blind-patch by line number).

### Step 1 — calendar-backfill.py (single call site)

Current, `calendar-backfill.py:165-171`:

```python
            cid = slugify(a.get("displayName") or em.split("@")[0])
            run_helper("upsert-contact.py", [
                "--id", cid, "--name", a.get("displayName") or em.split("@")[0],
                "--type", "person", "--email", em,
                "--tag", "calendar-attendee",
                "--source-ref", f"calendar:{event_id}",
            ])
```

Change to (drop the `cid` computation and the `--id`, add `--match-email`):

```python
            run_helper("upsert-contact.py", [
                "--match-email",
                "--name", a.get("displayName") or em.split("@")[0],
                "--type", "person", "--email", em,
                "--tag", "calendar-attendee",
                "--source-ref", f"calendar:{event_id}",
            ])
```

Notes:
- The local `cid` variable at line 165 is used ONLY for this call — remove it.
- Do NOT touch `contact_id` at line 155 (`slugify(prim_name) ...`) — that feeds
  the `add-interaction.py` call at line 186, which is out of scope and correct.
  (add-interaction targets the primary external attendee's slug; leaving it as-is
  keeps interaction logging behavior unchanged. If a later task wants interactions
  attached to the email-resolved id, that is a separate spec.)

### Step 2 — comms-backfill.py (single wrapper, two callers)

Current wrapper, `comms-backfill.py:54-59`:

```python
def upsert(cid, name, email, company=None):
    args = ["python3", str(CRM / "upsert-contact.py"),
            "--id", cid, "--name", name, "--type", "person",
            "--email", email, "--source-ref", "comms-ingest-backfill-2026-06-01"]
    if company: args += ["--company", company]
    subprocess.run(args, capture_output=True, text=True, cwd=str(CRM))
```

Change the wrapper to drop `--id cid` and add `--match-email`. Keep the `cid`
parameter in the signature is OPTIONAL — simplest correct change is to remove the
`cid` parameter entirely since it is no longer passed to the helper, but that
requires updating both call sites. Choose ONE of:

**Option A (preferred — removes dead param, updates call sites):**

```python
def upsert(name, email, company=None):
    args = ["python3", str(CRM / "upsert-contact.py"),
            "--match-email", "--name", name, "--type", "person",
            "--email", email, "--source-ref", "comms-ingest-backfill-2026-06-01"]
    if company: args += ["--company", company]
    subprocess.run(args, capture_output=True, text=True, cwd=str(CRM))
```

Then update the two call sites:
- `comms-backfill.py:129` — `upsert(cid, nm or em.split("@")[0], em, company=company_hint(em))`
  → `upsert(nm or em.split("@")[0], em, company=company_hint(em))`
- `comms-backfill.py:154` — `upsert(cid, nm or em.split("@")[0], em, company=em.split("@")[1] if "@" in em else None)`
  → `upsert(nm or em.split("@")[0], em, company=em.split("@")[1] if "@" in em else None)`

**Option B (minimal — keep signature, ignore cid):** keep `def upsert(cid, name, email, company=None)`
but drop `"--id", cid` and add `"--match-email"` in the args list. Leaves `cid`
unused inside `upsert`. Acceptable but leaves a dead param; Option A is cleaner.

Use **Option A**.

Do NOT change the `cid` computation at lines 127 and 152 themselves, and do NOT
remove the local `email_to_id` / `contacts` stub-append bookkeeping (lines 128-134
and 153-159) — it drives the SENT/RECEIVED stats and the `cid not in {...}`
new-vs-existing branch. It is a best-effort in-memory hint; the authoritative id
now comes from `upsert-contact.py --match-email`. Only the arguments passed to the
helper change.

> Behavioral consequence to be aware of (not a blocker): `cid` is still used at
> line 127/152 to decide the stats bucket (`new_contacts` vs
> `existing_contacts_touched`) and to seed the stub. Because the helper may now
> resolve a DIFFERENT canonical id than the local `cid`, the local stats can drift
> from the true contact identity. This is cosmetic (stats only) and out of scope
> to fix here. Do NOT try to reconcile the stats id with the helper's resolved id
> in this task.

### Step 3 — Add test file

Create `orgs/clearworksai/agents/crm/crm/test_backfill_match_email.py` following
the harness pattern in `test_upsert_contact.py` (subprocess + `CRM_CONTACTS_PATH`
/ `CRM_SUPPRESSION_PATH` env overrides into a `tempfile.TemporaryDirectory()`).

Required test cases:

1. `test_calendar_backfill_passes_match_email_not_id` — read
   `calendar-backfill.py` source; assert the `upsert-contact.py` arg list contains
   `"--match-email"` and does NOT contain `"--id"`. (Static source assertion is
   acceptable and preferred — avoids mocking gws/calendar.)
2. `test_comms_backfill_passes_match_email_not_id` — same static assertion against
   `comms-backfill.py`'s `upsert()` arg list.
3. `test_rerun_does_not_duplicate_existing_email` — seed contacts.json with
   `{"id":"mark-lurie","name":"Mark Lurie","emails":["mark@msia.org"], "tags":[], "source_refs":[]}`;
   run `upsert-contact.py --match-email --name "Mark" --email "mark@msia.org"`;
   assert stdout id == `mark-lurie`, contact count == 1, and no `mark` id exists.
4. `test_new_contact_fallback_slugify_preserved` — empty/non-matching contacts.json;
   run `upsert-contact.py --match-email --name "Jane New" --email "jane@newco.com"`;
   assert a new contact with id `jane-new` is created (slugify fallback intact).

## Validation Requirements

- `python3 -m pytest orgs/clearworksai/agents/crm/crm/test_upsert_contact.py orgs/clearworksai/agents/crm/crm/test_backfill_match_email.py -v`
  must pass (all 4 new cases + the existing match-email case).
- Full crm suite `python3 -m pytest orgs/clearworksai/agents/crm/crm/` must not
  regress.
- Static grep proof: `grep -n '"--id"' orgs/clearworksai/agents/crm/crm/calendar-backfill.py orgs/clearworksai/agents/crm/crm/comms-backfill.py`
  returns NOTHING for the upsert-contact.py call sites (calendar has no other
  `--id`; comms has no other `--id`). `grep -n '"--match-email"'` on both files
  returns the new usages.
- `upsert-contact.py` shows zero diff (`git diff --stat` lists only the two
  backfill scripts + the new test file).

## Handoff Requirements

- Branch name MUST equal the OBF slug exactly: `crm-dupe-contact-fix` (no `fix/`
  prefix — the PR-gate derives the slug from the branch name).
- Open a PR against `clearworks-ai/cortextos`; do not push to main.
- PR description must state: reuses already-tested `--match-email` path; no
  `upsert-contact.py` change; Mark Lurie merge explicitly out of scope; no prod
  data deletion.
- Include the pytest output and the two grep proofs in the PR / verify evidence.
