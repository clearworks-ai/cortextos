# 01 — Research: worker-session-telegram-bypass

**Repo:** `/Users/joshweiss/code/cortextos`
**Branch:** `fix/fleet-bus-daemon-bugfixes` (line numbers verified 2026-07-17)
**Framework:** one-big-feature (single cohesive bug fix, one existing repo, no schema/migration/multi-repo)

## The bug

`src/hooks/hook-permission-telegram.ts` `main()` deny-fasts a permission
request ONLY when the `.cron-active` marker is present:

- `readCronActive(env.stateDir)` — line 139
- cron deny-fast block — lines 140-152 (emits bus event, `outputDecision('deny', ...)`, returns)

Immediately after (line 154, `// Build human-readable summary`) the code falls
through to the interactive Telegram Approve/Deny path (lines 154+), which
forwards a live prompt to Josh's phone and waits up to 30 minutes
(`outputDecision('deny', 'Timed out waiting for Telegram approval (30m)')`, line 215).

Worker-session PTYs (`comms-check-*`, `transcript-scanner-*`, meeting-brief page
workers, etc.) are launched with env `CTX_WORKER=1`:

- `src/pty/agent-pty.ts:83-85` — `if (this.env.worker) { ptyEnv['CTX_WORKER'] = '1'; }` (VERIFIED)

Workers write NO `.cron-active` marker, so a risky tool call inside a worker
misses the cron deny-fast and falls through to the interactive path. Nobody is
present to approve a worker — identical to cron — so the worker hangs 30 minutes.
Re-escalated twice by the `pa` agent.

## Verified facts (Read/Grep, not trusted blindly)

1. `src/pty/agent-pty.ts:83-85` sets `CTX_WORKER=1` when `this.env.worker`. CONFIRMED.
2. `src/hooks/hook-permission-telegram.ts`:
   - `readCronActive` module-scope helper defined at line 48.
   - cron deny-fast: lines 139-152; `// Build human-readable summary` at line 154. CONFIRMED.
   - `async function main()` at line 109.
3. **Import-side-effect: PROBLEM CONFIRMED.** The bottom of the file (line 219)
   calls `main().catch(...)` UNCONDITIONALLY — there is NO `if (require.main === module)`
   or equivalent guard. So `import { isWorkerSession } from '.../hook-permission-telegram'`
   in a vitest test WILL execute `main()`, which calls `readStdin()`.
   - Per stage scope, the module's execution guard is NOT changed by this fix.
   - Mitigation (in-test, no source change): the test mocks `process.stdin` so
     `readStdin()` never yields data and never rejects. `main()`'s promise stays
     pending and harmless; the imported `isWorkerSession` is pure and tested in
     isolation. See spec `03-specs/01-worker-deny-fast.md` §Test for the exact stub.
   - **FLAG TO LARRY:** the unconditional bottom-of-file `main()` call is a latent
     import hazard. This fix does NOT touch it (out of scope). If the maintainer
     prefers a real `require.main` guard, that is a separate change for Larry to
     decide — do not fold it into this OBF.

## Fix shape (design FIXED upstream — do not redesign)

1. Add exported `isWorkerSession()` predicate near `readCronActive`.
2. Add a worker deny-fast block in `main()` AFTER the cron block (cron stays first).
3. New vitest test file for `isWorkerSession`.

Cron check stays FIRST (a worker running a cron is still cron-attributed). No new
bus event for the worker path — keep the diff minimal; observability out of scope.

## Out of scope

Cron path, bus events, `src/pty/agent-pty.ts` (read-only reference), the
bottom-of-file `main()` execution guard, any other formatter/hook.
