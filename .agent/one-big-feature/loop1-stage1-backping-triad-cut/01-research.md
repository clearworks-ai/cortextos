# Research — loop1-stage1-backping-triad-cut (retroactive backfill)

Retroactive research row. PR #285 was built externally (author: Josh Weiss + Claude,
commit 2d2b4679). This document backfills the research provenance for the independent
review chain. The PR diff + tests serve as the source-of-truth specification.

## Problem

The fork carried a fork-only "handoff back-ping" dedup triad absent from upstream
(grandamenium/cortextos):

- `src/daemon/handoff-backping.ts` — marker read/write + `shouldSuppressBackPing`
  suppression logic (10-min window, keyed on newest-inbound-message vs last-ping).
- Call-sites in `src/daemon/agent-process.ts`: `isHandoffBackPingSuppressed`,
  `newestInboundMessageMs`, `writeLastBackPingMs`, and the `emitHandoffBackPing` /
  `emitOnlineMessage` branches in `buildStartupPrompt` / `buildContinuePrompt`, plus
  the opencode `msg2` self-send block in the planned-restart handleExit path.

This machinery is a *compensator*: its root cause — the restart-firing engine — is
upstream's own legitimate code and STAYS. The compensator was fork churn layered on
top. LOOP1 upstream-reconvergence removes the compensator and reverts the
online/back-online ping to upstream's plain shape.

## Confirmed upstream state (git ls-tree upstream/main)

- `src/daemon/handoff-backping.ts` is ABSENT upstream — fork-only, sole consumer was
  agent-process.ts. Verified: `git cat-file -e upstream/main:src/daemon/handoff-backping.ts` → ABSENT.
- Back-ping token count in `upstream/main:src/daemon/agent-process.ts` = 0.

## Reverted commits

- 6b7fb16d `fix(daemon): dedup handoff back-ping — suppress duplicate restart pings`
- 9ecaebc7 `fix(daemon): gate both onlineMessage back-ping paths behind the dedup marker (#108)`

## KEEP (must survive — dropping any re-creates the 08-01 HALT crisis)

078a9a3 `systemPings` opt-in gate (`emit_system_telegram_pings`); #242 clean-exit +
startup-failure guard; `isPlannedRestart` handleExit exemption; single-flight
(`inFlightStart`); disabled-agent resurrection guard; mission-anchor / live-tail;
pty-host; fast-checker (untouched by this PR).
