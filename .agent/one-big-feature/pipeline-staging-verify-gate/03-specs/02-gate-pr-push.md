# Spec 02 — `gate-pr-push.sh`: require a fresh `staging-verify` row before a PR to a prod repo (P3)

**File:** `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh`
**Verify:** hook regression test (bats-style or a node harness invoking the hook) + `npm run build && npm test`

## Current behavior (lines 24-39, verified 2026-07-20)
On `gh pr create`: derive `BRANCH` (`git rev-parse --abbrev-ref HEAD`) → `SLUG` (`sed -E 's#.*/##'`), run
`"$PIPELINE_EMIT" --verify --slug "$SLUG" --through true-verify --max-age 86400`,
`block` on non-zero exit, then require non-empty + non-empty-file `evidence_path` (lines 36-38).
`block()` (lines 11-14) prints `{"decision":"block","reason":...}` and `exit 0`. `set +e` (line 2) → fail-open.

## Change — insert a staging-verify branch BEFORE the true-verify block (after line 28)
Gated on the git-origin prod-repo match (master-plan decision #3), so cortextos-internal and non-prod PRs are unaffected:

```bash
  # NEW: Staging-First gate — only for PRs into a prod repo.
  ORIGIN="$(git remote get-url origin 2>/dev/null)"
  IS_PROD_REPO=0
  case "$ORIGIN" in
    *clearpath* | *lifecycle-killer* | *cxportal* | *nonprofit-hub* | *auditos* | *gws-security*)
      IS_PROD_REPO=1 ;;
  esac

  if [ "$IS_PROD_REPO" -eq 1 ]; then
    STAGING_OUT="$("$PIPELINE_EMIT" --verify --slug "$SLUG" --through staging-verify --max-age 86400 2>&1)"
    STAGING_CODE=$?
    if [ "$STAGING_CODE" -ne 0 ]; then
      block "BLOCKED (Staging-First): no valid staging-verify provenance for '$SLUG' targeting a prod repo. Per CLAUDE.md's Staging-First Protocol (now gate-enforced), the build output must be deployed to the target repo's Railway staging env, pass that repo's real verify command, and be recorded as a signed staging-verify row before a PR to prod. Run the staging runbook (larry/PIPELINE-STAGING.md) then emit: bin/pipeline-stage-emit --slug $SLUG --stage staging-verify --artifact <build-output> --evidence <staging-run-evidence> --runner larry. Detail: $STAGING_OUT"
    fi
    STAGING_EVIDENCE="$(printf '%s' "$STAGING_OUT" | jq -r '.evidence_path // empty' 2>/dev/null)"
    [ -n "$STAGING_EVIDENCE" ] || block "BLOCKED (Staging-First): staging-verify row for '$SLUG' is missing evidence_path."
    [ -s "$STAGING_EVIDENCE" ] || block "BLOCKED (Staging-First): staging-verify evidence for '$SLUG' is missing or empty at $STAGING_EVIDENCE."
  fi

  # EXISTING true-verify block (lines 30-38) stays exactly as-is, AFTER this.
```

## Target-repo derivation (decision #3, reuse)
- `SLUG` derivation reuses the existing `BRANCH → sed 's#.*/##'` logic already computed at lines 25-28. Do not recompute.
- `git remote get-url origin` is evaluated in the PR's cwd (where `gh pr create` runs). The prod-repo `case` set = larry's owned repos: clearpath, lifecycle-killer/cxportal, nonprofit-hub, auditos, gws-security. cortextos origin does NOT match → staging-verify skipped, true-verify still enforced as today.
- `"$PIPELINE_EMIT"` and the ledger it reads are always cortextos's (ROOT at line 8 is relative to the hook file, independent of cwd), so staging-verify rows are keyed by slug in the cortextos ledger regardless of which prod-repo checkout opens the PR.

## Safety (match existing gate discipline)
- `set +e` preserved; `block` exits 0 (fail-open shape). If `git remote get-url origin` fails, `ORIGIN` is empty → `IS_PROD_REPO=0` → branch skipped (fail-open).
- If `jq` parse of `STAGING_OUT` fails, `STAGING_EVIDENCE` is empty → the `[ -n ]` block fires (fail-CLOSED on a present-but-unparseable verify success is acceptable here because a 0-exit verify always emits valid JSON; a parse failure means the row is malformed). This mirrors the existing true-verify block exactly (lines 36-37).
- Same `--max-age 86400`, same `evidence_path` non-empty + non-empty-file assertions as true-verify.
- No change to the direct-push-to-main block (lines 18-22) or the true-verify block (lines 30-38).

## Tests (regression — mirror the gate-verification pattern; drive the hook with a synthesized payload on stdin)
Harness: pipe `{"tool_input":{"command":"gh pr create ..."}}` to the hook with a temp git repo whose `origin` and current branch are controlled, a temp cortextos ledger, and a stub/`PATH`-shimmed `pipeline-stage-emit`. Assert stdout `.decision`.
1. **Blocks (prod origin, no staging row):** origin = a clearpath URL, branch `feature/foo`, ledger has a `review` + `true-verify` row for `foo` but NO `staging-verify` → hook emits `decision:"block"` with the Staging-First reason.
2. **Passes (prod origin, fresh staging row):** same, plus a fresh (<24h) `staging-verify` row with non-empty evidence file → not blocked by the staging branch (proceeds to the true-verify block).
3. **Stale:** `staging-verify` row older than `--max-age 86400` → blocked (verify exits non-zero with STALE).
4. **Empty evidence:** `staging-verify` row present but `evidence_path` points at a missing/empty file → blocked.
5. **cortextos origin unaffected:** origin = cortextos URL → staging branch skipped; only the (existing) true-verify behavior applies. Proves this build's own PR is not trapped.
6. **Non-prod / no origin:** `git remote get-url origin` empty → `IS_PROD_REPO=0`, skipped.

## No-gos
- Do NOT gate `git push` of a feature branch (only `gh pr create`).
- Do NOT require staging-verify for cortextos-internal or non-prod-repo PRs (git-origin gate is the guard).
- Do NOT alter the existing true-verify or direct-push-to-main blocks.
