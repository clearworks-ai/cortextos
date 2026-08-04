# Spec 01 — bump timeout on the 5000-entry-cap test

## Objective
Give `tests/unit/daemon/fast-checker.test.ts`'s `'holds the 5000-entry cap, evicting oldest first'`
test a longer explicit timeout so it doesn't flake under CI I/O contention.

## Owned files (may edit)
- `tests/unit/daemon/fast-checker.test.ts` — only the one `it(...)` call for this test.

## Read-only (do not edit)
- `src/daemon/fast-checker.ts` — out of scope, do not touch.

## Steps
1. Find the test (search `5000-entry cap` or `holds the 5000-entry cap`).
2. Check which test runner this repo uses (Vitest or Jest — check imports at top of file) and add
   an explicit longer timeout as the 3rd argument to `it(...)`, e.g. `it('...', () => {...}, 30000)`.
3. Run this test file alone to confirm it passes.
4. Run `npm run build && npm test` at repo root — must stay clean.

## Validation requirements
- The test passes.
- No other test in the file changed.
- `git status` shows a single-line (or few-line) diff in one file only.
- Repo-root build + test green.

## Handoff requirements
Return: the exact diff, test run confirmation (pass), and confirmation no other file changed.
