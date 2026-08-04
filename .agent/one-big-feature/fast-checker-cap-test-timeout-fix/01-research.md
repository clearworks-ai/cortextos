# Research — fast-checker 5000-entry-cap test flake

`tests/unit/daemon/fast-checker.test.ts`, test `'holds the 5000-entry cap, evicting oldest first'`
(search `5000-entry cap`) hit the default 10000ms test timeout twice today (2026-08-04), both times
on unrelated diffs (PR#249, PR#250), both times passed clean on a plain rerun.

Root cause read directly from `src/daemon/fast-checker.ts`: `isDuplicate()` calls
`saveDedupHashes()` on every invocation, which sorts the full entry set (`Array.from(...).sort(...)`)
and does a synchronous `writeFileSync` rewrite of up to `DEDUP_MAX_ENTRIES` (5000) lines. The test
calls `isDuplicate()` 5100 times in a tight loop, so it's ~5100 full sorts + full-file rewrites —
real, non-trivial synchronous I/O that's genuinely sensitive to CI disk contention. This is an
environment-timing flake, not a logic defect: the assertions themselves (cap holds at 5000, oldest
evicted, most recent survives) are correct and pass every time, just sometimes too slowly.
