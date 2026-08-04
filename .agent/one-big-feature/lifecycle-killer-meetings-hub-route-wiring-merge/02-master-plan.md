---
# Master plan — lifecycle-killer meetings-hub route wiring merge

## Goal
Land the already-authored, already-tested route wiring (`83f4de6`) + commitment sync worker
(`3af00c3`) from the orphaned branch `feat/meeting-intelligence-spec06b-cxportal-db-write` onto
main, fixing 26 currently-failing tests across 9 files with zero new code authored — this is a
recovery merge, not new development.

## Steps
1. In an isolated worktree off `~/code/lifecycle-killer` (never the shared checkout — this is a
   client repo, still use a worktree to avoid disturbing the already-non-main local checkout at
   `~/code/lifecycle-killer`, which is mid-work on another branch with uncommitted changes).
2. `git checkout -b fix/meetings-hub-route-wiring-recovery main`
3. `git cherry-pick 83f4de6 3af00c3` (or merge the source branch — cherry-pick preferred, keeps
   history linear and avoids pulling in unrelated branch drift).
4. Resolve any real conflicts (merge-tree read clean, but verify live).
5. `npm test` — confirm the 9 previously-failing files now pass, 26 failures resolved, no new
   regressions vs the 29-passing baseline documented in 01-research.md.
6. `npm run build` clean.
7. Open PR against `clearworks-ai/lifecycle-killer` main. Title: "fix: recover orphaned
   meetings-hub route wiring + commitment sync worker (26 failing tests -> 0)".
8. Independent review: verify diff is exactly the 2 cherry-picked commits (or equivalent),
   verify test run was real (not narrated), verify no unrelated files touched.

## Risk
Low — this is landing code Josh already authored and reviewed once (commit author = Josh Weiss),
not new logic. Main risk is a stale conflict merge-tree didn't catch; codexer must run tests for
real and report actual pass/fail counts, not assume clean.
---
