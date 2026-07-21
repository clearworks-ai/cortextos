# 02 — Master Plan: watchdog-execfile-path-hardening

Slug: `watchdog-execfile-path-hardening`
Framework: one-big-feature (single cohesive fix, one repo, no schema, no multi-repo)
Date: 2026-07-20

## The single feature

Harden the idle-session heartbeat watchdog spawn at `src/daemon/fast-checker.ts:240` so it no longer depends on PATH resolution of bare `'cortextos'`. Mirror the proven `emitHookBusEvent()` pattern from `src/bus/hooks.ts:307-336` identically: when `CTX_FRAMEWORK_ROOT` is set, invoke `process.execPath` + `join(frameworkRoot, 'dist', 'cli.js')` with a 5s timeout; when unset (unit tests / legacy), fall back to bare `'cortextos'`.

## Approach

1. Replace the single `execFile('cortextos', ...)` call at fast-checker.ts:240 with the CTX_FRAMEWORK_ROOT-branched form (exact code in `03-specs/01-spec.md`).
2. `join` is already imported in fast-checker.ts (line 3) — verified; no import change expected. If it were somehow missing at implementation time, add `import { join } from 'path'`.
3. Update/extend the existing heartbeat-watchdog unit tests to assert both branches.

## Files touched (exactly 2)

| File | Change |
|---|---|
| `src/daemon/fast-checker.ts` | 1 call site (~line 240) rewritten to the branched pattern |
| `tests/unit/daemon/fast-checker.test.ts` | Update `describe('heartbeat watchdog')` block (lines 1104-1153): existing assertions on bare `'cortextos'` adjusted for env state; add assertions for the CTX_FRAMEWORK_ROOT branch |

No other src/ files. No schema. No new dependencies.

## Test plan

In `tests/unit/daemon/fast-checker.test.ts` (vitest, `vi.mock('child_process')` already in place at line 3):

1. **CTX_FRAMEWORK_ROOT set** → after `vi.advanceTimersByTimeAsync(50 * 60 * 1000)`, `execFile` was called with `process.execPath`, an args array starting with `join(root, 'dist', 'cli.js')` then `['bus', 'update-heartbeat', ...'[watchdog] my-agent alive — idle session'...]`, an options object containing `timeout: 5_000`, and a callback. Assert it was NOT called with bare `'cortextos'`.
2. **CTX_FRAMEWORK_ROOT unset** → `execFile` called with bare `'cortextos'` and the same `['bus', 'update-heartbeat', ...]` args (legacy fallback, matching current test at line 1114-1118).
3. Save/restore `process.env.CTX_FRAMEWORK_ROOT` in beforeEach/afterEach so branch selection is deterministic per test.
4. Keep the existing stop-clears-timer and no-fire-before-bootstrap tests green (adjust their `'cortextos'` expectations to whichever env state they run under).

## Verify commands

```bash
npm run build   # TS must compile clean
npm test        # all green
```

## Risk

**LOW** — mirrors a proven, shipped pattern (`hooks.ts:307-336`) already exercised in production under PM2. Behavior when `CTX_FRAMEWORK_ROOT` is unset is byte-identical to today.

## Rollback

Revert the single commit (`git revert <sha>`). No state, schema, or config migration involved.
