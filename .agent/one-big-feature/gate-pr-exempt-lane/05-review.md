# 05 — Adversarial Review: gate-pr-exempt-lane

**VERDICT: PASS**

Reviewer: architect (Opus). Date: 2026-07-24. Reviewed on-disk state, not the ACK.
Tests: **16/16 green** (`npx vitest run tests/unit/pipeline/hook-gates.test.ts`, 3.13s).

---

## Dimension 1 — SCOPE MATCH: PASS

**Hook block vs spec 01 "New block (verbatim)":** byte-for-byte identical.
- Placement: inserted after `IS_PROD_REPO` derivation (gate-pr-push.sh:46) and BEFORE the
  staging block (now gate-pr-push.sh:82) — exactly per spec ("AFTER line 46, BEFORE line 48").
- Comment header + all logic: gate-pr-push.sh:48-80 matches spec 01 L27-59 verbatim.
- Var names all present and correct: `EXEMPT_OK` (:54), `REPO_DIR` (:58), `HEAD_BRANCH` (:60),
  `BASE_REF` (:62), `DIFF_OK` (:66), `DIFF_FILES` (:67), `CODE_FILES` (:73).
- Code-ext grep pattern: `\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sh|bash)$` at gate-pr-push.sh:73 —
  exact match, `.sh` included (this hook itself is never exempt-eligible, by design).
- Uses `--through exempt --max-age 86400` (:55); `exempt` is a valid Stage (ledger.ts:24) and
  `parseStage` accepts it via `--through` (stage-emit.ts:107). Verified end-to-end by test (a).

**Tests vs spec 02:** match.
- 2 helpers `emitExemptRow` + `commitFiles` inserted after `emitTrueVerifyRow`, before
  `beforeEach` (hook-gates.test.ts:436-460 region) — verbatim per spec 02 L20-43.
- 3 cases appended after the last existing `it` (:733-799): (a) doc-only+exempt→allow,
  (b) code+exempt→block exempt-misuse (asserts `src/patch.ts`), (c) no-exempt→still-blocks
  (asserts block + NOT exempt-misuse). Assertions match spec 02 verbatim.
- Diff is exactly **+92 additions**, zero deletions, in one file.

## Dimension 2 — FAIL-CLOSED: PASS

Every failure path falls THROUGH to the existing staging/true-verify gates; no silent allow.
- No/stale/bad-sig exempt row → `EXEMPT_OK=0` → entire lane skipped (:55, :57 guard).
- `cd_dir` set but not a dir → falls back to `$PWD` (:59).
- `head_branch` empty → `DIFF_OK` stays 0 (:68 guard requires `-n "$HEAD_BRANCH"`) → fall through.
- Neither `origin/main` nor `main` resolves → `BASE_REF` empty → `DIFF_OK` stays 0 → fall through.
- `git diff` errors → command substitution fails, `&& DIFF_OK=1` never runs → fall through (:69).
- Diff succeeds but empty → `[ -n "$DIFF_FILES" ]` fails (:72) → fall through.
- **Exempt row + ANY code file → explicit `block` (exempt-misuse) at :75 — never an allow.**
- The one allow (`exit 0` at :77) is reachable ONLY when `DIFF_OK=1 && DIFF_FILES non-empty &&
  CODE_FILES empty` — i.e. a proven doc-only diff. Correct.
- The 11 pre-existing suite cases (no `main` branch → no `BASE_REF`) stayed green, empirically
  proving the no-base fall-through does not regress true-verify/staging.

## Dimension 3 — NO REGRESSION: PASS

- `bash -n gate-pr-push.sh` → SYNTAX OK.
- git-push guard (:16-22), staging-verify block (:82-92), true-verify block (:94-102), trailing
  `exit 0` (:105) are content-unchanged — only shifted down by the inserted lane, as specced.
- No re-invocation of `$PR_TARGET_BIN` inside the exempt block (grep confirmed) — reuses the
  already-parsed `$TARGET_JSON` (:58, :60). Uses existing `block()` helper + `$PIPELINE_EMIT`.

## Dimension 4 — CODE HYGIENE: PASS

- No `any`, no `console.log` in the .ts additions (grep of `^+` lines → NONE).
- Tests reuse existing `runHook`/`runGit`/`emitLedgerRow`/`beforeEach`; no new stub seam added
  (per spec 02: real temp git repo exercises the hook's real `git diff`).

## Dimension 5 — NOTHING OUT OF SCOPE: PASS

`git diff --stat` shows only: `tests/unit/pipeline/hook-gates.test.ts` (+92) plus `state/*`
(pipeline-ledger.jsonl, pipeline-run.json — provenance bookkeeping, expected).
- **tsup.config.ts: NO change** (parent's stray-deletion revert held).
- The hook file `gate-pr-push.sh` is gitignored (`git check-ignore` confirms) — it correctly
  lives in the working tree only, consistent with the `orgs/` shared-checkout convention. Its
  absence from the diff is expected, not a missing artifact.

---

## Defects found

**None.** No blocking or non-blocking defects. Build matches both specs verbatim, is fail-closed
on every enumerated failure path, adds no out-of-scope changes, passes `bash -n`, and the full
suite is 16/16 green.

## Notes (non-defect observations)

- The lone allow path (`exit 0` at gate-pr-push.sh:77) sits inside `if [ "$EXEMPT_OK" -eq 1 ]`
  after a proven non-empty doc-only diff — it does not short-circuit the git-push guard (that
  runs on a different command shape earlier) and cannot be reached without a signed exempt row.
- `--max-age 86400` (24h) staleness window matches the sibling staging/true-verify checks —
  intentional consistency, not drift.
