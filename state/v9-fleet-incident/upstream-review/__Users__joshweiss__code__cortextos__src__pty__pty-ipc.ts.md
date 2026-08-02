# Deep pass: src/pty/pty-ipc.ts (FORK-ONLY, 74 lines — no upstream counterpart)

Analyzed: 2026-08-02 (M1 backfill). Not in `upstream/main`. Introduced `4c3fe4f` 2026-07-23.

Purpose: typed IPC message protocol between pty-host-client.ts (daemon side) and pty-host-entry.ts (child side). Pure type definitions — no runtime logic.

## D1. The protocol has no graceful-shutdown message — RW-4 protocol gap (CONFIRMED)

- **Where:** client→host messages are exactly `pty-spawn | pty-write | pty-resize | pty-kill` (:20-50); host→client are `pty-ready | pty-data | pty-exit | pty-error` (:52-74).
- **Mechanism:** `pty-kill` only forwards a signal to the inner pty; there is no `pty-dispose`-style "tear everything down and confirm" round-trip. That absence is why agent-pty.ts `kill()` pairs the async `pty-kill` with an immediate client-side SIGKILL (`destroy()`), producing the RW-4 orphan race.
- **Fix (Wave 2):** add a `pty-dispose` client message + rely on the existing `pty-exit` as the confirmation; client escalates to SIGKILL only after a 2-5s deadline.

## Neutral notes

- Message shapes are minimal and versionless — fine for a same-repo fork/child pair (both sides always ship together).
- No ack for `pty-write` — a delivery-confirmation ack here would be the correct foundation if the #69 silent-drop protection is ever re-landed (see inject.ts doc, re-land trigger).

**Verdict:** KEEP — the file itself is inert types; its only wound is the missing dispose/ack vocabulary, fixed alongside RW-4 in Wave 2.
