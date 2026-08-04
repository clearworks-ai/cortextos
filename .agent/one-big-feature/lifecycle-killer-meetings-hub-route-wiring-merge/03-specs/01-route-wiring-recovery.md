---
# Spec 01 — recover orphaned meetings-hub route wiring (lifecycle-killer)

## Repo
`clearworks-ai/lifecycle-killer` (client repo, NOT cortextos). Work in an isolated worktree, not
the already-checked-out `~/code/lifecycle-killer` (that clone is mid-work on another branch with
uncommitted changes — do not disturb it).

## Exact steps
```bash
git worktree add /tmp/lk-route-wiring-recovery main
cd /tmp/lk-route-wiring-recovery
git fetch origin feat/meeting-intelligence-spec06b-cxportal-db-write
git checkout -b fix/meetings-hub-route-wiring-recovery
git cherry-pick 83f4de6 3af00c3
```
If cherry-pick conflicts (merge-tree read clean, but verify live) — resolve for real, do not
paper over. These are Josh's own authored commits from 2026-07-27; preserve their content
exactly, don't rewrite logic.

## Verify
```bash
npm install
npm test        # must show 0 failed test files (was 9 failed / 29 passed on main)
npm run build   # must be clean
```
Confirm test output literally shows the 9 previously-failing files now passing:
tests/dogfood/{intake,interviews-phase3,interviews-routes,meetings-calendar,meetings-fireflies,
meetings-portal-share,meetings-rich-notes-attachments,meetings-zoom,surveys}.test.ts

Report actual pass/fail counts from the real test run output — do not assume or narrate a clean
result without running it.

## PR
```bash
git push -u origin fix/meetings-hub-route-wiring-recovery
gh pr create --repo clearworks-ai/lifecycle-killer --title "fix: recover orphaned meetings-hub route wiring + commitment sync worker" --body "..."
```
Body must state: this is a recovery merge of 2 already-authored, already-pushed commits
(83f4de6, 3af00c3) that never made it to main because a sibling branch (PR#49) superseded the
branch they lived on without carrying them forward. No new logic authored. Root-cause + full
provenance trace in `.agent/one-big-feature/lifecycle-killer-meetings-hub-route-wiring-merge/01-research.md`.

## Out of scope
Do not touch auditos or nonprofit-hub test failures (separate, untracked investigations).
Do not modify any other lifecycle-killer file beyond what the cherry-pick brings in.
---
