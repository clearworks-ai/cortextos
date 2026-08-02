# Deep pass: src/pty/pty-host-entry.ts (FORK-ONLY, 114 lines — no upstream counterpart)

Analyzed: 2026-08-02 (M1 backfill). Not in `upstream/main`. Introduced `4c3fe4f` 2026-07-23.

Purpose: the forked child that actually `require`s node-pty and owns the single PTY; exits when the pty exits so the kernel reclaims the ptmx fd. Part of the pty-host architecture that STAYS.

## D1. No self-exit fallback / no SIGTERM handling — RW-4 child half (CONFIRMED)

- **Where:** `pty-kill` handler (:91-97) forwards the signal to the inner node-pty (`pty.kill(msg.signal)`) but arms **no** "exit anyway" timer; there is no `process.on('SIGTERM')` handler at all; the only exit paths are pty exit (:64-71, `process.exit(0)` after a 50ms IPC flush), spawn error (:76), and parent `disconnect` (:108).
- **Mechanism:** if the inner claude ignores the forwarded signal, or the parent SIGKILLs the host before the IPC dequeues (the RW-4 race), the pty-host/claude pair persists. `disconnect` covers clean parent-channel closure, but a SIGKILLed parent's channel close → child exits while its **claude child does not get killed here** — nothing in this file kills the node-pty child on teardown paths other than signal forwarding.
- **Fix (Wave 2):** SIGTERM handler that kills the node-pty child; after sending `pty-exit`, arm `setTimeout(() => process.exit(0), 5000).unref()`; exit(1) if no `pty-spawn` arrives within ~15s (RW-5 companion).

## D2. No spawn deadline — RW-5 child half

- **Where:** the process waits indefinitely for a `pty-spawn` message (:105 `process.on('message', handleMessage)`); a client that wedges pre-spawn leaves an idle orphan host forever.

## Neutral notes

- `exited` guard (:42, :65-66) prevents double `pty-exit`.
- Post-exit write/resize are try/catch-swallowed (:82, :87) — correct.
- 50ms flush-then-exit (:69-71) is a benign race (message could in theory be lost, but the client's own `child.on('exit')` covers it).

**Verdict:** KEEP-BUT-FIX — this file is where the RW-4/RW-5 child-side fixes land. No other divergence class present (no secrets, no timers besides exit flush, no growth).
