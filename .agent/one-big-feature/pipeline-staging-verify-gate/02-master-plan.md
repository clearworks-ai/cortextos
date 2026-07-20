# 02 — Master Plan: Pipeline Staging-Verify Gate

**Slug:** `pipeline-staging-verify-gate` · **Framework:** one-big-feature · **Target repo:** `~/code/cortextos`
**Planner engine:** ⛔ PENDING Josh (Fable 5 HIGH vs Opus vs Kimi K3) — surfaced, not defaulted.
**Verify command:** `npm run build && npm test` (cortextos)

## Goal
Formalize CLAUDE.md's manual Staging-First Protocol into an automated pipeline gate: a build-class change dispatched into a prod repo cannot reach `gh pr create`/merge until its codexer/opencoder output has passed a `staging-verify` stage on that repo's Railway staging env, recorded as a signed provenance row — enforced by the same mechanism that already enforces `true-verify`.

## Scope (in)
1. **New stage `staging-verify`** in the pipeline stage vocabulary + type + signed-ledger chain.
2. **Emit path** for `staging-verify` rows (proof that build output ran + passed on staging).
3. **`gate-pr-push.sh` extension** — require a fresh, valid `staging-verify` provenance row (per slug, per target repo) before allowing `gh pr create` to prod. Same block-shape as the current true-verify check.
4. **Per-repo Railway staging envs** (infra, larry-owned) for the 4 prod repos + a documented seed/verify runbook.
5. **Regression tests** mirroring `bypass-audit.test.ts` / gate tests for the new stage + the new gate branch.

## Scope (out)
- Gating the whole pipeline run (only PR-push is gated — frank2 explicit).
- Any change to the Stop gate / planner gate / provenance signing crypto.
- Auto-provisioning staging via IaC — envs are created once, larry-owned, manual+documented.
- Schema migrations (none — additive stage constant only).

## Phased build
- **P1 — Stage plumbing.** Add `'staging-verify'` to `STAGES` (`src/pipeline/ledger.ts`) between `review` and `true-verify`; propagate through `Stage` type consumers (`stage-emit.ts` parse, `bypass-audit.ts` stage-order logic). Unit-test the chain accepts + orders it.
- **P2 — Emit + verify.** Ensure `pipeline-stage-emit --stage staging-verify` and `--verify --through staging-verify` walk correctly (evidence_path returned, HMAC verified, TRANSCRIPT_TAMPERED honored). Record staging run evidence (repo, staging URL, verify-command exit, build-output sha).
- **P3 — Gate wiring.** In `gate-pr-push.sh`, before the existing true-verify block, add a `--through staging-verify` verify call; block with a staging-specific reason if missing/stale/empty. Fail-open on parse error (match existing gate safety). Slug + target-repo derivation identical to current logic.
- **P4 — Railway staging envs.** Confirm/create staging for each prod repo; document the seed→run→verify→emit runbook. Destructive seeds → staging-first marker.
- **P5 — Regression.** Tests for: stage accepted in chain; gate blocks PR without staging-verify row; gate passes with a fresh one; stale/empty evidence blocks. `npm run build && npm test` green.

## The 4 asks tie-in
Gate lives at the codexer/opencoder→PR boundary, so it slots between **implement** and **review→true-verify→PR** in PIPELINE.md — no reordering of existing stages.

## Risk / rollback
Additive; revert = drop the stage constant + the one gate branch. Gate is fail-open (parse error → allow) and block-once, so it cannot trap a session. Highest risk = a staging env that lies (build passes on staging, differs from prod) → mitigated by the per-repo runbook requiring the repo's real verify command on staging, not a smoke ping.

## Dispatch readiness
Specs in `03-specs/`. **Do NOT dispatch codexer until Josh picks the plan engine** (planner gate is FACT-enforced). On his pick: write engaged `state/pipeline-run.json` `{planner, plannerConfirmed:true, slug, stage:"specs", exempt:false}` then `send-message codexer 'GATE: build framework=one-big-feature slug=pipeline-staging-verify-gate repo=~/code/cortextos ...'`.
