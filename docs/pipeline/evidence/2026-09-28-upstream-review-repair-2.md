# Upstream review-repair wave 2 (on 75eb10a)

Worker `task_1790616896855_81108022`. Session `9bf9d6ba-245a-4662-ace5-dba3653acb0c`.
Parent `75eb10a`. Merge `24280d2` preserved. See consolidated ledger
`docs/pipeline/evidence/2026-09-28-upstream-final-verification.md`.

Root cause: batch `getActiveCronOutcomes` validated every name before the lock, so one bad name skipped recovery for all; each requested lookup rescanned all nonterminal rows.

Skipped: extra 100x files beyond the named manifest; receipts on build/unit/dashboard jobs; tightening the 5s bound below product SLO.
