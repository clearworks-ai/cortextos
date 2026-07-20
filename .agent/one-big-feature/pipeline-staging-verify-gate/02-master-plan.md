# 02 — Master Plan: Pipeline Staging-Verify Gate

**Slug:** `pipeline-staging-verify-gate` · **Framework:** one-big-feature · **Target repo:** `~/code/cortextos`
**Planner engine:** Fable 5 HIGH (Josh-confirmed 2026-07-20, relayed via frank2).
**Verify command:** `npm run build && npm test` (cortextos)

## Goal
Formalize CLAUDE.md's manual Staging-First Protocol into an automated pipeline gate: a build-class change dispatched into a **prod repo** cannot reach `gh pr create`/merge until its codexer/opencoder output has passed a new `staging-verify` stage on that repo's Railway staging env, recorded as a signed provenance row — enforced by `gate-pr-push.sh` the same way it already enforces `true-verify`.

## Scope (in)
1. **New stage `staging-verify`** in the pipeline stage vocabulary + `Stage` type + signed-ledger chain, inserted **between `review` and `true-verify`**.
2. **Emit path** for `staging-verify` rows — evidence-bearing (like `true-verify`): target repo, staging URL, verify-command exit, build-output sha.
3. **`gate-pr-push.sh` extension** — require a fresh, valid `staging-verify` provenance row (per slug, per target repo) before `gh pr create` to a prod repo. Same block-shape as the current true-verify check, added **BEFORE** the true-verify block, fail-open on parse error.
4. **Per-repo Railway staging envs** (infra, larry-owned, manual) for the 4 prod repos + a documented seed→run→verify→emit runbook.
5. **Regression tests** mirroring `tests/unit/pipeline/ledger.test.ts` + the gate tests for the new stage and the new gate branch.

## Scope (out)
- Gating the whole pipeline run (only PR-push is gated — frank2 explicit).
- Any change to the Stop gate (`gate-pipeline-stop.sh`) / planner gate / provenance signing crypto (HMAC).
- IaC auto-provisioning of staging — envs are created once, larry-owned, manual + documented.
- Schema migrations (none — additive stage constant only).

## Key design decisions (resolved — do NOT let codexer re-guess)
1. **`staging-verify` is an OPTIONAL predecessor of `true-verify`.** In `src/pipeline/ledger.ts`, `allowedPreviousStages('true-verify')` becomes `['review', 'staging-verify']` (was `['review']`), and `allowedPreviousStages('staging-verify')` returns `['review']`. This keeps every existing `review → true-verify` chain valid (backward-compatible) while allowing `review → staging-verify → true-verify`. A `--through staging-verify` walk succeeds on its own (terminates at staging-verify, chained from review).
2. **`staging-verify` is NOT an authored/planner stage.** It is an execution-evidence stage exactly like `true-verify`: no transcript provenance, but `evidence_path` required at emit. Do NOT add it to `AUTHORED_STAGES` (`ledger.ts:133`, `bypass-audit.ts:25`).
3. **Target-repo derivation in the gate = git origin match, NOT a new write path.** `gate-pr-push.sh` fires on every `larry` `gh pr create` regardless of cwd. The staging-verify requirement applies ONLY when `git remote get-url origin` (in the PR's cwd) matches one of the 4 prod repos. For cortextos-internal PRs (origin = cortextos) the staging-verify branch is skipped, so this build itself and other cortextos-internal work are NOT trapped. The true-verify block is unchanged and still applies to all PRs as today.

## Phased build
- **P1 — Stage plumbing (`src/pipeline/ledger.ts`).** Insert `'staging-verify'` into `STAGES` (lines 15-24) between `'review'` and `'true-verify'`. Add `stageRank` case `'staging-verify': return 6` and bump `'true-verify'` → 7, `'exempt'` → 8 (lines 323-334). Update `allowedPreviousStages` (lines 336-347) per decision #1. Extend the evidence-required check at line 868 to include `staging-verify`. Spec 01.
- **P2 — Emit + verify (`src/pipeline/stage-emit.ts`).** `parseStage` (line 59) validates against `STAGES`, so `--stage staging-verify` / `--through staging-verify` are accepted for free once P1 lands. Confirm no hardcoded stage list needs editing. Verify `--verify --through staging-verify` walks and returns `evidence_path`. Spec 01.
- **P3 — Gate wiring (`gate-pr-push.sh`).** Add a staging-verify branch BEFORE the true-verify block (lines 24-38), gated on the git-origin prod-repo match (decision #3), same shape + fail-open discipline. Spec 02.
- **P4 — Railway staging envs (larry-owned infra).** Confirm/create staging for each prod repo; document the seed→run→verify→emit runbook. Destructive seeds → staging-first marker. Spec 03.
- **P5 — Regression.** Tests in `tests/unit/pipeline/ledger.test.ts` (stage accepted + ordered in chain; `--through staging-verify` verifies) and a gate test (blocks PR without staging-verify row on a prod-repo origin; passes with a fresh one; stale/empty evidence blocks; cortextos-origin PR unaffected). `npm run build && npm test` green.

## Risk / rollback
Additive; revert = remove the stage constant + the one gate branch + restore `allowedPreviousStages('true-verify')` to `['review']`. Gate is fail-open (parse error → allow) and block-once, so it cannot trap a session. Backward-compatible: existing `review→true-verify` chains stay valid (decision #1). Highest risk = a staging env that lies (passes on staging, differs from prod) → mitigated by the per-repo runbook requiring the repo's real verify command on staging, not a smoke ping.

## Dispatch readiness (UNBLOCKED)
Planner confirmed **Fable 5 HIGH** by Josh 2026-07-20 — the planner-gate hold is lifted. Specs are in `03-specs/`. To dispatch: write engaged `state/pipeline-run.json` `{"ts":<now>,"slug":"pipeline-staging-verify-gate","stage":"specs","exempt":false,"planner":"fable","plannerConfirmed":true}`, then `send-message codexer 'GATE: build framework=one-big-feature slug=pipeline-staging-verify-gate repo=~/code/cortextos <spec>'`. P4 (Railway envs) is larry-owned infra, done directly, not a codexer task.
