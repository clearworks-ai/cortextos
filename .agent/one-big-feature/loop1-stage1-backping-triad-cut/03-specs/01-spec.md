# Spec 01 — loop1-stage1-backping-triad-cut (retroactive backfill)

Retroactive spec row. The authoritative spec is PR #285's diff + test changes
(commit 2d2b4679). This file restates the exact acceptance contract the review
verified against.

## Files changed (exactly 3)

- `src/daemon/handoff-backping.ts` — DELETED.
- `src/daemon/agent-process.ts` — back-ping triad removed; online/back-online
  reverted to upstream plain shape; opencode msg2 daemon self-send removed.
- `tests/unit/daemon/agent-process-opencode.test.ts` — assertions reverted to
  upstream shape + new no-marker regression.

## Acceptance criteria

1. `src/daemon/handoff-backping.ts` does not exist.
2. Zero occurrences of `back-ping|backping|BackPing|last-back-ping|
   shouldSuppressBackPing|writeLastBackPingMs|readLastBackPingMs|
   isHandoffBackPingSuppressed|newestInboundMessageMs|HANDOFF_BACKPING_SUPPRESS`
   anywhere under `src/`.
3. `handoffUxOverride` fires iff `isHandoffRestart && systemPingsEnabled &&
   shouldPromptTelegram`.
4. Startup `onlineMessage` fires iff `!isHandoffRestart && systemPingsEnabled &&
   shouldPromptTelegram`; continue `onlineMessage` iff `systemPingsEnabled &&
   shouldPromptTelegram`.
5. `emit_system_telegram_pings` gate (078a9a3) preserved; `systemPingsEnabled()`
   returns `this.config.emit_system_telegram_pings === true`.
6. Planned-restart handleExit: handoff path sends msg1 only (opencode msg2 daemon
   self-send removed); agent self-sends "back — ..." via the boot prompt for both
   codex and opencode.
7. KEEP fixes all present: #242 clean-exit + startup-failure guard, isPlannedRestart
   handleExit exemption, single-flight (inFlightStart), disabled-resurrection guard,
   mission-anchor/live-tail, pty-host, fast-checker (untouched).
8. Tests: opencode handoff test asserts prompt contains the first-action back-ping
   instruction and daemon sends msg1 only (`toHaveBeenCalledTimes(1)`); new
   regression asserts `.last-back-ping` is never read or written.

## Verification gate

`npm run build` + `tsc --noEmit` clean; daemon vitest green except the pre-existing
node-pty spawn-helper prebuild env failure (fd-leak gate), which fails identically
independent of this diff.
