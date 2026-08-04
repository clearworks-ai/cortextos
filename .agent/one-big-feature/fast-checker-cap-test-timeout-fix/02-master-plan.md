# Master Plan — fast-checker 5000-entry-cap test flake

## Summary
Test-only fix. Give the one flaky test (`holds the 5000-entry cap, evicting oldest first`) a
longer explicit per-test timeout so it has headroom under CI I/O contention. No application logic
touched — `src/daemon/fast-checker.ts` is out of scope entirely (also under a separate freeze this
session).

## Non-goals
- No change to `saveDedupHashes()` / `isDuplicate()` behavior.
- No change to any other test in the file.
- No reduction in the 5100-iteration loop or the 5000-entry cap assertion — the test should keep
  proving the same real behavior, just with room to finish under CI load.

## Shard list
- Spec 01 (only shard): bump the one test's timeout.

## Test strategy
Run the full `fast-checker.test.ts` suite; must stay green. Repo-root `npm run build && npm test`
must stay clean per repo CLAUDE.md.

## Rollout / approval gates
Standard PR flow — Josh merge gate, no direct push to main.
