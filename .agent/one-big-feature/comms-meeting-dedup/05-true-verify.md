# True-Verify — comms-meeting-dedup Part B

Verifier: larry
Date: 2026-07-26

## Independent verification (re-run against working tree)
- `npx tsc --noEmit -p tsconfig.json` → exit 0 (clean typecheck).
- `npx vitest run tests/unit/cli/send-message-source-key.test.ts tests/unit/cli/send-telegram-source-key.test.ts` → **2 files, 13/13 tests pass**.
- Scope: `git status --short` confirms only `src/cli/bus.ts` + the two source-key test files changed (plus planning docs). No Part A symbols in diff (`renderCommsSurfaceMessage|comms-filter.*surface` = 0 matches).

## Fail-closed behavior confirmed in code
- `send-message` and `send-telegram`: `--kind comms` requires a valid `--source-key` AND `CTX_ROOT`, exits 1 otherwise; overrides `--no-dedup` (`sourceDedupEnabled = kind === 'comms' || opts.dedup !== false`).
- default kind preserves prior fail-open path (invalid key warns, byte-hash fallthrough) — `kind !== 'comms' && !isValidSourceKey(...)` guard.
- `parseKind` throws on any value other than `comms`/unset.

## Known unrelated red
- `concurrent-cron-mutations.test.ts` (full suite) is a pre-existing pinned expected-fail (update-cron scheduler live-sync), untouched by this diff.

VERDICT: PASS — safe to open PR. Merge remains gated on Josh.
