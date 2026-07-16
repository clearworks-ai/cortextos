# Spec 01 — Gate both onlineMessage emit paths behind the .last-back-ping marker

Slug: `backping-onlinemsg-gate` | Repo: `/Users/joshweiss/code/cortextos`
Target: `src/daemon/agent-process.ts` (~1013 and ~1026) + one unit test. ~5-12 lines of source.

## Context (do not re-diagnose)

Duplicate restart back-pings reach Josh's Telegram because only the handoff back-ping path
consults the `.last-back-ping` marker. The two `onlineMessage` assignments (spawn prompt and
continue prompt) are ungated: across two restarts of different type inside the 10-min
`HANDOFF_BACKPING_SUPPRESS_MS` window, restart#1 (handoff) emits the gated "back —" and
restart#2 (non-handoff spawn or `--continue`) emits the ungated "back online" — the second
never reads the marker the first wrote. Fix = make both onlineMessage paths use the SAME
marker: suppress when `isHandoffBackPingSuppressed()` is true, write the marker via
`writeLastBackPingMs` when they emit.

## Symbols you will use (all exist — do not create new ones)

- `this.isHandoffBackPingSuppressed(): boolean` — private method, `agent-process.ts:1084`.
  Wraps `shouldSuppressBackPing({ lastPingMs: readLastBackPingMs(...), nowMs: Date.now(), newestInboundMs: this.newestInboundMessageMs(), windowMs: HANDOFF_BACKPING_SUPPRESS_MS })`.
- `writeLastBackPingMs(ctxRoot: string, agent: string, nowMs: number): void` —
  `src/daemon/handoff-backping.ts:51`, already imported and called at `agent-process.ts:1008`.
  Call as `writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now())`.
- `this.shouldPromptTelegramOnlineMessage(): boolean` — private method, `agent-process.ts:1115`.
- `HANDOFF_BACKPING_SUPPRESS_MS` — `src/daemon/handoff-backping.ts:5` (10 min). Do not change.
- Test-side: `shouldSuppressBackPing`, `readLastBackPingMs`, `writeLastBackPingMs`,
  `HANDOFF_BACKPING_SUPPRESS_MS` — all exported from `src/daemon/handoff-backping.ts` and
  already imported in `tests/unit/daemon/handoff-backping.test.ts`.

## Change 1 — `buildSpawnPrompt`, `src/daemon/agent-process.ts:1013-1015`

BEFORE (current code):

```ts
const onlineMessage = isHandoffRestart || !shouldPromptTelegram
  ? ''
  : ' Send a Telegram message to the user saying you are back online.';
```

AFTER (pseudocode — exact shape up to you, semantics fixed):

```ts
const emitOnlineMessage = !isHandoffRestart
  && shouldPromptTelegram
  && !this.isHandoffBackPingSuppressed();
if (emitOnlineMessage) {
  writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now());
}
const onlineMessage = emitOnlineMessage
  ? ' Send a Telegram message to the user saying you are back online.'
  : '';
```

Semantics that MUST hold:
- When `isHandoffRestart` is true → `onlineMessage === ''` (unchanged; the handoff branch at
  1003-1011 handles that case and already writes the marker itself).
- When `!shouldPromptTelegram` → `onlineMessage === ''` (unchanged).
- NEW: when `this.isHandoffBackPingSuppressed()` is true → `onlineMessage === ''` and the
  marker is NOT rewritten.
- NEW: when the onlineMessage text IS included, `writeLastBackPingMs(this.env.ctxRoot,
  this.name, Date.now())` is called exactly once, before the prompt string is returned.
- The suppression check must run at most once per call (do not call
  `isHandoffBackPingSuppressed()` when `isHandoffRestart` is true — the handoff branch already
  invoked it at line 1006; a second call is harmless but avoid double marker writes).
- The returned template string at line 1016 keeps `${onlineMessage}` in the same position.

## Change 2 — `buildContinuePrompt`, `src/daemon/agent-process.ts:1026-1028`

BEFORE (current code):

```ts
const onlineMessage = this.shouldPromptTelegramOnlineMessage()
  ? ' After checking inbox, send a Telegram message to the user saying you are back online.'
  : '';
```

AFTER (pseudocode — same semantics as Change 1):

```ts
const emitOnlineMessage = this.shouldPromptTelegramOnlineMessage()
  && !this.isHandoffBackPingSuppressed();
if (emitOnlineMessage) {
  writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now());
}
const onlineMessage = emitOnlineMessage
  ? ' After checking inbox, send a Telegram message to the user saying you are back online.'
  : '';
```

Semantics that MUST hold:
- Telegram-disabled → `''` (unchanged).
- NEW: suppressed by the marker (within window, no newer inbound) → `''`, no marker write.
- NEW: when the text IS included → `writeLastBackPingMs(this.env.ctxRoot, this.name,
  Date.now())` called exactly once.
- The instruction text strings are byte-for-byte unchanged in both prompts.
- `this.lastSpawnWasHandoff = false;` at line 1025 stays as-is.

## Change 3 — Unit test, `tests/unit/daemon/handoff-backping.test.ts`

The emit paths live in a private prompt-builder on `AgentProcess`, so the test exercises the
marker read-write contract at the unit level (this file already tests `shouldSuppressBackPing`
with the same `ctxRoot` tmpdir + `NOW`/`W` constants — follow that pattern).

Add one test case to the existing `describe('handoff back-ping dedup', ...)` block:

Name: `'suppresses a follow-up online-message emit after a handoff emit within the window (handoff-then-nonhandoff dedup)'`

Body (assertions, using existing `ctxRoot`, `NOW`, `W`):

```ts
// restart#1: handoff back-ping emits and persists the marker (what agent-process.ts:1008
// and the newly gated onlineMessage paths both do on emit).
writeLastBackPingMs(ctxRoot, 'agent-a', NOW);

// restart#2: non-handoff spawn / --continue reload 31s later, no new inbound.
// The online-message gate reads the SAME marker → suppressed → onlineMessage === ''.
const lastPingMs = readLastBackPingMs(ctxRoot, 'agent-a');
expect(lastPingMs).toBe(NOW);
expect(shouldSuppressBackPing({
  lastPingMs,
  nowMs: NOW + 31_000,
  newestInboundMs: null,
  windowMs: W,
})).toBe(true);

// A newer inbound after the first ping lifts suppression (restart#2 may emit again).
expect(shouldSuppressBackPing({
  lastPingMs,
  nowMs: NOW + 31_000,
  newestInboundMs: NOW + 10_000,
  windowMs: W,
})).toBe(false);

// After the window elapses, the emit is allowed again.
expect(shouldSuppressBackPing({
  lastPingMs,
  nowMs: NOW + W,
  newestInboundMs: null,
  windowMs: W,
})).toBe(false);
```

All 8 existing cases in the file must pass unchanged. If you prefer a sibling daemon test
file, that is acceptable, but extending this file is the default.

## Constraints (verbatim — honor all)

- Source-only change to `src/daemon/agent-process.ts` (~1013 and ~1026) + one test. ~5-12 lines of source.
- No `any`, no `console.log`. TypeScript strict must compile (`npm run build`).
- `npm test` must pass (run the daemon/unit suites).
- Do NOT alter the handoff path (1003-1011) — it already works.
- No commit, no push — codexer returns the diff only.

## Scope-lock — what NOT to touch

- `src/daemon/agent-process.ts:1003-1011` (`emitHandoffBackPing` block + `handoffUxOverride`) — untouched.
- `src/daemon/handoff-backping.ts` — untouched (helpers reused as-is; no new exports).
- `HANDOFF_BACKPING_SUPPRESS_MS` value — unchanged (10 min).
- `isHandoffBackPingSuppressed()`, `newestInboundMessageMs()`, `shouldPromptTelegramOnlineMessage()` bodies — unchanged.
- No new modules, files (except optionally a sibling test file), config flags, env vars, or abstractions.
- Do not reintroduce the reverted `backping-human-inbound-only` human-inbound predicate.
- No changes anywhere else in the repo.

## Verify

```bash
npm run build
npm test
```

Both must be green. Return the diff only.
