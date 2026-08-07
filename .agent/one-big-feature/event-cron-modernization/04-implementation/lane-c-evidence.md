# Lane C — deterministic Google provider lifecycle evidence

Scope: provider lifecycle CLI/modules, reusable PA DWD helper, Gmail listener
import refactor, and focused tests only. CLI registration remains for the
integration lane. No provider, cloud, runtime, credential, config, cron,
subscription, watch, or channel mutation was performed.

## Verification

- `npm run typecheck` — pass
- `npx vitest run tests/unit/cli` — 26 files, 252 tests passed
- Focused provider/bridge regression — 3 files, 72 tests passed
- Focused PA regression — 26 tests passed, 1 skipped
- DWD helper tests — 3 tests passed
- Python compile check for helper/listener — pass
- `npm run build` — pass
- `git diff --check` — pass

The broader PA discovery suite has unrelated baseline failures in
`test_ff_extractor.py` (out-of-scope `meeting_id` signature and prompt
expectations); the focused PA suites owned or touched by this lane pass.

## Integration seam

`src/cli/google-provider.ts` intentionally is not registered in
`src/cli/index.ts`. The integration lane must register `googleProviderCommand`
and provide Lane B's pending/reconcile/cleanup functions plus a fail-closed
`markCalendarShadowChannelStopped(stateDir, channelId)` export so successful
Calendar stop removes handler eligibility.
