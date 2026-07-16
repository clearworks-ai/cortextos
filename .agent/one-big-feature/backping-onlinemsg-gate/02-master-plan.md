# Master Plan — backping-onlinemsg-gate

Slug: `backping-onlinemsg-gate` | Framework: one-big-feature | Repo: `/Users/joshweiss/code/cortextos`
Plan engine: Fable 5 HIGH (Josh-confirmed via frank2, 2026-07-16)

## Objective

Kill the duplicate restart back-ping on Josh's Telegram (two "you're back" messages ~25-31s
apart on paired restarts) by gating BOTH ungated `onlineMessage` emit paths in
`src/daemon/agent-process.ts` behind the same `.last-back-ping` marker the handoff path
already uses. Reuse existing helpers only — no new modules, no new abstractions.

## Root cause (proven — see 01-research.md)

There are two telegram back-ping emit paths in the boot prompt, and only one consults the
`.last-back-ping` dedup marker. The handoff path (`emitHandoffBackPing`,
agent-process.ts:1003-1011) checks `isHandoffBackPingSuppressed()` and writes the marker via
`writeLastBackPingMs` when it emits — correct. The `onlineMessage` assignments in
`buildSpawnPrompt` (line 1013) and `buildContinuePrompt` (line 1026) never consult the marker
and never write it. Within a single restart the two paths are mutually exclusive (handoff XOR
online), but across two restarts of different type inside the 10-min
`HANDOFF_BACKPING_SUPPRESS_MS` window both fire: restart#1 (handoff) emits the marker-gated
"back —"; restart#2 (non-handoff spawn or `--continue` reload, <10min later, no new inbound)
emits the ungated onlineMessage — it never checks the marker written by the first, so it is
not suppressed. Proven by the frank2 event pair 2026-07-15T19:09:37 vs 19:10:08. The prior
fix attempt (`backping-human-inbound-only`, a human-inbound predicate in
`handoff-backping.ts`) was a proven no-op and is reverted.

## Exact change per line target

| # | File:line | Change |
|---|-----------|--------|
| 1 | `src/daemon/agent-process.ts:1013-1015` (`buildSpawnPrompt`) | `onlineMessage` currently `isHandoffRestart \|\| !shouldPromptTelegram ? '' : <text>`. ALSO suppress when `this.isHandoffBackPingSuppressed()` is true; when it DOES emit, call `writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now())` before returning the prompt. |
| 2 | `src/daemon/agent-process.ts:1026-1028` (`buildContinuePrompt`) | `onlineMessage` currently gated only by `this.shouldPromptTelegramOnlineMessage()`. Same treatment: suppress when `this.isHandoffBackPingSuppressed()`; write the marker via `writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now())` when it emits. |
| 3 | `tests/unit/daemon/handoff-backping.test.ts` | Add one unit test proving the handoff-then-nonhandoff-within-window scenario at the marker read-write contract level (the emit paths live in a private prompt-builder): a marker written by a prior emit suppresses a subsequent online-message emit given no newer inbound. |

Existing helpers to reuse (only these — all already imported/available in `agent-process.ts`):
- `isHandoffBackPingSuppressed()` (agent-process.ts:1084)
- `writeLastBackPingMs(ctxRoot, agent, nowMs)` (handoff-backping.ts:51)
- `shouldPromptTelegramOnlineMessage()` (agent-process.ts:1115)
- `HANDOFF_BACKPING_SUPPRESS_MS` (handoff-backping.ts:5)

## Files touched

1. `src/daemon/agent-process.ts` — ~5-12 lines of source, at ~1013 and ~1026 only.
2. `tests/unit/daemon/handoff-backping.test.ts` — one new test case.

Nothing else. `src/daemon/handoff-backping.ts` is NOT modified (helpers already exist).

## Test plan

- New unit test in `tests/unit/daemon/handoff-backping.test.ts`:
  `handoff-then-nonhandoff-within-window` — first restart (handoff emit) writes the marker
  via `writeLastBackPingMs`; a second restart within `HANDOFF_BACKPING_SUPPRESS_MS` with no
  new inbound is suppressed (`shouldSuppressBackPing(...) === true` given
  `lastPingMs = readLastBackPingMs(...)` from the marker the first emit wrote), which means
  `onlineMessage === ''` under the new gating. After the window elapses (or a newer inbound
  arrives), suppression lifts.
- Existing tests in the file (8 cases) must continue to pass unchanged.
- Full daemon/unit suites via `npm test`.

## Verify commands

```bash
npm run build   # TypeScript strict must compile cleanly
npm test        # all tests pass, including the new case
```

## Acceptance criteria

1. `buildSpawnPrompt` onlineMessage is `''` when `isHandoffBackPingSuppressed()` is true, even
   when `!isHandoffRestart && shouldPromptTelegram`.
2. `buildSpawnPrompt` writes the `.last-back-ping` marker (`writeLastBackPingMs`) whenever the
   onlineMessage instruction IS included.
3. `buildContinuePrompt` onlineMessage is `''` when `isHandoffBackPingSuppressed()` is true.
4. `buildContinuePrompt` writes the marker whenever the onlineMessage IS included.
5. Handoff path (lines 1003-1011) byte-for-byte untouched.
6. New unit test covers handoff-then-nonhandoff-within-window: marker written by prior emit
   suppresses the subsequent online-message emit when no newer inbound exists.
7. `npm run build` clean; `npm test` green. No `any`, no `console.log`.
8. Codexer returns the diff only — no commit, no push.

## Out of scope

- The handoff back-ping path (`emitHandoffBackPing`, agent-process.ts:1003-1011) — already
  correct, do NOT alter.
- `src/daemon/handoff-backping.ts` — no changes; helpers reused as-is.
- Any new module, config flag, env var, or abstraction.
- The reverted `backping-human-inbound-only` predicate — do not reintroduce.
- Telegram dedup layers elsewhere (PR #33 byte-hash, PR #46 source-event) — unrelated.
- Any change to `HANDOFF_BACKPING_SUPPRESS_MS` (stays 10 min).
- Refactoring `buildSpawnPrompt` / `buildContinuePrompt` beyond the minimal gating lines.
