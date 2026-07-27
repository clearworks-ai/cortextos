# True-Verify — comms-meeting-dedup

Verifier: larry
Date: 2026-07-27 (re-verified after 24h stale)

## Independent verification (re-run against working tree)
- `npx tsc --noEmit -p tsconfig.json` → exit 0 (clean typecheck).
- `npx vitest run tests/unit/cli/send-message-source-key.test.ts tests/unit/cli/send-telegram-source-key.test.ts` → **2 files, 13/13 tests pass**.
- Scope: `src/cli/bus.ts` + the two source-key test files changed. No Part A symbols in diff.

## Fail-closed behavior confirmed in code
- `send-message` and `send-telegram`: `--kind comms` requires a valid `--source-key` AND `CTX_ROOT`, exits 1 otherwise; overrides `--no-dedup`.
- default kind preserves prior fail-open path (invalid key warns, byte-hash fallthrough).
- `parseKind` throws on any value other than `comms`/unset.

## Known unrelated red
- `concurrent-cron-mutations.test.ts` (full suite) is a pre-existing pinned expected-fail, untouched by this diff.
- `bus-update-heartbeat-guard.test.ts` is an UNTRACKED new file from a different feature (not in this diff's scope).

VERDICT: PASS — safe to open PR. Merge remains gated on Josh.
