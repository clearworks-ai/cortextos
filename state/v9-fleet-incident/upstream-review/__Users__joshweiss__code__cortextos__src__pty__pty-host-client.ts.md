# Deep pass: src/pty/pty-host-client.ts (FORK-ONLY, 217 lines — no upstream counterpart)

Analyzed: 2026-08-02 (M1 backfill). `git show upstream/main:src/pty/pty-host-client.ts` → does not exist. Introduced `4c3fe4f` 2026-07-23, live from `28f6e91` 2026-07-26.

Purpose: daemon-side proxy for the forked pty-host child. Legitimate capability ADD — upstream's in-process node-pty is the proven ptmx-leak source; the architecture STAYS per fleet decision. The wounds are protocol gaps inside it:

## D1. `waitReady()` can await forever — RW-5 (CONFIRMED)

- **Where:** `_ready` promise (:68, :75-79) settled only by `pty-ready`/`pty-error` messages; the child `exit` handler (:81-90) marks `_exited` and fires exit listeners but **never rejects `_ready`**; bare awaits at :173-175 (`waitReady()` returns `this._ready`) and `hostSpawn` :215 (`await proxy.waitReady()`), no deadline anywhere.
- **Mechanism:** child dies pre-ready (OOM, module-load failure, posix_spawnp refusal — the confirmed overnight regime) → the spawn path wedges permanently and silently, pinning the proxy + ChildProcess. Converts "spawn failed, retry" into "spawn wedged forever".
- **Fix (Wave 2):** reject `_ready` on child exit; deadline on `waitReady()`.

## D2. `destroy()` = immediate SIGKILL of the host child — RW-4 half (CONFIRMED)

- **Where:** :167-169 (`this._child.kill('SIGKILL')`). Paired with agent-pty.ts:362's async `pty-kill` IPC, the SIGKILL races the IPC dequeue; the claude grandchild reparents un-signaled.
- **Fix (Wave 2):** graceful `pty-dispose` → await `pty-exit` (2-5s deadline) → then SIGKILL.

## D3. No PID ledger, no reaper — RW-6 (CONFIRMED, by omission)

- **Where:** `hostSpawn` (:193-217) returns only an in-memory proxy — no pidfile, no daemon-side registry of live host pids; grep for a reaper in src/ returns zero.
- **Mechanism:** any abandoned proxy (D1 wedge, restart churn, RW-2/RW-3 desync) leaves host + grandchild unfindable/unreapable — the missing containment that turns RW-3/RW-4 failures into permanent process-population growth.
- **Fix (Wave 2):** durable pty-host PID ledger + periodic reaper (kill process-group of any host not owned by a live registry entry). This is a justified ADD (upstream needs no reaper because upstream has no host children).

## Neutral notes

- Exit-listener try/catch isolation (:86-87, :116-117) and post-exit send suppression (:178-182) are correct.
- Dual exit signal (`pty-exit` IPC :112-118 vs child `exit` :81-90) is `_exited`-guarded — no double-fire.

**Verdict:** KEEP-BUT-FIX (RW-4/RW-5/RW-6 land here). No secret handling, no unbounded buffers, no per-tool-call side effects found.
