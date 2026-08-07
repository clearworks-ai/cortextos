# True-Verify — PR#317 (crm-dupe-contact-fix)

Performed directly by larry, fresh worktree from the actual PR ref (not trusting codexer's or the reviewer's claims):

```
git fetch origin pull/317/head:pr317-verify-local
git worktree add /tmp/pr317-verify pr317-verify-local
```

1. `grep -c '"--id"' calendar-backfill.py comms-backfill.py` → 0, 0 (confirmed absent at both call sites).
2. `grep -c '"--match-email"' calendar-backfill.py comms-backfill.py` → 1, 1 (confirmed present at both call sites).
3. `git diff main...HEAD -- .../upsert-contact.py | wc -l` → 0 (confirmed zero-diff, untouched).
4. `python3 -m pytest test_backfill_match_email.py -v` in the fresh worktree → **4 passed** (test_calendar_backfill_passes_match_email_not_id, test_comms_backfill_passes_match_email_not_id, test_new_contact_fallback_slugify_preserved, test_rerun_does_not_duplicate_existing_email). No skips, no failures, no errors.

Combined with the independent review (05-reviews/01-independent-review.md, score 3/5, real test runs + a reproduced non-blocking finding on new-contact interaction linkage — recommended as a fast-follow, not a merge blocker): PR#317 correctly fixes the reported duplicate-contact-creation bug, does not touch upsert-contact.py or the Mark Lurie merge, and is fully tested. Ready for Josh's merge approval.
