# Review — backping-onlinemsg-gate

**Verdict: PASS**

---

## Scope Match

✓ **Spec coverage 100%:**
- Change 1 (buildSpawnPrompt ~1013–1015): IMPLEMENTED — `emitOnlineMessage` boolean computed from `!isHandoffRestart && shouldPromptTelegram && !this.isHandoffBackPingSuppressed()`, marker written on emit, `onlineMessage` assignment refactored as specified.
- Change 2 (buildContinuePrompt ~1026–1028): IMPLEMENTED — `emitOnlineMessage` computed from `this.shouldPromptTelegramOnlineMessage() && !this.isHandoffBackPingSuppressed()`, marker written on emit, instruction text unchanged.
- Change 3 (unit test): IMPLEMENTED — new test case added to `handoff-backping.test.ts` at lines 86–111, named exactly as spec, covering handoff-then-nonhandoff dedup with three suppression assertions (within window no inbound, within window with newer inbound, after window elapses).
- Scope lock: Handoff path (1003–1011) untouched ✓. `handoff-backping.ts` untouched ✓. `HANDOFF_BACKPING_SUPPRESS_MS` untouched ✓. No new modules/exports/env vars ✓.

---

## Correctness Analysis

### Logic Equivalence (buildSpawnPrompt)

**Old logic:**
```
onlineMessage = (isHandoffRestart || !shouldPromptTelegram) ? '' : 'text'
```
Expands to: `onlineMessage = (!isHandoffRestart && shouldPromptTelegram) ? 'text' : ''`

**New logic:**
```
emitOnlineMessage = !isHandoffRestart && shouldPromptTelegram && !this.isHandoffBackPingSuppressed()
onlineMessage = emitOnlineMessage ? 'text' : ''
```

**Equivalence proof:**
- When `isHandoffRestart === true`: OLD yields `''`; NEW sets `emitOnlineMessage = false` (first clause fails), yields `''`. ✓
- When `shouldPromptTelegram === false`: OLD yields `''`; NEW sets `emitOnlineMessage = false` (second clause fails), yields `''`. ✓
- When `this.isHandoffBackPingSuppressed() === true` (NEW case): NEW sets `emitOnlineMessage = false` (third clause fails), yields `''`, does NOT call `writeLastBackPingMs()`. ✓
- When all three are true: NEW sets `emitOnlineMessage = true`, calls `writeLastBackPingMs()` exactly once, then yields `'text'`. ✓

**Critical detail:** The old code never checked suppression; marker write happens only when `emitOnlineMessage === true`, preventing double-writes.

### Logic Equivalence (buildContinuePrompt)

**Old logic:**
```
onlineMessage = this.shouldPromptTelegramOnlineMessage() ? 'text' : ''
```

**New logic:**
```
emitOnlineMessage = this.shouldPromptTelegramOnlineMessage() && !this.isHandoffBackPingSuppressed()
onlineMessage = emitOnlineMessage ? 'text' : ''
```

**Equivalence:**
- When `shouldPromptTelegramOnlineMessage() === false`: OLD yields `''`; NEW sets `emitOnlineMessage = false`, yields `''`. ✓
- When `this.isHandoffBackPingSuppressed() === true`: NEW sets `emitOnlineMessage = false`, yields `''`, no marker write. ✓
- When both true: NEW sets `emitOnlineMessage = true`, calls `writeLastBackPingMs()` once, yields `'text'`. ✓

### Semantic Coverage

1. **Handoff path isolation:** The handoff path (1003–1011) remains unchanged, still reads `isHandoffBackPingSuppressed()` and writes the marker on `emitHandoffBackPing`. The new spawn-path logic **does NOT run when `isHandoffRestart === true`** (first guard fails), so no double-read or double-write. ✓

2. **Dedup contract preserved:**
   - Marker is written exactly once per actual emit (either handoff path or spawn/continue path, never both in the same restart).
   - `shouldSuppressBackPing()` checks: no prior ping → allow; window elapsed → allow; within window + newer inbound → allow; within window + no newer inbound → suppress. ✓
   - Test case confirms: write marker at `NOW`, suppress at `NOW + 31s` (within 10-min window, no newer inbound), unsuppress at `NOW + 31s` if newer inbound present, unsuppress at `NOW + W` (window boundary). ✓

3. **Instruction text invariant:** Byte-for-byte identical in both paths (no trailing space added/removed). ✓

---

## Rules Compliance

- **No `any` types:** PASS. All types are explicit (`boolean`, `string`), inference is sound.
- **No `console.log`:** PASS. No logging added.
- **TypeScript strict:** PASS. `npm run build` succeeds, no errors.
- **Test suite:** PASS. `npx vitest run tests/unit/daemon/handoff-backping.test.ts` reports 9/9 tests passing (8 existing + 1 new).
- **Imports & symbols:** `writeLastBackPingMs` already imported from `handoff-backping.ts` at top of file (used at line 1008), reused at lines 1017 and 1035. `isHandoffBackPingSuppressed()` is a private method on `AgentProcess`, correctly called via `this.isHandoffBackPingSuppressed()`. ✓

---

## Regression Risk Assessment

**Low:**

1. **Legitimate online pings suppressed?** No. The suppression window (10 min) and inbound-reset logic preserve the dedup contract: if a newer message arrives after the first ping, suppression is lifted. Legitimate new agent startups after 10 min are allowed.

2. **Marker double-writes?** No. Marker is written (a) in the handoff path when `emitHandoffBackPing === true`, or (b) in the spawn path when `emitOnlineMessage === true`, or (c) in the continue path when `emitOnlineMessage === true`. The three conditions are mutually exclusive in a single restart (handoff is a different code branch, and only one of spawn/continue runs per invocation).

3. **Missing dedup on edge case?** Test case covers: handoff emit at `NOW`, spawn/continue attempt at `NOW + 31s` (within window, no inbound) → suppressed ✓. Same attempt with newer inbound at `NOW + 10s` → allowed ✓. After window elapses → allowed ✓.

---

## Deliverables Checklist

- [x] buildSpawnPrompt gating applied correctly
- [x] buildContinuePrompt gating applied correctly
- [x] Marker write on actual emit (not on suppression)
- [x] Unit test added, semantics correct
- [x] Build compiles (npm run build ✓)
- [x] Test suite passes (9/9 ✓)
- [x] No `any`, no `console.log`, strict TS ✓
- [x] Handoff path untouched ✓
- [x] Scope lock respected ✓
