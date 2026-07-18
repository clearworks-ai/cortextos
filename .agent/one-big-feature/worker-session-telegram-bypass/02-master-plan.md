# 02 — Master Plan: worker-session-telegram-bypass

**Repo:** `/Users/joshweiss/code/cortextos`
**Branch:** `fix/fleet-bus-daemon-bugfixes`
**Framework:** one-big-feature
**Slug:** `worker-session-telegram-bypass`

## Goal

Deny-fast permission requests originating from worker-session PTYs
(`CTX_WORKER=1`) in `src/hooks/hook-permission-telegram.ts`, the same way
cron-originated requests already deny-fast — so a worker never forwards a live
Telegram Approve/Deny to Josh and hangs 30 minutes with no human to approve it.

## Scope (exactly two files touched)

| File | Change |
|------|--------|
| `src/hooks/hook-permission-telegram.ts` | Add exported `isWorkerSession()` helper; add worker deny-fast block in `main()` after the cron block. |
| `tests/unit/hooks/hook-permission-telegram.test.ts` | NEW vitest file testing `isWorkerSession()`. |

Read-only reference (NOT edited): `src/pty/agent-pty.ts` (source of `CTX_WORKER=1`).

## Design (fixed — see spec)

1. `isWorkerSession()` returns `process.env.CTX_WORKER === '1'`. Exported, placed
   just after `readCronActive`, with a docblock explaining worker PTYs have no
   human attached.
2. In `main()`, immediately after the cron deny-fast block (after line 152,
   before the `// Build human-readable summary` at line 154):
   ```ts
   if (isWorkerSession()) { outputDecision('deny', '...'); return; }
   ```
   Cron check stays FIRST. No bus event for the worker path.
3. New test covers `'1'` → true; unset → false; `'0'` and other values → false;
   `process.env.CTX_WORKER` saved/restored per case.

## Known hazard (flagged, out of scope to fix here)

`hook-permission-telegram.ts` calls `main()` unconditionally at line 219 (no
`require.main` guard). Importing the module runs `main()` → `readStdin()`. The
test mitigates this with an in-test `process.stdin` stub so `readStdin()` never
yields/rejects; `main()`'s promise stays pending and harmless. The guard itself
is NOT changed by this fix — flagged to Larry as a separate decision.

## Verification gates

1. `npm run build` — clean strict compile.
2. `npm test` — full suite green.
3. `npx vitest run tests/unit/hooks/hook-permission-telegram.test.ts` — green.
4. No `console.log` / `: any` introduced in the two touched files.

## Out of scope

Cron path, bus events, `agent-pty.ts`, the bottom-of-file `main()` execution
guard, any other formatter/hook.
