# Master Plan — gate-pr-exempt-lane

## Problem (from 01-research.md, proven live 2026-07-25)
`orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh` intercepts `gh pr create` and only
walks `--through true-verify`. A signed `exempt` terminal row (stage rank 8, standalone genesis,
verifies with `--through exempt`) is never consulted, so EVERY doc-only PR is blocked with
`NO_ROWS` — confirmed on slug `comms-worker-template-fetch-filter-surface` (pure `.md` port).
PIPELINE.md L110-111/L149 explicitly sanction exempt rows for pure-doc/config changes.

## Design (hold exactly — no scope drift)
Add a **doc-exempt lane** inside the existing `gh pr create` branch of `gate-pr-push.sh`,
placed AFTER `SLUG` + `IS_PROD_REPO` derivation (current line 46) and BEFORE the prod
staging-verify block (current line 48). Logic:

1. Check for a signed exempt terminal: `"$PIPELINE_EMIT" --verify --slug "$SLUG" --through exempt --max-age 86400` (exit 0 = present).
2. If present, resolve the repo working dir: `cd_dir` from the already-parsed `TARGET_JSON` (the `cd <dir>` prefix `bin/pr-gate-target` extracts) if non-empty and a directory, else the hook `$PWD`.
3. Resolve the diff base: `origin/main` if it resolves via `git rev-parse --verify --quiet`, else `main`, else no base (fail closed).
4. Compute changed files: `git -C <repo> diff --name-only <base>...<head_branch>` using `head_branch` from `TARGET_JSON`.
5. Classify. **CODE extensions:** `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .sh .bash`. Everything else = non-code (doc/config eligible).
6. Decision table:
   - exempt row present AND every changed file is non-code AND file list non-empty → `exit 0` (ALLOW — doc-exempt lane; skips staging-verify + true-verify, which is intended: nothing runnable to verify).
   - exempt row present AND ≥1 changed file is code → `block` with an **exempt-misuse** message naming the code files: exempt lane is doc/config-only; code requires the full plan→specs→build→review→true-verify chain.
   - exempt row present BUT diff could not be computed (no base, no head_branch, git error) OR file list empty → do NOT allow via exempt; fall through to the existing true-verify path (fail-closed).
   - no exempt row → existing behavior byte-for-byte unchanged (true-verify walk; prod repos additionally staging-verify).

Note: `.sh` is CODE — a PR editing `gate-pr-push.sh` itself is NOT exempt-eligible and correctly
runs the full pipeline. The template-port PR (`.md` only) IS exempt-eligible.

## Files to change

| # | File | Change | Spec |
|---|------|--------|------|
| 1 | `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh` | Insert doc-exempt-lane block between current line 46 (`... && IS_PROD_REPO=1`) and current line 48 (`if [ "$IS_PROD_REPO" -eq 1 ]; then`). Existing `git push` block (L18-22), staging block (L48-58), true-verify block (L60-68) untouched. | `03-specs/01-gate-pr-push.md` |
| 2 | `tests/unit/pipeline/hook-gates.test.ts` | Add 2 helpers + 3 `it` cases inside the existing `describePrHook('pr push gate hook', ...)` suite (ends L707). No stub seam needed — the harness already builds a real temp git repo, so real branches/commits drive the diff. No product-code change beyond the hook. | `03-specs/02-hook-gates-test.md` |

## Non-goals
- No change to `bin/pipeline-stage-emit`, `src/pipeline/ledger.ts`, `src/pipeline/pr-target.ts`, or dispatch gates.
- No new OS/container privilege boundary.
- No new files in `03-specs/` beyond the two above.

## Acceptance criteria
- `gh pr create` on a doc-only branch WITH a signed exempt row → ALLOWED.
- `gh pr create` WITH exempt row but a code file in the diff → BLOCKED (exempt-misuse).
- `gh pr create` with NO exempt row → identical to today.
- Fail-closed on any error (git error, unresolvable branch/base, helper error, empty diff → no exempt bypass).
- `npm run build` clean, `npm test` (hook-gates) green.

## Verification
```bash
cd /Users/joshweiss/code/cortextos
npm run build
npx vitest run tests/unit/pipeline/hook-gates.test.ts
bash -n orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh
```

## Risks / notes
- The hook is a per-agent gitignored defense-in-depth artifact; the test suite already guards with `describePrHook` (`describe.skip` when absent) — CI-safe.
- Exempt lane runs before the prod staging block by design: a doc-only PR to a prod repo with a signed exempt row is allowed without staging-verify (nothing deploys/runs from docs). Misuse (code in diff) blocks before any allow.
- `--max-age 86400` matches the existing staging/true-verify freshness window.
