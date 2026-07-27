# SPEC — clean error message for `bus update-heartbeat` sandbox guard

**Status:** TDD — test file already committed: `tests/unit/cli/bus-update-heartbeat-guard.test.ts` (2 of 3 tests fail today).

## Problem
`src/cli/bus.ts`, `update-heartbeat` command action (~line 914), calls `resolveEnv()` with no try/catch. `resolveEnv()` (`src/utils/env.ts`, ~lines 135-153) throws when the sandbox/live isolation guard trips (`CTX_AGENT_DIR` not under `CTX_FRAMEWORK_ROOT`, or `CTX_PROJECT_ROOT` != `CTX_FRAMEWORK_ROOT`). Today that throw is uncaught, so it prints a raw stack trace instead of a clean one-line error + exit(1).

## Required change
Wrap the body of the `update-heartbeat` action (the `resolveEnv()` call through the `updateHeartbeat(...)` call, ~lines 914-960ish — read the current action body first) in try/catch:

```ts
try {
  // existing body unchanged
} catch (err) {
  console.error(`update-heartbeat failed: ${(err as Error).message}`);
  process.exit(1);
}
```

Follow the exact existing pattern used elsewhere in `bus.ts` (see other `catch (err)` blocks around lines 393-405, 476-485 for the house style — some use `.message`, keep consistent).

## Contract (from `tests/unit/cli/bus-update-heartbeat-guard.test.ts`)
- On `CTX_AGENT_DIR` outside `CTX_FRAMEWORK_ROOT`: stderr is EXACTLY one line matching `/^update-heartbeat failed: .*not under CTX_FRAMEWORK_ROOT/`, no `\n`, no stack trace lines, `process.exit(1)` called once.
- On `CTX_PROJECT_ROOT` diverging from `CTX_FRAMEWORK_ROOT`: same shape, message matches `/^update-heartbeat failed: .*must equal CTX_FRAMEWORK_ROOT/`.
- Happy path (subordinate agent dir) must be UNCHANGED — heartbeat still written, `console.log('Heartbeat updated: sage')`, no exit call. (This test already passes — do not break it.)

## Verify
`npx vitest run tests/unit/cli/bus-update-heartbeat-guard.test.ts` — 3/3 pass. `npm run build` clean. Do not touch the test file.

## Done =
All 3 tests in that file pass, build clean, no other files touched.
