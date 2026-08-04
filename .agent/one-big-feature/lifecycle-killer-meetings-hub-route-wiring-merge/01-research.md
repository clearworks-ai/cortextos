# Research — lifecycle-killer: 9 failing test files, 26 failures, root cause

## Symptom
test-status cron flagged lifecycle-killer 26/186 test failures across 9 files. Confirmed
reproducible on `main` directly (verified in a clean `git worktree add /tmp/lk-main-check main`,
not just a stale local branch): 9 failed / 29 passed test files, 26 failed / 145 passed tests.

Failing files: tests/dogfood/{intake,interviews-phase3,interviews-routes,meetings-calendar,
meetings-fireflies,meetings-portal-share,meetings-rich-notes-attachments,meetings-zoom,
surveys}.test.ts

## Root cause
Nearly all failures are `expected 404` — the routes under test (`POST /api/meetings/:id/zoom`,
`/:id/calendar`-invite, `/:id/fireflies`, rich-notes/attachments CRUD, portal-share routes) do
not exist in `server/routes.ts` on main at all (confirmed via grep — zero matches).

Traced via `git log --oneline --all -S "meetings/:id/zoom" -- server/routes.ts`: exactly one
commit ever added that route registration — `83f4de6 fix(meetings): wire cxportal meetings hub
routes` (Josh, 2026-07-27, +939/-43 lines to routes.ts). This commit lives on branch
`feat/meeting-intelligence-spec06b-cxportal-db-write` (pushed to origin), which is not an
ancestor of main (`git merge-base --is-ancestor 83f4de6 HEAD` = false).

Provenance chain:
1. PR#42 (`feat/cxportal-meetings-hub`, merged as f6ef075) added the 5 meetings-hub test files
   + a partial routes.ts (+580 lines) — incomplete, missing several route registrations the
   tests require.
2. `83f4de6` (same day, later) on a different, never-merged branch wired the missing routes
   (+939/-43) — this is the real fix, but the branch it lives on was abandoned.
3. PR#49 (`feat/meeting-intelligence-spec06b-cxportal-dual-write-clean-v2`, merged as 5be83a0,
   current main tip) was a separate, "clean" rebuild of only the ingest-endpoint/dual-write
   slice (POST /api/meetings/ingest + sync workers) — it did not carry forward 83f4de6's route
   wiring, because it branched from a common ancestor (699732a) rather than from the branch that
   had 83f4de6.

Net effect: main has PR#42's test files + partial routes, never got 83f4de6's completion fix.
26 tests have been failing since 2026-07-27, silently (no CI merge-gate blocked PR#49 on it).

## The fix already exists, unmerged
Branch `feat/meeting-intelligence-spec06b-cxportal-db-write` (origin, still present) has 2
commits main is missing:
- `83f4de6` fix(meetings): wire cxportal meetings hub routes (+939/-43 server/routes.ts)
- `3af00c3` feat(meetings): add cxportal commitment sync worker (+626, 2 new files: a
  `scripts/sync_commitments_from_cxportal.py` variant + `tests/dogfood/meetings-service-ingest.test.ts`)

Checked for collision: main has NO `scripts/sync_commitments_from_cxportal.py` at all (PR#49
never added one despite its commit message mentioning one — that file only exists as an
untracked artifact on disk in the already-checked-out local clone, not in main's git history).
So 3af00c3 introduces no conflicting/duplicate file.

`git merge-tree $(git merge-base main feat/meeting-intelligence-spec06b-cxportal-db-write) main
feat/meeting-intelligence-spec06b-cxportal-db-write` — no real conflict markers (only a false
grep hit on the literal word "conflict" inside an unrelated import line). Clean fast-forward-style
merge is expected.

## Scope of the fix
Cherry-pick (or merge) `83f4de6` and `3af00c3` onto a fresh branch off current main, resolve any
real conflicts if `merge-tree`'s clean read was wrong, run full test suite, confirm the 9
currently-failing files (26 tests) now pass, confirm no regressions in the 29 currently-passing
files, open PR.

No schema migration. No new tables. Single repo (lifecycle-killer). Qualifies as OBF (M2C1-lite).

## Out of scope (other test-status findings, tracked separately)
- auditos: 81/1046 failures — separate investigation, not started.
- nonprofit-hub: no test script configured — separate investigation, not started.
