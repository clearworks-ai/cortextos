# Spec 01 — Dispose PTY onData/onExit listeners on teardown (fd-leak fix)

## Josh's Exact Request (via frank2 task_1783743179462_14783854)
"Fix daemon PTY fd leak — revoked fds never closed on handoff teardown. Root cause of
2026-07-10 fleet crash: daemon leaked 479 revoked PTY fds over 2d uptime, hit per-process
fd ceiling, node-pty posix_spawnp failed on new spawn, larry/frank2/codexer could not
respawn after handoff restarts. Files: src/pty/agent-pty.ts, src/daemon/worker-process.ts,
src/daemon/agent-manager.ts. Verify: lsof daemon | grep -c revoked stays ~0 across handoffs."

## Change 1 — src/pty/agent-pty.ts
- Add two private fields to hold the disposables:
  ```ts
  private onDataDisposable: { dispose(): void } | null = null;
  private onExitDisposable: { dispose(): void } | null = null;
  ```
- In `spawn()`, capture the return values (currently discarded at lines ~163 and ~168):
  ```ts
  this.onDataDisposable = this.pty.onData((data: string) => { ... });
  this.onExitDisposable = this.pty.onExit(({ exitCode, signal }) => {
    this._alive = false;
    this.pty = null;
    this.disposeListeners();      // NEW — release fd refs on natural exit
    if (this.onExitHandler) this.onExitHandler(exitCode, signal);
  });
  ```
- Add a private helper (idempotent, null-safe):
  ```ts
  private disposeListeners(): void {
    try { this.onDataDisposable?.dispose(); } catch { /* already gone */ }
    try { this.onExitDisposable?.dispose(); } catch { /* already gone */ }
    this.onDataDisposable = null;
    this.onExitDisposable = null;
  }
  ```
- In `kill()` (line ~327): dispose listeners as part of teardown, before/after `pty.kill()`:
  ```ts
  kill(): void {
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      this.disposeListeners();   // NEW
      pty.kill();
    }
  }
  ```
  Note: onExit may fire on kill and also call disposeListeners() — the helper MUST be
  idempotent (null-guarded) so a double-dispose is safe.

## Change 2 — src/pty/codex-app-server-pty.ts
Same pattern for the app-server pty (lines ~483 onData, ~489 onExit):
- Add `_onDataDisposable` / `_onExitDisposable` fields.
- Capture both disposables when registering.
- Dispose both in the onExit handler (~489-495) AND in the kill()/teardown path (~197-210,
  where `_appServerPty.kill()` and `this._rpc.close()` run). Keep the existing
  `_appServerPty !== pty` guard. Idempotent + null-safe as above.

## Change 3 — worker-process.ts / agent-manager.ts
No direct edit expected: `WorkerProcess` uses `AgentPTY` and inherits the fix via Change 1.
Only touch these if the build/type surface requires it. Do NOT add unrelated logic.

## Constraints (hook-enforced house rules)
- No `any`, no `console.log` in committed code (existing `console.warn` at agent-pty.ts:252
  is pre-existing and out of scope — do not remove).
- Idempotent dispose — no throw on double-dispose or on a never-spawned pty.
- No change to spawn args, env, injection, or restart semantics.

## Tests (required in this diff)
Unit test with a mock `IPty` whose `onData`/`onExit` return spy disposables. Assert:
1. After `spawn()`, both disposables are held.
2. `kill()` calls `.dispose()` on both exactly once.
3. Simulated `onExit` fire calls `.dispose()` on both, and a subsequent `kill()` does NOT
   throw and does NOT double-dispose (idempotent).

## Verify
1. `npm run build` — clean.
2. `npm test` — green (incl. new test).
3. Report the diff back to Larry for adversarial review; Larry opens the PR. Josh approves merge.
