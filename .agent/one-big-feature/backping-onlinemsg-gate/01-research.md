# Research — backping-onlinemsg-gate

## Problem
Restart back-ping duplicates to Josh's Telegram: two "you're back" messages ~25-31s apart
on paired restarts. Prior fix (`backping-human-inbound-only`) added a human-inbound predicate
to `handoff-backping.ts` — PROVEN NO-OP (adversarial review 2026-07-16 ~01:04Z: every live
`conversation-buffer.jsonl` row is `sender=<self>` or `sender=pd88(Josh)`; no agent/daemon/queue
senders ever reach the buffer, so a human-only filter changes nothing). That diff is reverted;
preserved at `.agent/one-big-feature/backping-human-inbound-only/04-review-packet.diff`.

## Real root cause (proven by reading src/daemon/agent-process.ts this session)
There are TWO telegram back-ping emit paths in the boot prompt, and only ONE consults the
`.last-back-ping` dedup marker:

1. **Handoff path** (`emitHandoffBackPing`, agent-process.ts:1003-1011) — GATED. Checks
   `isHandoffRestart && shouldPromptTelegram && !isHandoffBackPingSuppressed()`, and writes
   the marker via `writeLastBackPingMs` at line 1008 when it emits. Correct.

2. **onlineMessage path** (agent-process.ts:1013-1015, `buildSpawnPrompt`) — UNGATED. Emits a
   "Send a Telegram message saying you are back online" instruction whenever
   `!isHandoffRestart && shouldPromptTelegram`. It NEVER consults `isHandoffBackPingSuppressed()`
   and NEVER writes the marker.

3. **onlineMessage path** (agent-process.ts:1026-1028, `buildContinuePrompt`, --continue reload)
   — ALSO UNGATED. Same defect.

## Why it dupes
The two emit paths are mutually exclusive WITHIN a single restart (handoff XOR online). But
across TWO restarts of different type inside the 10-min `HANDOFF_BACKPING_SUPPRESS_MS` window
they both fire: restart#1 (handoff) fires the marker-gated "back —"; restart#2 (non-handoff
spawn OR --continue reload, <10min later) fires the ungated onlineMessage. The second never
checks the marker written by the first, so it is not suppressed. Proven by the frank2 event
pair 2026-07-15T19:09:37 vs 19:10:08 (31s apart, different wording: "back —" vs "Back online.").

## Existing machinery to reuse (no new abstractions)
- `isHandoffBackPingSuppressed()` (agent-process.ts:1084-1091) — wraps `shouldSuppressBackPing`
  with marker read + newest-inbound.
- `writeLastBackPingMs(ctxRoot, name, Date.now())` (handoff-backping.ts:51) — writes marker.
- `shouldPromptTelegramOnlineMessage()` (agent-process.ts:1115) — telegram-enabled gate.
- `HANDOFF_BACKPING_SUPPRESS_MS` (handoff-backping.ts:5) = 10min.

## Fix shape (for plan/specs stage)
Unify BOTH onlineMessage emit paths behind the same marker the handoff path uses: suppress the
onlineMessage instruction when `isHandoffBackPingSuppressed()` is true, and write the marker when
it does emit. Covers spawn (1013) and continue (1026). Add a unit test for the
handoff-then-nonhandoff-within-window dup scenario.

## Files
- `src/daemon/agent-process.ts` (~1002-1029)
- `src/daemon/handoff-backping.ts` (helpers already exist)
- `tests/unit/daemon/handoff-backping.test.ts`

## Scope guard
Source-only, ~5-10 lines + 1 test. No schema, no new module, single repo (cortextos).
Framework = one-big-feature. Plan engine = Fable 5 HIGH (Josh-confirmed via frank2, 2026-07-16).
