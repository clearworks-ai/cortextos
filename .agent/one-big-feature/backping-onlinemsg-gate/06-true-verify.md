# True-Verify — backping-onlinemsg-gate

**Run Date:** 2026-07-15  
**Verify Commands:** from `/Users/joshweiss/code/cortextos`

---

## Evidence 1: TypeScript Compilation

```bash
npm run build
```

**Output (tail):**
```
CJS dist/cli.js                                606.89 KB
CJS ⚡️ Build success in 63ms
```

**Status:** ✓ GREEN — Compiles without errors. Strict TypeScript enforced.

---

## Evidence 2: Dedup Test Suite

```bash
npx vitest run tests/unit/daemon/handoff-backping.test.ts
```

**Output:**
```
 RUN  v4.1.2 /Users/joshweiss/code/cortextos

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  20:31:06
   Duration  98ms (transform 18ms, setup 14ms, import 12ms, tests 6ms, environment 0ms)
```

**Status:** ✓ GREEN — All 9 tests pass (8 existing + 1 new).

**Test Breakdown:**
- Lines 86–111: New test `'suppresses a follow-up online-message emit after a handoff emit within the window (handoff-then-nonhandoff dedup)'` — exercises marker read/write across two restarts within suppression window, with/without newer inbound, and after window expiry.

---

## Evidence 3: Source Code Inspection

**File:** `src/daemon/agent-process.ts`

**Change 1 (buildSpawnPrompt, lines 1013–1021):**
```typescript
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
✓ Correctly gates on three conditions, writes marker exactly once on emit.

**Change 2 (buildContinuePrompt, lines 1032–1039):**
```typescript
const emitOnlineMessage = this.shouldPromptTelegramOnlineMessage()
  && !this.isHandoffBackPingSuppressed();
if (emitOnlineMessage) {
  writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now());
}
const onlineMessage = emitOnlineMessage
  ? ' After checking inbox, send a Telegram message to the user saying you are back online.'
  : '';
```
✓ Correctly gates on two conditions, writes marker exactly once on emit.

**Handoff path (lines 1003–1011):**
```typescript
const emitHandoffBackPing = isHandoffRestart
  && shouldPromptTelegram
  && this.config.runtime !== 'opencode'
  && !this.isHandoffBackPingSuppressed();
if (emitHandoffBackPing) {
  writeLastBackPingMs(this.env.ctxRoot, this.name, Date.now());
}
```
✓ Untouched. Marker write remains in place.

---

## Evidence 4: Dedup Logic Verification

**Suppression contract (from `handoff-backping.ts:26–31`):**
```typescript
export function shouldSuppressBackPing(s: BackPingState): boolean {
  if (s.lastPingMs === null) return false;
  if (s.nowMs - s.lastPingMs >= s.windowMs) return false;
  if (s.newestInboundMs !== null && s.newestInboundMs > s.lastPingMs) return false;
  return true;
}
```

**Test assertions:**
1. Marker written at `NOW` → suppressed at `NOW + 31s` within window with no newer inbound: ✓
2. Same state but with newer inbound at `NOW + 10s`: unsuppressed ✓
3. At window boundary (`NOW + W`): unsuppressed ✓

All three cases tested and passing (lines 91–110 of new test).

---

## Evidence 5: No Regressions

- **Full test suite:** 2616 passed / 3 skipped (run by codexer upstream).
- **Marker isolation:** Marker writes only when actual emit occurs (guarded by `if (emitOnlineMessage)`), preventing double-writes.
- **Path isolation:** Handoff path and spawn/continue paths cannot both emit in the same restart (mutually exclusive conditions), so marker collision is impossible.

---

## One-Line Proof

✓ Compiles + dedup test 9/9 passing + suppression window enforced on both spawn and continue paths + marker written exactly once per emit + scope and rules respected.

