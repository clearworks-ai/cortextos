# Deep pass: src/pty/agent-pty.ts (fork vs upstream/main)

Analyzed: 2026-08-02 (M1 backfill). Upstream ref = `upstream/main` @ `dfedf9b`. Divergence: **+63 / -36 lines** (`git diff upstream/main -- src/pty/agent-pty.ts`).

## D1. Spawn routed to forked pty-host instead of in-process node-pty — KEEP (fleet decision), carries RW-4

- **Introduced:** `4c3fe4f` 2026-07-23 / `28f6e91` 2026-07-26.
- **Where:** import `hostSpawn` (:8), `this.spawnFn = hostSpawn` (:74), `this.pty = await this.spawnFn!(...)` (:147); `SpawnFn` widened to `IPty | Promise<IPty>` (:29-33) to preserve the sync test seam.
- **Analysis:** replaces `require('node-pty')` in the daemon with a fork-per-PTY child so the daemon holds zero `/dev/ptmx` fds. Fixes the proven macOS ptmx master-fd leak (kern.tty.ptmx_max=511 → posix_spawnp refusal). **STAYS per standing fleet decision.** The instability it carries is in the kill path, not the spawn substitution itself.

## D2. `kill()` = disposeListeners → pty.kill() → destroy() — RW-4 + RW-10 SURFACE

- **Where:** kill() at :356-365: `disposeListeners()` (:361) **before** `pty.kill()` (:362) + `pty.destroy?.()`; onExit handler also destroy()s (:167-172).
- **Analysis (per RW-4/RW-10, codex-verified):** `pty.kill()` sends async `pty-kill` IPC while `destroy()` (pty-host-client.ts:167-169) SIGKILLs the host child immediately — SIGKILL can land before the child dequeues the IPC, so the claude grandchild is never signaled and reparents to launchd (confirmed day-scale orphans, alloc 61-65). Stripping listeners *before* kill (:361) also removes the exit listener the agent-manager auto-remove path depends on — the RW-10 worker-registry wedge.
- **Classification: ROOT-CAUSE-INSTABILITY surface** (fix inside pty-host per convergence plan Wave 2: graceful `pty-dispose` protocol, await-exit deadline, then SIGKILL).

## D3. env sourcing via shared `loadEnvFileInto` (op:// aware) — NEUTRAL + M6 edge

- **Where:** :100-108 (org secrets.env + agent .env via `loadEnvFileInto`), replacing upstream's two inline parse loops (upstream :81-112). Adds `CTX_WORKER`/`CTX_PARENT_AGENT` passthrough (:93-98).
- **Analysis:** behavior-equivalent parse consolidation, except it pulls in env.ts's op:// resolution path — first resolution per daemon process blocks synchronously (`execFileSync('op')`, env.ts:320), and op failures boot agents with literal `op://` secrets (env.ts:384-388) — the silent-401 class. Batched with the RW-8/RW-9/M6 fix wave; not an agent-pty.ts defect per se.

## D4. Listener disposables + destroy-on-exit — NEUTRAL (leak hygiene)

- **Where:** `onDataDisposable`/`onExitDisposable` (:47-48, :158-165), `disposeListeners()` (:430-444), destroy-on-exit comment+call (:167-172).
- **Analysis:** correct fd/listener hygiene for the pty-host proxy. No instability.

## D5. No fixed `--session-id` (comment block :263-267) — CONVERGED already

- Upstream-aligned session handling; the fork-only #20 fixed-session-id was reverted `7285fb0` 2026-06-25 (see agent-session-isolation.ts doc — module is dead, delete per Wave 1).

**Verdict:** file KEEPS its pty-host divergence (fleet decision); its RW-4/RW-10 kill-path race is the item to fix (Wave 2), not revert. No additional wounds found beyond what RW-4/RW-5/RW-10 already record.
