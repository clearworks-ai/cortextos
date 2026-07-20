# Spec 03 — Per-repo Railway staging envs + emit runbook (P4, larry-owned infra)

**Owner:** larry (Railway CLI / MCP / browser-harness — never Josh manual steps).
**Not a codexer task** — infra + docs. Codexer builds specs 01/02; larry does this leg directly.
**Deliverable:** `orgs/clearworksai/agents/larry/PIPELINE-STAGING.md` (or a `## Staging-Verify Runbook` section appended to `larry/PIPELINE.md`) documenting the runbook + the per-repo verify-command table.

## Envs required (the 4 prod repos, per larry CLAUDE.md repo table)
| Prod repo | Railway prod service | Staging env | Real verify command |
|-----------|----------------------|-------------|---------------------|
| clearpath | clearpath-production-c86d | `clearpath-dev` (verify exists) | `npm test` |
| cxportal / lifecycle-killer | lifecycle-killer-production | `lifecycle-dev` (verify exists) | `npm run check` |
| nonprofit-hub | nonprofit-hub-production | `nonprofit-dev` (verify exists) | `npm run check` |
| auditos / gws-security | (internal / gws-security-production) | **confirm/create** | auditos `bin/verify.sh` (13-gate) · gws `uv run python -m pytest` |

Verify existing envs via `railway status` / Railway MCP BEFORE assuming they exist — `clearpath-dev`/`lifecycle-dev`/`nonprofit-dev` are listed in agent-org-chart-build-plan.md but that is a note, not live state (MUTABLE-FACT = hypothesis: confirm against the live project). The verify-command column MUST match each repo's real command from larry CLAUDE.md's "Repositories Owned" table — do NOT substitute a smoke ping.

## Runbook — what a `staging-verify` emit proves (per slug, per repo)
1. Apply the codexer/opencoder build output to a staging branch/checkout of the target prod repo.
2. Deploy to that repo's Railway **staging** env (push to the staging branch → auto-deploy, or `railway up` to the staging service). Never touch the prod service.
3. Run the repo's **real verify command** (table above) against the staged deploy — exit must be 0.
4. Write an evidence file (the `--evidence` artifact spec 01 defines):
   ```json
   {
     "repo": "~/code/clearpath",
     "staging_url": "https://clearpath-dev.up.railway.app",
     "verify_command": "npm test",
     "exit_code": 0,
     "build_output_sha256": "<sha of deployed build output>"
   }
   ```
   Store it under `orgs/clearworksai/agents/larry/state/staging-verify/<slug>.json` (non-empty file — the gate asserts `-s`).
5. Emit the signed row:
   ```
   bin/pipeline-stage-emit --slug <slug> --stage staging-verify \
     --artifact <build-output-path> --evidence <evidence.json> --runner larry
   ```
   This produces the signed `staging-verify` ledger row that `gate-pr-push.sh` (spec 02) requires before a PR to that prod repo. It chains off the existing `review` row for `<slug>` (ledger enforces `allowedPreviousStages('staging-verify') = ['review']`), so a `review` row must already exist.

## How the row satisfies the gate
`gate-pr-push.sh` runs `pipeline-stage-emit --verify --slug <slug> --through staging-verify --max-age 86400` and asserts a non-empty `evidence_path`. The row from step 5 (< 24h old, evidence file present + non-empty) passes. Older than 24h → re-run the staging verify and re-emit.

## Staging-first safety (CLAUDE.md — non-negotiable)
Any staging seed that copies/dedups/wipes real data is destructive-adjacent → write the staging-first marker + validate counts on staging BEFORE seeding. Never seed prod data into staging without it. This gate EXISTS to enforce exactly this discipline — the runbook must not itself violate it. Prefer synthetic/fixture data on staging where the verify command allows.

## Acceptance
- `PIPELINE-STAGING.md` exists with the 5-step runbook + per-repo verify-command table.
- Each of the 4 prod repos has a confirmed (or newly created, larry-owned) Railway staging env recorded in the doc with its live URL.
- One end-to-end dry-run: for a trivial slug, produce a staging-verify evidence file, emit the row, and confirm `pipeline-stage-emit --verify --through staging-verify` exits 0 with the evidence_path — proving the gate would pass.
