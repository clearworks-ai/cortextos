# Review — fast-checker 5000-entry-cap test timeout fix

## What was checked
1. `git -C /private/tmp/fc-timeout diff origin/main -- tests/unit/daemon/fast-checker.test.ts`
   — confirmed the change is a single-line diff, adding `30000` as the 3rd argument to the
   `it('holds the 5000-entry cap, evicting oldest first', ...)` call.
2. `git -C /private/tmp/fc-timeout diff origin/main -- src/daemon/fast-checker.ts`
   — confirmed empty; application code is untouched.
3. `cd /private/tmp/fc-timeout && npx vitest run tests/unit/daemon/fast-checker.test.ts`
   — confirmed all tests in the file pass.

## Exact diff (tests/unit/daemon/fast-checker.test.ts)
```diff
diff --git a/tests/unit/daemon/fast-checker.test.ts b/tests/unit/daemon/fast-checker.test.ts
index 84455b49..a5f9d9cd 100644
--- a/tests/unit/daemon/fast-checker.test.ts
+++ b/tests/unit/daemon/fast-checker.test.ts
@@ -1056,7 +1056,7 @@ describe('FastChecker', () => {
       // The very first message's hash was evicted; a recent one survives.
       expect(checker.isDuplicate('msg-0')).toBe(false); // evicted → not a dup
       expect(checker.isDuplicate('msg-5099')).toBe(true); // still in window
-    });
+    }, 30000);
   });
 });
```

## App code diff (src/daemon/fast-checker.ts)
Empty — no changes. Confirmed out-of-scope file was not touched.

## Test result
```
 Test Files  1 passed (1)
      Tests  63 passed (63)
   Start at  00:00:17
   Duration  12.84s (transform 337ms, setup 16ms, import 377ms, tests 12.33s, environment 0ms)
```
All 63 tests in `tests/unit/daemon/fast-checker.test.ts` passed, including the previously
flaky `'holds the 5000-entry cap, evicting oldest first'` test.

## Verdict: PASS

- Change is exactly the single-line timeout bump described in the master plan / spec01 — no
  scope creep, no other test lines altered.
- Application source (`src/daemon/fast-checker.ts`) is untouched.
- Full test file is green, 63/63 passing.
