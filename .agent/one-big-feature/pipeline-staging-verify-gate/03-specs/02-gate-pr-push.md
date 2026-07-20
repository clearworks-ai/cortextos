# Spec 02 — `gate-pr-push.sh`: require a fresh `staging-verify` row before PR-to-prod

**File:** `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh`
**Verify:** hook unit/regression test + manual dry-run (see Tests)

## Current behavior (lines 24-39)
On `gh pr create`: derive `BRANCH` → `SLUG` (`sed -E 's#.*/##'`), run
`pipeline-stage-emit --verify --slug "$SLUG" --through true-verify --max-age 86400`,
block on non-zero, then require non-empty `evidence_path`.

## Change
Insert a `staging-verify` gate **before** the existing true-verify block, same shape:

```bash
if printf '%s' "$CMD" | grep -qE "${CMDPOS}gh[[:space:]]+pr[[:space:]]+create"; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ -n "$BRANCH" ] || block "BLOCKED: could not determine current branch for PR gate."
  SLUG="$(printf '%s' "$BRANCH" | sed -E 's#.*/##')"
  [ -n "$SLUG" ] || block "BLOCKED: could not derive slug from branch '$BRANCH'."

  # NEW: Staging-First gate — build output must have passed staging-verify.
  STAGING_OUT="$("$PIPELINE_EMIT" --verify --slug "$SLUG" --through staging-verify --max-age 86400 2>&1)"
  if [ $? -ne 0 ]; then
    block "BLOCKED (Staging-First): no valid staging-verify provenance for '$SLUG'. Build output must run + pass its repo verify command on the target repo's Railway staging env, then emit a staging-verify row, before a PR to prod. (CLAUDE.md Staging-First Protocol, now gate-enforced.) Emit: bin/pipeline-stage-emit --stage staging-verify --slug $SLUG ... $STAGING_OUT"
  fi
  STAGING_EVIDENCE="$(printf '%s' "$STAGING_OUT" | jq -r '.evidence_path // empty' 2>/dev/null)"
  { [ -n "$STAGING_EVIDENCE" ] && [ -s "$STAGING_EVIDENCE" ]; } || block "BLOCKED (Staging-First): staging-verify row for '$SLUG' has missing/empty evidence at '$STAGING_EVIDENCE'."

  # EXISTING: true-verify block stays exactly as-is, after this.
  ...
fi
```

## Safety (match existing gate discipline)
- `set +e` preserved; fail-open only where the existing script does.
- Same `--max-age 86400`, same `evidence_path` non-empty assertion.
- No change to the direct-push-to-main block (lines 18-22).
- Exempt runs: an `exempt:true` pipeline run produces no build output to stage-verify → the gate must recognize an exempt slug (mirror however true-verify handles exempt today; if true-verify currently blocks exempt PRs it doesn't, since exempt work skips codexer — keep parity, do NOT make staging stricter than true-verify).

## Tests
- **Blocks:** `gh pr create` on a slug with a `review` row but NO `staging-verify` row → blocked with the Staging-First reason.
- **Passes:** same slug after a fresh (<24h) `staging-verify` row with non-empty evidence → not blocked by this branch (still subject to true-verify).
- **Stale:** `staging-verify` row older than `--max-age` → blocked.
- **Empty evidence:** row present but `evidence_path` missing/empty → blocked.
- **Parity:** exempt slug behaves identically under staging-verify and true-verify branches (no new block class for trivial/exempt work).

## No-gos
- Do NOT gate `git push` of a feature branch (only `gh pr create` to prod).
- Do NOT block on staging-verify for exempt runs if true-verify doesn't.
