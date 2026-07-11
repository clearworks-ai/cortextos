# OBF Master Plan — handoff-backping-dedup

**Task:** task_1783788589126_93120862 (frank2, high)
**Repo:** ~/code/cortextos (single repo, single file, no schema → OBF, not M2C1)
**Owner:** larry (plan) → codexer (build) → larry (review) → Josh (merge)
**Date:** 2026-07-11

## Problem

`src/daemon/agent-process.ts` fires an unconditional "back — ..." Telegram
back-ping on every context-handoff restart. When handoff restarts chain fast
(context churn near 80%, one interrupted mid-write), Josh gets duplicate
back-messages. There is no suppression window. Caught 2026-07-11.

Two emit sites:
1. `buildStartupPrompt()` L967-968 `handoffUxOverride` — prompt instruction the
   agent self-executes (claude + codex runtimes). This is the site Josh hit
   (frank2 is a claude agent).
2. `maybeSendRuntimeLifecycleNotification()` L1150-1155 msg2 — daemon-sent
   back-online ping for opencode runtime only.

## Key constraint (why in-memory won't work)

Each handoff restart is a **separate OS process**. The existing
`lastSpawnWasHandoff` in-memory flag resets to its constructor default on every
restart, so it cannot dedup across restarts. The dedup state MUST be persisted
to disk — a per-agent marker file that survives process death.

## Design

Persisted marker: `<ctxRoot>/state/<agent>/.last-back-ping` containing the epoch
ms of the last emitted back-ping.

Suppression rule (window = 10 min):
- No marker / unreadable → NOT suppressed (first ping, always allow).
- `now - lastPingMs >= 10min` → NOT suppressed (window elapsed).
- Within window: read newest INBOUND message ts from the live buffer
  (`loadBuffer`, entries where `sender !== agentName`). If
  `newestInboundMs > lastPingMs` → NOT suppressed (materially-new message to
  respond to — the whole point of the back-ping). Else → SUPPRESSED.

When a back-ping IS emitted, write the marker with `now` (best-effort, try/catch,
never throw into boot path).

### Testability seam

Extract the pure decision into an exported function so it unit-tests without the
daemon/class IO:

```ts
// src/daemon/handoff-backping.ts
export interface BackPingState {
  lastPingMs: number | null;
  nowMs: number;
  newestInboundMs: number | null;
  windowMs: number;
}
export function shouldSuppressBackPing(s: BackPingState): boolean
```

The class wires IO (marker read/write, `loadBuffer` newest-inbound) to this pure
fn from both emit sites.

## Files touched

- `src/daemon/handoff-backping.ts` (NEW — pure decision fn + marker read/write helpers)
- `src/daemon/agent-process.ts` (wire suppression into both emit sites)
- `tests/daemon/handoff-backping.test.ts` (NEW — unit tests for the pure fn)

## Acceptance

1. `npm run build` clean (strict TS).
2. `npm test` green incl. new tests.
3. Unit tests cover: no-marker→allow, window-elapsed→allow,
   within-window-no-new-msg→suppress, within-window-new-inbound→allow,
   unreadable-marker→allow.
4. No `any`, no `console.log`. Marker IO best-effort (try/catch, non-fatal).
5. Both emit sites (prompt handoffUxOverride + opencode daemon msg2) share the
   suppression path and write the same marker.

## Lessons Consulted

- `feedback_no_dedup_on_handoff_back_messages` — this exact bug; no suppression
  window in agent-process.ts. Root of this task.
- `feedback_fix_once_dont_narrate_recurring_bugs` — durable fix, not a re-catch;
  persisted marker so it holds across the restart chain that caused it.
- `feedback_shared_checkout_tracked_file_edits_clobbered` — codexer edits the
  tracked `src/` files (hook-enforced ownership); larry only writes the plan.
- Telegram-dedup prior art: `.agent/one-big-feature/telegram-dedup/` — byte-identical
  send dedup at the transport layer; this is complementary (suppresses the
  *instruction to send* at the boot layer, before content differs).
