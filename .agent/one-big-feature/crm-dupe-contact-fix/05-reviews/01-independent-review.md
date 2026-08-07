# Independent Review — PR#317 (crm-dupe-contact-fix)

**Score: 3/5 — core fix is correct and well-tested; ships a real but narrower secondary bug (dangling contact_id on interactions for genuinely-new contacts whose name slugifies differently between the two backfill scripts and upsert-contact.py). Recommend a fast follow-up, not a hard block on this merge.**

Method: pulled the PR (`gh pr diff 317`), built a scratch git worktree at `crm-dupe-contact-fix` (merge-base `9e1f1dce`), ran the actual test suite, and independently reproduced the slugify divergence with real Python — not just read the code.

## 1. Diff matches the stated fix — CONFIRMED
- `orgs/clearworksai/agents/crm/crm/comms-backfill.py:59-61` — `upsert()` now calls `upsert-contact.py` with `"--match-email"` and no `"--id"`.
- `orgs/clearworksai/agents/crm/crm/calendar-backfill.py:171-177` — the single `upsert-contact.py` call site passes `"--match-email"`, no `"--id"`.
- `grep -n '"--id"' calendar-backfill.py comms-backfill.py` → zero hits. `grep -n '"--match-email"'` → one hit in each file. Matches the PR body's grep proofs exactly.

## 2. upsert-contact.py untouched — CONFIRMED
`git diff <merge-base> HEAD -- .../upsert-contact.py` → empty, zero-line diff, as claimed. The gate at `upsert-contact.py:158-159` (`if args.match_email and not args.contact_id: matched_contact = find_contact_by_email(...)`) and the fragile-looking ternary at `upsert-contact.py:160` were inspected; the ternary is correct (Python conditional-expressions bind looser than `or`, and `matched_contact` is only ever truthy when `args.contact_id` is already falsy per the gate above) — matches the PR's own characterization that it's "fragile-looking but not broken."

## 3. New test file — ran it, not just read it
`test_backfill_match_email.py` (110 lines) has two classes:
- `BackfillArgContractTests` — static source assertions, both scripts, `--match-email` present / `--id` absent. **PASS (2/2)**.
- `BackfillBehavioralTests` — `test_rerun_does_not_duplicate_existing_email` (existing `mark-lurie` contact, rerun with a differently-slugifying display name `"Mark"`, asserts count stays 1, no `mark` id minted) and `test_new_contact_fallback_slugify_preserved` (new contact → `jane-new`, fallback unchanged). **PASS (2/2)**.

Ran `pytest test_backfill_match_email.py` standalone in a clean worktree: **4 passed**. Ran the full crm test directory: **28 passed, 2 skipped** (skips are pre-existing/unrelated), no regressions anywhere else in the suite.

**Reproducibility gap (minor, worth a note):** the PR body claims "5 passed (4 new + the existing `test_match_email_reuses_existing_contact`)". `test_upsert_contact.py` is gitignored (`.gitignore:17: orgs/clearworksai/*`) and is **not part of this PR's diff or git history** — a fresh checkout of the branch does not have that file (confirmed: absent from the clean worktree; `pytest` errors with "file or directory not found" if you try to run it there). The "5 passed" figure only reproduces in the author's local sandbox where that untracked file happens to already exist on disk. Not a blocker — the 4 new tests are fully self-contained and pass on their own — but the PR body overstates what a fresh clone / CI can verify.

## 4. Regression risk from dropping `--id` — REAL, FOUND ONE
The primary risk (correctly re-matching an *existing* contact by email) is handled and tested. But there is a genuine secondary regression for **brand-new contacts**:

- `comms-backfill.py` and `calendar-backfill.py` each compute their **own** local `slugify()` (comms-backfill.py:25-28, calendar-backfill.py:53-56 — identical to each other) to build the `contact_id` used for `log_interaction()` / `add-interaction.py --contact-id`.
- `upsert-contact.py` has a **different** `slugify()` (upsert-contact.py:79-81: `re.sub(r"[^a-z0-9]+", "-", ...)` vs. the backfills' `re.sub(r"[^\w\s-]", "", ...)` then whitespace→dash).
- Before this fix, `--id <cid>` was passed explicitly, so `upsert-contact.py` always adopted the caller's id — the two slugify implementations could never disagree in practice; the invariant "id used to log the interaction == id the contact was actually created under" was structural. After this fix, for a genuinely new contact (no email match), `upsert-contact.py` slugifies the name **itself**, independent of the caller's locally-computed `cid`. **This divergence is newly exposed by this PR, not pre-existing** — it was impossible to hit before because `--id` forced synchronization.
- Reproduced directly (ran the two slugify functions side by side): `"Jane O'Brien"` → backfill scripts produce `"jane-obrien"`, `upsert-contact.py` produces `"jane-o-brien"`. Also diverges on `"Anna_Lee"` (underscore), `"François Müller"` (diacritics), `"A.J. Smith"` (abbreviation) — plausible real contact names, not fabricated edge cases.
- Ran it fully end-to-end against the actual scripts: `upsert-contact.py --match-email --name "Jane O'Brien" --email jane@obrien.com` on an empty `contacts.json` creates the contact under id `jane-o-brien`; `comms-backfill.py`'s locally-computed `cid` for that same name is `jane-obrien` — a different string that gets passed to `add-interaction.py --contact-id` and appended to `comms-backfill.py`'s in-memory `contacts` bookkeeping list.
- `add-interaction.py` does **no existence check** on `--contact-id` (read the full 57-line file — it just appends the JSON record to `interactions.jsonl`). So the interaction is silently logged against a `contact_id` that was never created anywhere in `contacts.json`, orphaning that meeting/email from the actual new contact record with no error surfaced.
- Recommendation: have both backfill scripts capture `upsert-contact.py`'s stdout (it already prints the resolved contact id — confirmed in the reproduction above) and use *that* value for `add-interaction.py --contact-id` instead of re-deriving it locally with a different slugify; or unify the two slugify implementations into one shared function. Small, fast follow-up — not a reason to revert this PR.

## 5. Mark Lurie 3-way merge — CONFIRMED untouched
`git diff <merge-base> HEAD --name-only` touches exactly 3 files: `calendar-backfill.py` (new), `comms-backfill.py`, `test_backfill_match_email.py`. No `contacts.json`, no merge/dedup script, nothing referencing `mark-lurie` / "3-way merge" outside the test fixture id inside the new test file. Matches the PR's claim that the merge stays out of scope, held in crm's approval queue.

## Summary
Diff matches the spec exactly, `upsert-contact.py` is genuinely zero-diff, and every claimed test passes (28/28 relevant, no regressions). The one real finding is #4: dropping `--id` removes an implicit invariant (caller-id == created-id) both backfill scripts silently relied on for new-contact interaction logging, and their local slugify no longer matches `upsert-contact.py`'s independently-computed id for punctuation/underscore/diacritic names. Recommend a fast follow-up (thread `upsert-contact.py`'s printed id back into `add-interaction.py`) rather than blocking this merge — the fix as shipped correctly solves the reported duplicate-contact bug and is well-tested for the case it targets.
