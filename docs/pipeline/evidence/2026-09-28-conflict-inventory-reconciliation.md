# Conflict inventory reconciliation (44 vs 46)

Bound to reviewed merge SHA `24280d2e239eee5d1855aaff089c2b3cb6d467be`.
Parents: `bba3fefb9e83963d50ea1df8737ff75be347b953` (first, baseline) + `6f9383809f7b87a15e9819f83f9a7f147b202883` (second). First-parent's parent `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` is origin/main. Merge-base `a15baad45cde344f97468ce1b8fe1d012125a415`.

## Drift

| Count | What it is |
|---|---|
| 46 | Plan-time `git merge-tree --write-tree` predicted textual conflicts |
| 44 | Live `git merge --no-ff --no-commit` unmerged paths at Task 2 |
| 2 | Auto-merged, still in the 46: `templates/agent/CLAUDE.md`, `templates/orchestrator/CLAUDE.md` |
| 24 | Unmerged remaining after Tasks 3–4 staged 20 of the 44 (44 − 20 = 24). Not a third inventory. |
| 0 | Unmerged after Tasks 5–7 |

## Why the two CLAUDE.md files auto-merged

Both sides edited overlapping regions that git could combine without markers. D-07 still applied: Clearworks policy text stayed; portable date-format quoting was ported. They were not skipped.

## Acceptance mapping

“All 46 predicted conflicts resolved” is true iff: 44 paths have explicit conflict resolutions **and** the two auto-merged CLAUDE.md files were D-07-reviewed. Treating 44 as a plan error, or 24 as a missing-22, is incorrect.

Machine-readable twin: `docs/pipeline/evidence/2026-09-28-conflict-inventory-reconciliation.json`.
