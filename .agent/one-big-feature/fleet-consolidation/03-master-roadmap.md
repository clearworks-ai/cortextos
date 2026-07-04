# Master execution roadmap — routing the 10 workstreams through the dynamic pipeline

## Pipeline shape (confirmed)
Explore (Sonnet, done) → Plan (Fable high, done) → **Implement (Fable medium, worktree/WS)** → **Merge (Sonnet, deterministic)** → **Review (Opus high, loops to Implement)** → **PR (opened, never auto-merged)**.

## Guardrails
- The pipeline **writes code + opens PRs only**. It NEVER runs a prod migration/export/cutover and NEVER merges.
- **Prod operations are separate, staged, Josh-gated steps** run after the code PR is reviewed: Clearpath export run, instance cutover, CRM contact backfill, Supabase decommission.
- Runs **per-repo** (worktrees are per-git-repo).

## Routing table
| WS | Repo | Through pipeline (code→PR) | Separate gated prod-op |
|----|------|----------------------------|------------------------|
| WS1 briefs tasks lost-update fix | briefs | yes (FIRST) | volume state migration (small) |
| WS2 claim gate + verify-receipts + rule code-gates | cortextos | yes | — |
| WS3 handoff tail fidelity (daemon) | cortextos | yes | — |
| WS4 fleet reconcile + drift alarms | cortextos | yes | — |
| WS5 in-house extractor + Clearpath gold-slice import | cortextos + knowledge-sync | yes (extractor + export script) | RUN the ~2,700-row export + re-embed (gated) |
| WS6 context diet: MEMORY split + IDENTITY + injection strip | cortextos (agent files) | yes | — |
| WS7 instance consolidation (paths.ts marker) + backup script | cortextos | yes (code) | RUN the cutover in a fleet-stopped window (gated, staging-first) |
| WS8 wire opencode adapter into worker-spawn path | cortextos | yes | verify tool-parity before routing heavy jobs |
| WS9 CRM canonical: sync-board direction flip + canonical-id + Clearpath push | cortextos + briefs | yes (code) | RUN contact backfill (gated) |
| WS10 graph re-index cron + R6 activity ledger + R8 memory test harness | cortextos | yes | — |

## Execution order (front-load the daily pain, then the trust mechanism)
WS1 (briefs) → WS2 (+R8 harness) → WS3 → WS4 (+graph re-index) → WS9 code (sync-board flip shares WS1 fix) → WS5 extractor → WS6 context diet → WS7 code → WS8 → then the gated prod-ops in dependency order.

## Not in this consolidation (separate follow-on)
- Full Supabase decommission = migrating the whole Clearpath platform (154 tables, app, MCP, Chrome extension). Scope later, once nothing in the fleet needs the Clearpath app/MCP/extension. Extract the ~2,700-row gold slice first (WS5).
