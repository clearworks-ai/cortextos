# Adversarial Code Review — comms-meeting-dedup

**Date:** 2026-07-15  
**Reviewer:** Sentinel  
**Build:** `src/utils/meeting-alert-gate.ts` + `src/cli/bus.ts` + `tests/unit/utils/meeting-alert-gate.test.ts`

---

## VERDICT: PASS

---

## Scope & Artifacts

- **Files changed:** 3 implementation files + planning/specs:
  - `src/utils/meeting-alert-gate.ts` — core utility
  - `src/cli/bus.ts` — CLI command integration (lines 3029-3057)
  - `tests/unit/utils/meeting-alert-gate.test.ts` — test suite (8 cases)
  - Imports added at `src/cli/bus.ts:42` ✓

- **No scope creep:** Only the 4 files specified in the two specs were modified. No extraneous changes. ✓

---

## Key Derivation Correctness

### `normalizeMeetingSubject(subject: string)`

**Tested:** `"Re: FWD: E-Rate for Scholarship Prep!"`

1. Lowercase + trim → `"re: fwd: e-rate for scholarship prep!"`
2. Loop-strip `^(re|fwd|fw)\s*:\s*/i` until no match:
   - Iteration 1: `"re:"` removed → `"fwd: e-rate for scholarship prep!"`, trim
   - Iteration 2: `"fwd:"` removed → `"e-rate for scholarship prep!"`, trim
   - Iteration 3: No match → break
3. Remove non-[a-z0-9] → `"erateforscholarshipprep"`
4. Slice(0, 100) → `"erateforscholarshipprep"` (30 chars)

**Result:** ✓ Exact match to spec example.

### `deriveMeetingKey(input)`

**eventId path** (`{ eventId: "abc123@google.com" }`):
- Trim + remove [^A-Za-z0-9_/+=@.<>-] → `"abc123@google.com"` (no illegal chars)
- Slice(0, 200) → `"abc123@google.com"`
- Return: `"meeting:evt-abc123@google.com"`
- Pattern validation: `meeting` (7 chars) + `:` + id (17 chars) = **valid SOURCE_KEY_PATTERN** ✓

**eventId with illegal chars** (`{ eventId: "  abc:123?@google.com  " }`):
- Trim → `"abc:123?@google.com"`
- Remove illegal chars: `:` (not in allowed class) and `?` (not in allowed class) → `"abc123@google.com"`
- Slice(0, 200) → `"abc123@google.com"`
- Return: `"meeting:evt-abc123@google.com"` (fallback collapse prevented by sanitization) ✓

**subject+date fallback** (`{ subject: "E-Rate for Scholarship Prep", date: "2026-07-16" }`):
- Normalize → `"erateforscholarshipprep"`
- Date regex `^\d{4}-\d{2}-\d{2}$` matches `"2026-07-16"` ✓
- Return: `"meeting:subj-erateforscholarshipprep-2026-07-16"`
- Pattern validation: max length = 5 + 100 + 1 + 10 = 116 chars < 512 ✓

**Edge cases:**
- `{ eventId: ":::" }` → sanitize to `` → fall through to subject+date ✓
- `{ subject: "!!!" }` → normalize to `` → null ✓
- `{ subject: "Demo", date: "7/16/2026" }` → regex fails → null ✓
- `{ subject: "Demo", date: "2026-7-16" }` → regex fails (1-digit month/day) → null ✓
- `{}` → both paths null → null ✓

**All keys satisfy SOURCE_KEY_PATTERN** (`/^[a-z0-9_-]{1,32}:[A-Za-z0-9_/+=@.<>-]{1,512}$/`): ✓

---

## Fail-Open Path

When `key === null`:
```typescript
return {
  surface: true,
  reason: 'surface: no derivable meeting key (fail-open)',
  key: null,
};
```

- Does **not** call `checkAndRecordSourceEvent` → **nothing written to ledger** ✓
- Test case 6 verifies: ledger file does not exist after fail-open call ✓
- Rationale: A duplicate ping beats a dropped meeting notice (spec:68-69) ✓

---

## TTL Semantics

```typescript
const result = checkAndRecordSourceEvent(ctxRoot, key, {
  ttlSec: opts?.ttlSec ?? DEFAULT_MEETING_TTL_SEC,
});
```

- **`fireOnce` parameter NOT passed** → defaults to `false` in `event-dedup.ts:105` ✓
- When `fireOnce = false` and `ageSec < ttlSec` → `surface: false` (within suppression window)
- When `ageSec >= ttlSec` → entry pruned → `surface: true` (re-surfaces after TTL) ✓
- **Recurring meetings** (same eventId/subject+date) will re-surface after 7 days (DEFAULT_MEETING_TTL_SEC = 604800s) ✓
- Test case 7 seeds ledger entry with `firstSeenAt = now - (ttlSec + 1)` and verifies re-surface ✓

---

## Code Quality

### No `any` types
- Grep: `grep "any" src/utils/meeting-alert-gate.ts` → no results ✓

### No `console.log` in util
- Grep: `grep "console\." src/utils/meeting-alert-gate.ts` → no results ✓
- `console.error` at `src/cli/bus.ts:3044` (TTL parse warning) — acceptable per spec ✓
- `console.log` at `src/cli/bus.ts:3053` (CLI output) — acceptable per spec ✓

### TypeScript strict compilation
- `npm run build` → success, no errors ✓

---

## CLI Command Integration

**Location:** `src/cli/bus.ts:3029-3057` (immediately before `comms-filter` command) ✓

**Command shape:**
```bash
cortextos bus meeting-alert-gate [--event-id <id>] [--subject <s>] [--date <YYYY-MM-DD>] [--ttl-sec <n>] [--json]
```

**Options:**
- `--event-id <id>` — calendar event id, preferred ✓
- `--subject <subject>` — meeting title, fallback ✓
- `--date <YYYY-MM-DD>` — meeting local date, fallback ✓
- `--ttl-sec <n>` — suppression window (default 604800), validates as positive integer ✓
- `--json` — output as JSON instead of SURFACE/SKIP ✓

**TTL validation** (mirrors `event-dedup` handler):
```typescript
const parsed = Number(opts.ttlSec);
if (Number.isInteger(parsed) && parsed > 0) {
  ttlSec = parsed;
} else {
  console.error(`Error: --ttl-sec must be a finite positive integer...`);
  // falls back to default
}
```
✓ Matches spec:3007-3015 pattern ✓

**Output contract:**
- With `--json`: exactly one line `JSON.stringify(result)` where result = `{ surface: boolean, reason: string, key: string | null }` ✓
- Without `--json`: `SURFACE` or `SKIP` ✓
- Exit code 0 in all cases (decision is in output, not exit code) ✓

**Smoke test:**
```
Call 1: --subject "E-Rate for Scholarship Prep" --date 2026-07-16 --json
  → {"surface":true,"reason":"surface: first alert for this meeting","key":"meeting:subj-erateforscholarshipprep-2026-07-16"}

Call 2: (same) --json
  → {"surface":false,"reason":"skip: meeting already alerted (0s ago)","key":"meeting:subj-erateforscholarshipprep-2026-07-16"}

Call 3: --subject "Re: E-Rate for Scholarship Prep!" --date 2026-07-16 --json
  → {"surface":false,"reason":"skip: meeting already alerted (0s ago)","key":"meeting:subj-erateforscholarshipprep-2026-07-16"}
```
✓ All three calls behave as specified ✓

---

## Test Coverage

**File:** `tests/unit/utils/meeting-alert-gate.test.ts`  
**Test count:** 8 tests, all passing  
**Test framework:** vitest  

**Real ledger testing:** Uses `mkdtempSync` per test and `rmSync` in `afterEach` — exercises the actual `checkAndRecordSourceEvent` ledger call, no mocks ✓

**Spec case groups:**

1. ✓ **first-surface=true** — `{ eventId: 'abc123@google.com' }` surfaces true, ledger has entry
2. ✓ **second-same-meeting=false** 
   - 2a: Same eventId twice → second surface false
   - 2b: Rewordings that normalize to same key collapse → calls 2 & 3 false
3. ✓ **two-distinct-meetings both=true**
   - 3a: Different eventIds → both true
   - 3b: Different subjects, same date → both true
   - 3c: Same subject, different dates → both true
4. ✓ **no-eventid fallback path** — subject+date derives key and gates correctly
5. ✓ **derivation edge table** — all edge cases (eventId sanitization, bad dates, empty subject, null input)
6. ✓ **fail-open** — `{}` → surface true, key null, ledger untouched
7. ✓ **TTL expiry re-surfaces** — seeded entry with expired timestamp → re-surfaces and refreshes timestamp

**Test execution:**
```
Test Files  1 passed (1)
Tests  8 passed (8)
```
✓ All pass ✓

---

## SKILL.md Wiring (Spec 02)

**File:** `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md`

### Step 4c (added at line 143-177)
- ✓ Inserted after line 139 ("If ANY check fails..."), before existing separator at line 141
- ✓ Contains full section heading, explanatory text, bash snippet with EVENT_ID preference and fallback
- ✓ Explains `"surface":false` → SKIP silently
- ✓ Explains `"surface":true` → send one Telegram, meeting recorded
- ✓ Trailing `---` separator maintained

**Step 5 bullet** (at line 190-192)
- ✓ "**Meeting reminders / meeting updates** → gated by Step 4c. Only a `"surface":true` result may produce a Telegram, and only ONE per meeting. On `"surface":false`, skip silently — no task, no summary, no reworded follow-up."
- ✓ Positioned after Railway/CI-failures bullet, before Action-item emails bullet

**zcal cross-reference** (at line 197)
- ✓ Updated bullet: "If you nonetheless judge a meeting notice worth surfacing (e.g. a new external meeting Josh may not have seen), it MUST pass the Step 4c meeting-alert-gate first."

---

## Evidence from true-verify.txt

**Proof file:** `.agent/one-big-feature/comms-meeting-dedup/evidence/true-verify.txt`

**Case 1: same meeting (subject+date) reworded**
```
call1: {"surface":true,"reason":"surface: first alert for this meeting","key":"meeting:subj-erateforscholarshipprep-2026-07-16"}
call2 (reworded): {"surface":false,"reason":"skip: meeting already alerted (0s ago)","key":"meeting:subj-erateforscholarshipprep-2026-07-16"}
```
✓ Exact rewordings collapse to one key, second call gated false ✓

**Case 2: distinct meeting same day**
```
call3: {"surface":true,"reason":"surface: first alert for this meeting","key":"meeting:subj-budgetreviewwithfinance-2026-07-16"}
```
✓ Different title derives different key, surfaces independently ✓

**Case 3: eventId path**
```
call4: {"surface":true,"reason":"surface: first alert for this meeting","key":"meeting:evt-abc123@google.com"}
call5: {"surface":false,"reason":"skip: meeting already alerted (0s ago)","key":"meeting:evt-abc123@google.com"}
```
✓ EventId path works, repeat gated false ✓

**Case 4: fail-open (no key)**
```
call6: {"surface":true,"reason":"surface: no derivable meeting key (fail-open)","key":null}
```
✓ Empty input fails open, key is null ✓

---

## Summary

- **Scope:** Exact match to two specs; no creep.
- **Key derivation:** Deterministic normalization, correct precedence (eventId → subject+date → null), all keys valid per SOURCE_KEY_PATTERN.
- **Fail-open:** Correct — surfaces with null key, no ledger write.
- **TTL semantics:** No `fireOnce`, recurring meetings re-surface after 7 days.
- **Code quality:** No `any`, no `console.log` in util, strict TS compilation.
- **CLI integration:** Correct insertion location, all options present, output contract matched, smoke test confirmed.
- **Tests:** 8 cases covering spec groups 1-7, real ledger, all passing.
- **SKILL.md wiring:** Step 4c verbatim with bash snippet, Step 5 bullet added, zcal cross-reference appended.
- **Evidence:** true-verify.txt confirms all 4 key cases and output format.

---

## Findings

**None.** Implementation matches specs exactly. All acceptance criteria met.
