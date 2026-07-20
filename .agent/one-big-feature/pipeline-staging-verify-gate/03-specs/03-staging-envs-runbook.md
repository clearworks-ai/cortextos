# Spec 03 — Per-repo Railway staging envs + emit runbook (larry-owned infra)

**Owner:** larry (Railway CLI/MCP/browser — never Josh manual steps).
**Not a codexer task** — infra + docs. Codexer builds specs 01/02; larry does this leg directly.

## Envs required
| Prod repo | Railway service | Staging env |
|-----------|-----------------|-------------|
| clearpath | clearpath-production-c86d | `clearpath-dev` (exists — verify) |
| lifecycle-killer / cxportal | lifecycle-killer-production | `lifecycle-dev` (exists — verify) |
| nonprofit-hub | nonprofit-hub-production | `nonprofit-dev` (exists — verify) |
| seiu521-dashboard / 521-doordash | (confirm service) | **may need creation** |

Verify existing envs via `railway status` / Railway MCP before assuming. `clearpath-dev`, `lifecycle-dev`, `nonprofit-dev` listed live in agent-org-chart-build-plan.md but confirm against the live project, don't trust the note.

## Runbook — what a `staging-verify` emit proves (per slug, per repo)
1. Codexer/opencoder build output applied to a staging branch/checkout of the target repo.
2. Deploy to that repo's Railway **staging** env (push to staging branch → auto-deploy, or `railway up` to the staging service).
3. Run the repo's **real verify command** against staging (NOT a smoke ping):
   - clearpath → `npm test`
   - lifecycle-killer / nonprofit-hub → `npm run check`
   - auditos → `bin/verify.sh` (13-gate)
   - seiu521-dashboard → (confirm)
4. Capture evidence: repo, staging URL, verify-command exit code + tail, build-output sha.
5. `bin/pipeline-stage-emit --stage staging-verify --slug <slug> ...` writing that evidence → produces the signed row `gate-pr-push.sh` (spec 02) requires.

## Staging-first safety (CLAUDE.md — non-negotiable)
Any staging seed that copies/dedups/wipes real data = destructive-adjacent → write the staging-first marker + validate counts on staging BEFORE seeding. Never seed prod data into staging without it. This gate EXISTS to enforce exactly this discipline — the runbook must not itself violate it.

## Deliverable
A short `PIPELINE-STAGING.md` (or a section appended to `larry/PIPELINE.md`) documenting the 5-step runbook + the per-repo verify-command table, so any pipeline run knows how to satisfy the new gate.
