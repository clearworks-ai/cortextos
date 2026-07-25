# Spec 01 — Doc-exempt lane in gate-pr-push.sh

**Target file:** `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh` (72 lines today)

## Insertion point (exact anchors)

Current lines 42-48:

```
42	  SLUG="$(printf '%s' "$TARGET_JSON" | jq -r '.slug // empty' 2>/dev/null)"
43	  [ -n "$SLUG" ] || block "BLOCKED: could not derive a provenance slug for this gh pr create (no --head flag and no resolvable branch)."
44
45	  IS_PROD_REPO=0
46	  [ "$(printf '%s' "$TARGET_JSON" | jq -r '.is_prod_repo // false' 2>/dev/null)" = "true" ] && IS_PROD_REPO=1
47
48	  if [ "$IS_PROD_REPO" -eq 1 ]; then
```

**Insert the new block AFTER line 46 and BEFORE line 48** (i.e. replace the single blank
line 47 with: blank line, new block, blank line). Nothing else in the file changes:
the `git push` guard (L18-22), the staging-verify block (L48-58), and the true-verify
block (L60-68) stay byte-for-byte identical, as does the trailing `exit 0` (L71).

## New block (verbatim)

```bash
  # ── Doc-exempt lane ────────────────────────────────────────────────────
  # A signed exempt terminal row (PIPELINE.md L110/L149: pure doc/config
  # changes only) allows this PR ONLY when the branch diff vs the repo
  # default branch touches zero code files. Fail-closed: any git error,
  # unresolvable base/head, or empty diff falls through to the existing
  # true-verify (and prod staging-verify) requirement below unchanged.
  EXEMPT_OK=0
  "$PIPELINE_EMIT" --verify --slug "$SLUG" --through exempt --max-age 86400 >/dev/null 2>&1 && EXEMPT_OK=1

  if [ "$EXEMPT_OK" -eq 1 ]; then
    REPO_DIR="$(printf '%s' "$TARGET_JSON" | jq -r '.cd_dir // empty' 2>/dev/null)"
    { [ -n "$REPO_DIR" ] && [ -d "$REPO_DIR" ]; } || REPO_DIR="$PWD"
    HEAD_BRANCH="$(printf '%s' "$TARGET_JSON" | jq -r '.head_branch // empty' 2>/dev/null)"

    BASE_REF=""
    git -C "$REPO_DIR" rev-parse --verify --quiet origin/main >/dev/null 2>&1 && BASE_REF="origin/main"
    [ -z "$BASE_REF" ] && git -C "$REPO_DIR" rev-parse --verify --quiet main >/dev/null 2>&1 && BASE_REF="main"

    DIFF_OK=0
    DIFF_FILES=""
    if [ -n "$BASE_REF" ] && [ -n "$HEAD_BRANCH" ]; then
      DIFF_FILES="$(git -C "$REPO_DIR" diff --name-only "$BASE_REF...$HEAD_BRANCH" 2>/dev/null)" && DIFF_OK=1
    fi

    if [ "$DIFF_OK" -eq 1 ] && [ -n "$DIFF_FILES" ]; then
      CODE_FILES="$(printf '%s\n' "$DIFF_FILES" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sh|bash)$')"
      if [ -n "$CODE_FILES" ]; then
        block "BLOCKED (exempt-misuse): a signed exempt row exists for '$SLUG' but the PR branch diff touches code files: $(printf '%s' "$CODE_FILES" | tr '\n' ' '). The exempt lane is doc/config-only; code changes require the full plan->specs->build->review->true-verify chain. Remove the code files from this branch or run the full pipeline for '$SLUG'."
      fi
      exit 0
    fi
    # Diff unavailable or empty: no exempt bypass — fall through to true-verify.
  fi
```

## Conventions honored (must hold in the built diff)
- Uses the existing `block()` helper (L11-14) — prints `{"decision":"block","reason":...}` and `exit 0`. No new output shapes.
- Uses `$PIPELINE_EMIT` (L9) and the already-parsed `$TARGET_JSON` (L35) — do NOT re-invoke `$PR_TARGET_BIN`.
- `set +e` context (L2): every command's failure is handled via explicit `&& FLAG=1` / `[ -n ... ]` checks; `grep -E` returning 1 on no-match is safe and intentional.
- POSIX/bash-4 compatible: no arrays, no `[[ ]]`, no process substitution, no `mapfile`. Matches the file's existing `printf | jq -r` + `[ ... ]` style. Two-space indent inside the `gh pr create` branch, matching L32-68.
- Variable names are new (`EXEMPT_OK`, `REPO_DIR`, `HEAD_BRANCH`, `BASE_REF`, `DIFF_OK`, `DIFF_FILES`, `CODE_FILES`) — no collision with existing `STAGING_*`/`VERIFY_*`/`TARGET_*`/`SLUG`/`IS_PROD_REPO`.

## Code-extension list (exact, case-sensitive)
`.ts .tsx .js .jsx .mjs .cjs .py .go .rs .sh .bash` — as the single grep pattern
`\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sh|bash)$`. Everything else (`.md .txt .json .yml .yaml
.toml .csv`, extensionless, etc.) is non-code. `.sh` is CODE by design: a PR editing this
hook itself is never exempt-eligible.

## Repo-dir resolution
`cd_dir` is emitted by `bin/pr-gate-target` (src/pipeline/pr-target.ts L214: `cd_dir: target.cdDir`)
when the intercepted command had a leading `cd <dir> && ...`. Use it if non-empty AND a real
directory; otherwise the hook's `$PWD`. Never guess a third location.

## Fail-closed enumeration (all must fall through, never allow)
| Failure | Handling |
|---|---|
| `$PIPELINE_EMIT --through exempt` non-zero (no row / stale / bad sig) | `EXEMPT_OK=0` → whole lane skipped; existing gates run |
| `cd_dir` set but not a directory | falls back to `$PWD` |
| `head_branch` empty in TARGET_JSON | `DIFF_OK` stays 0 → fall through |
| Neither `origin/main` nor `main` resolves | `BASE_REF` empty → `DIFF_OK` stays 0 → fall through |
| `git diff` errors (bad ref, not a repo) | command substitution fails → `DIFF_OK` stays 0 → fall through |
| Diff succeeds but file list empty | `[ -n "$DIFF_FILES" ]` fails → fall through |
| Exempt row + ≥1 code file | explicit `block` (exempt-misuse) — never falls through to a possible allow |

## Post-edit checks
```bash
bash -n /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh
```
File grows from 72 to ~105 lines; L18-22, L48-58 (now shifted), L60-68 (now shifted) content unchanged.
