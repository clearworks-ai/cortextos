# Research — gate-pr-exempt-lane

## Problem (proven empirically 2026-07-25)
`orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh` intercepts `gh pr create` and
verifies provenance via `bin/pipeline-stage-emit --verify --slug <slug> --through true-verify`.
It has **no exempt lane**. A pure-doc PR cannot open:

- Signed exempt row verifies `--through exempt` (exit 0) but the gate only walks `--through true-verify` → `NO_ROWS`.
- Confirmed live: slug `comms-worker-template-fetch-filter-surface` (template-only .md port) blocked at `gh pr create`.

This contradicts the runbook:
- `orgs/clearworksai/agents/larry/PIPELINE.md` L110-111: "Exempt ONLY pure-doc / config-only changes with no runnable behavior (mark `exempt:true` + reason in pipeline-run.json)."
- PIPELINE.md L149: "Exemptions are signed `--stage exempt --reason "..."` rows only."

Fleet-wide impact: EVERY doc-only PR is blocked, forcing provenance theater (a full research→plan→specs→review→true-verify chain for a markdown change that has nothing runnable to true-verify).

## Ledger facts (src/pipeline/ledger.ts)
- `exempt` is stage rank 8, standalone genesis (`allowedPreviousStages(exempt) = []`, prev_sha = GENESIS).
- `verifyChainDetailed({throughStage})` filters candidate terminal rows by `row.stage === throughStage` (L1068). So `--through exempt` accepts an exempt terminal; `--through true-verify` never sees it.
- `pipeline-stage-emit --slug <s> --stage exempt --artifact <path> --reason "..." --runner larry` writes + signs an exempt row. Non-authored (no transcript needed). Already used elsewhere for exempt entries.

## Anti-misuse requirement (the real design constraint)
An exempt lane must NOT let a lazy agent skip true-verify on real code by emitting an exempt row.
PIPELINE.md L150 rejected an OS/container privilege boundary as overbuilt for the "lazy-agent threat model";
enforcement lives at dispatch + file-level checks. So the exempt lane guard = **the PR branch diff must
touch ONLY non-code files.** If a signed exempt row exists but the diff touches code, BLOCK loudly.

Code extensions (block exempt lane): `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .sh .bash`.
Non-code (exempt-eligible): `.md .txt .json .yml .yaml .toml .csv` + any file with no code extension.
Note: `.sh` counts as CODE — so THIS gate-fix PR (edits gate-pr-push.sh + a .ts test) is NOT exempt-eligible and correctly runs the full pipeline. The template-port PR (only `.md`) IS exempt-eligible.

## How the hook can compute the diff
The hook already derives the target via `bin/pr-gate-target --cwd "$PWD"` → JSON with `head_branch`, `target_repo`, `slug`, `is_prod_repo`. Add: resolve the repo working dir (hook PWD or the `cd <dir>` the pr-target helper already parses), then `git -C <repo> diff --name-only <base>...<head_branch>` where base = the repo's default branch (main). Classify the returned paths.

Edge cases:
- Empty diff / branch not found → fail closed (no exempt bypass; fall through to true-verify path which will also fail → blocks). Safe.
- Client-repo PRs (--repo + --head, is_prod_repo may vary): exempt lane still keyed on diff-is-noncode + signed exempt row. Keep behavior identical; the diff classification is repo-agnostic.

## Scope (what to change)
1. `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh` — inside the `gh pr create` branch, BEFORE the staging/true-verify checks: if a signed `exempt` terminal verifies (`--through exempt`, max-age 86400) AND the branch diff is non-code-only → `exit 0` (allow). If exempt row present but diff has code files → `block` with an exempt-misuse message. Else fall through to existing true-verify (and prod staging) requirement unchanged.
2. `tests/unit/pipeline/hook-gates.test.ts` — add cases: (a) exempt row + doc-only diff → allowed; (b) exempt row + code diff → blocked (misuse); (c) no exempt row → true-verify path unchanged (still blocks without chain).

## Acceptance criteria
- `gh pr create` on a doc-only branch WITH a signed exempt row → ALLOWED.
- `gh pr create` on a branch WITH exempt row but a code file in the diff → BLOCKED (exempt-misuse).
- `gh pr create` with NO exempt row → identical to today (true-verify chain required; prod staging-verify required).
- Fail-closed on any helper error / unresolvable diff.
- Unit tests green; `npm run build` clean.

## Non-goals
- No change to `bin/pipeline-stage-emit`, `src/pipeline/ledger.ts`, or the send-message/dispatch gates.
- No new OS/container privilege boundary.
