# OBF Master Plan — Fix daemon PTY fd leak (revoked fds never closed on teardown)

**Slug:** pty-fd-leak
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature
**Class:** P0 fleet-crash root cause (task_1783743179462_14783854, filed by frank2)
**Verify cmd:** `npm run build && npm test` + live lsof check (below)

## Problem (verified live 2026-07-11 22:47Z)
Daemon (pid 17733, uptime 4h42m) already holds **35 "revoked" PTY fds** of 201 total —
~7 fds/hr. Over the 2026-07-10 crash it reached **479 revoked fds**, hit the per-process
fd ceiling, `node-pty posix_spawnp` then failed on every new spawn, and larry/frank2/codexer
could not respawn after handoff restarts. Daemon auto-restart was a band-aid, not a fix.

## Root cause (read from source, not inferred)
`node-pty`'s `onData()` / `onExit()` each return a `{ dispose(): void }` disposable that
must be disposed to release the internal read-pipe/socket reference. On macOS an undisposed
`onData` listener keeps the pty master fd referenced, so after the child exits the fd
lingers as **"revoked"** in lsof instead of being closed. Every handoff respawn creates a
fresh PTY and leaks the old one's fd.

**Two leak sites, both never capture or dispose the returned disposables:**
1. `src/pty/agent-pty.ts:163` (`this.pty.onData(...)`) and `:168` (`this.pty.onExit(...)`).
   `kill()` at `:327` and the onExit callback at `:168-174` both null `this.pty` but never
   dispose the listeners. This is the base class — `worker-process.ts` and the
   Claude/hermes/opencode PTYs that use `AgentPTY.spawn()` all inherit the leak.
2. `src/pty/codex-app-server-pty.ts:483` (`pty.onData(...)`) and `:489` (`pty.onExit(...)`)
   — same pattern on the codexer app-server path (the most restart-heavy agent). Its
   `kill()`/teardown (~`:197-210`) does not dispose either listener.

## Fix (single cohesive change — one existing repo, no schema, no new subsystem → OBF)
Capture both disposables when registering, dispose them on BOTH teardown paths (natural
onExit AND explicit kill()), and null the refs. See 03-specs/spec-01.

## Out of scope
No behavioral change to spawn args, env building, injection, or restart logic. Purely
lifecycle/fd-hygiene. Do not touch agent-manager.ts logic beyond what the leak fix needs
(it orchestrates but does not own the pty listeners).

## Lessons Consulted
- **feedback_dont_declare_fixed_from_single_clean_window** — do NOT call this fixed off one
  clean lsof read. Proof = revoked count stays ~0 across MULTIPLE handoff cycles + confirm
  merged/deployed. Build the multi-cycle lsof check into the verify.
- **feedback_fix_once_dont_narrate_recurring_bugs** — this crash has recurred (port collision
  PR#94, restart-mislabel PR#95 were adjacent band-aids); the fd leak is the underlying cause.
  Fix it durably now, don't re-patch symptoms.
- **feedback_verify_git_state_before_claiming** — verify against origin/main before "shipped".
- **background_workflow_dies_on_hard_restart** — irrelevant here (no pipeline in flight) but
  noted: the daemon restart that masked this leak is exactly the teardown path we're fixing.
- Idempotency lesson (from the double-fire risk): onExit AND kill() can both run — the dispose
  helper must be null-guarded so a double-dispose is a no-op, not a throw.

## Acceptance / verify
1. `npm run build` clean, `npm test` green.
2. Add/extend a unit test asserting `kill()` and the exit path each dispose the onData +
   onExit disposables (mock IPty returning spy disposables).
3. Live proof after deploy: cycle 5+ agent handoffs, then
   `lsof -p <daemonPid> | grep -c -i revoked` stays ~0 (was climbing ~7/hr).
