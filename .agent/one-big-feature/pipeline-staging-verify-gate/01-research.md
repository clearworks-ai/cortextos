# 01 — Research: Pipeline Staging-Verify Gate

**Slug:** `pipeline-staging-verify-gate`
**Target repo:** `~/code/cortextos` (the pipeline + gate hooks live here)
**Author:** larry · **Date:** 2026-07-20 · **Source task:** `task_1784420168450_75742671` (frank2, due 07-22)

## Problem (verbatim scope from frank2, 2026-07-20)
- **(a) Per-repo staging** — each prod repo (`seiu521-dashboard`/`521-doordash`, `clearpath`, `lifecycle-killer`, `nonprofit-hub`) gets its own Railway staging env. NOT a cortextos-internal one. The pipeline dispatches build-class changes *into* these repos, so the gate lives at the PR-push boundary of each.
- **(b) Gate the build-stage output only** — codexer/opencoder output must pass a `staging-verify` stage before `gh pr create`/merge to prod. NOT gating the whole run — just PR-push. New stage + extend `gate-pr-push.sh`.
- **(c) This IS the CLAUDE.md Staging-First Protocol** (dedup/wipe/schema-migration rule that already exists as a manual mandate) formalized into an automated gate — same enforcement shape as the provenance/planner gates. Not a new concept.

## Existing mechanisms this reuses (read, verified 2026-07-20)
- **Stage vocabulary** — `src/pipeline/ledger.ts:15-24` `STAGES = ['research','synthesize','plan','specs','implement','review','true-verify','exempt']`. `Stage` type derived from it. `staging-verify` must be added here.
- **Provenance ledger** — `src/pipeline/ledger.ts` HMAC-signed rows (`artifact_sha256`, `prev_sha256`, `transcript_sha256`, `provenance_mode`). Each stage row is chained.
- **Emit binary** — `bin/pipeline-stage-emit` (→ `src/pipeline/stage-emit.ts`). `--verify --slug <slug> --through <stage> --max-age <sec>` walks the signed chain and returns `{evidence_path, ...}` or non-zero.
- **PR-push gate** — `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh:24-38`. On `gh pr create` it derives slug from branch, runs `pipeline-stage-emit --verify --slug <slug> --through true-verify --max-age 86400`, blocks on non-zero or missing/empty `evidence_path`. **This is the exact hook to extend** — add a `--through staging-verify` requirement ahead of (or folded into) the true-verify check.
- **Stop gate** — `gate-pipeline-stop.sh` enforces engaged-run + Josh-confirmed planner on build actions. Unchanged by this work.

## Key insight
The gate infra already exists and is proven (true-verify is enforced the same way today). This is **additive**: one new stage constant, one emit path for it, one extra `--through staging-verify` verify call in `gate-pr-push.sh`, plus the per-repo Railway staging envs (infra, larry-owned). No new subsystem, no schema migration → **OBF, not full M2C1**.

## Open dependency (infra, larry-owned, non-blocking on code)
Railway staging services for the 4 prod repos. `clearpath-dev`, `lifecycle-dev`, `nonprofit-dev` already exist per agent-org-chart-build-plan.md; `seiu521-dashboard` staging may need creation. Staging setup is destructive-adjacent → **staging-first marker required before any prod-data seed** (CLAUDE.md).
