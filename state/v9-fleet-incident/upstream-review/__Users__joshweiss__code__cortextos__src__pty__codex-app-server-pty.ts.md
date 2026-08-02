# Deep pass: src/pty/codex-app-server-pty.ts (fork vs upstream/main)

Analyzed: 2026-08-02 (M1 backfill). Upstream ref = `upstream/main` @ `dfedf9b`. Divergence: **+24 / -21 lines** — a single hunk set: the app-server spawn is routed through pty-host.

## D1. Spawn via `hostSpawn` + async `.then()` continuation — carries RW-7 (CONFIRMED)

- **Introduced:** `28f6e91` 2026-07-26.
- **Where:** import (:12), `SpawnFn` widened to `IPty | Promise<IPty>` (:30), `this._spawnFn = hostSpawn` (:420-423), `Promise.resolve(spawnFn('codex', ['app-server', ...]))` (:427) with the pty wiring moved into the `.then((pty) => { this._appServerPty = pty; ... })` continuation (:438-455).
- **Mechanism (RW-7):** between `startAppServer()` entry and the `.then()` continuation, `_appServerPty` is null. `kill()` (:185-196) sets `_alive = false` and kills `_appServerPty` **if present** — during the spawn window it no-ops. The continuation then assigns a live pty to a dead adapter with **no `_alive` re-check** before `this._appServerPty = pty` (:438). Every daemon/watchdog restart landing mid-codex-spawn leaks a pty-host + codex app-server pair permanently (nothing references them afterward; no reaper exists — RW-6).
- **Upstream:** synchronous in-process spawn — `_appServerPty` is assigned before control returns, so the kill-during-spawn window is a few microseconds, not an IPC round-trip.
- **Fix (Wave 2):** in the continuation, re-check `this._alive`; if false, `pty.kill()` + `destroy?.()` instead of assigning. Plus RW-5's ready-rejection so a dead child can't wedge `waitForSocket()` upstreamly.

## Shared-with-upstream (NOT fork surface)

- The entire JSON-RPC/thread/turn-queue machinery, output buffer, `.rejectTurnCompletion` on exit (:448-451 continuation mirrors upstream :434-441), Telegram handle wiring, and the `Error:` substring reject are upstream-identical logic — only relocated inside the `.then()`.

**Verdict:** KEEP-BUT-FIX (RW-7). The pty-host routing itself is the mandated architecture; the missing `_alive` re-check is the wound.
