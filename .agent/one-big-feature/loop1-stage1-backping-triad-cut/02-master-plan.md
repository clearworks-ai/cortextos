# Master Plan — loop1-stage1-backping-triad-cut (retroactive backfill)

Retroactive plan row for the independent-review chain of externally-built PR #285.
The PR diff is the authoritative implementation; this records the plan shape.

## Goal

Delete the fork-only handoff back-ping triad and converge the daemon restart
online/back-online ping to upstream's plain shape, WITHOUT dropping any legitimate
fork KEEP fix.

## Plan (single stage, one repo, no schema/migration — OBF-class)

1. Delete `src/daemon/handoff-backping.ts` (fork-only module; sole consumer is
   agent-process.ts).
2. `src/daemon/agent-process.ts`:
   - Strip the `handoff-backping` import.
   - Remove `isHandoffBackPingSuppressed`, `newestInboundMessageMs`,
     `writeLastBackPingMs`/`readLastBackPingMs` call-sites.
   - Simplify `handoffUxOverride` gate to
     `isHandoffRestart && systemPingsEnabled && shouldPromptTelegram`.
   - Revert startup `onlineMessage` to the upstream plain shape
     (`!isHandoffRestart && systemPingsEnabled && shouldPromptTelegram`).
   - Revert continue `onlineMessage` to `systemPingsEnabled && shouldPromptTelegram`.
   - Remove the opencode `msg2` daemon self-send in the planned-restart handleExit
     branch (agent now self-sends "back — ..." via the prompt for BOTH codex + opencode).
3. Preserve the 078a9a3 `systemPings` opt-in gate verbatim.
4. Tests: revert opencode handoff assertions to upstream shape (prompt carries the
   first-action back-ping instruction; daemon sends msg1 only); add a regression
   asserting no `.last-back-ping` marker is read or written.

## Non-goals / KEEP

Do not touch: #242 clean-exit, isPlannedRestart handleExit exemption, single-flight,
disabled-resurrection, mission-anchor/live-tail, pty-host, fast-checker. Preserve the
`emit_system_telegram_pings` gate.

## Verification

`npm run build` clean, `tsc --noEmit` clean, daemon vitest suite green modulo the
pre-existing node-pty prebuild env failure (fd-leak gate). Zero back-ping refs remain
in `src/`.
