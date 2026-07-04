# Updated workstreams (Fable plan + Josh's decisions + CRM grounding + 12-tab completeness)

## CRM reality (grounded, not the estimate)
Josh estimated ~9 surfaces; grounded reality = **4 live CRM stores + 3 passive sources**, and there is **no "Connect" agent** — the existing `crm` agent is the intended canonical store.
- Live stores: (1) crm agent files — pipeline.json 24 deals, contacts.json 291 contacts, interactions.jsonl 222, followups 78; (2) briefs board (derived, BUT sync-board.py reverse-writes stage into pipeline.json every 15min = stealth writer); (3) Clearpath Postgres (~66 orgs, 651 contacts, engagements, richer schema, NOT synced); (4) Moxie (invoices/clients, cloud).
- Passive sources that create people: Fireflies attendees, Omi people, Gmail senders.
- Rot: contacts.json last synced from Clearpath 2026-05-12 (7wk stale, 291 vs 651); crm pipeline and Clearpath engagements have no link; briefs board silently overwrites crm edits every 15min.

## Instances (confirmed)
No separate "cortext" root — only `cortextos1` (live) and `default` (dead, but the code default = the trap). Making cortextos1 canonical = change resolution in `src/utils/paths.ts` + `src/cli/status.ts` (marker-file default → cortextos1). WS7.

## Final workstream list
- **WS1** Briefs tasks lost-update fix — bus authoritative, kill blind PUT, merge-by-id + version. (daily pain; ship first)
- **WS2** Claim gate + verify-receipts + hard behavioral rules as code gates (send-telegram choke point).
- **WS3** Handoff tail fidelity (daemon appends live buffer at restart).
- **WS4** Fleet reconcile + drift alarms (process/cron/.env) on the receipt channel.
- **WS5** Knowledge pipeline: fail-loud ingest, wiki re-publish cron, Clearpath **real export of intel+audits**, **PLUS port Clearpath's deep intel-extraction in-house (MMRAG/knowledge-sync)** — per Josh decision 2 (not archive-only), uninstall claude-mem.
- **WS6** Context diet: MEMORY.md → ≤10KB index + size lint, rules→code, facts→KB, SOUL→upstream weight, persona→IDENTITY.md (agent-identity one place), strip per-message injection.
- **WS7** Instance consolidation (cortextos1 canonical) + hot-state off-machine/git backup. Window: whenever, staging-first with pre-snapshot.
- **WS8** Model-routing layer — per Josh decision 1: incorporate OpenRouter broadly, route as much as possible to cheap open-weight models (mechanical/triage/bulk), reserve Claude/Fable for real reasoning; includes frank2 rate-limit failover to degraded mode.
- **WS9 (NEW)** CRM consolidation → ONE canonical store (crm agent, brandable as Connect) = single place for ENTITY identity: (a) flip sync-board direction so the board never overwrites crm (same bus-authoritative fix as WS1); (b) Clearpath→crm push on contact/deal events + one-time backfill (fix the 7wk contact drift); (c) Fireflies/Omi/Gmail new-person events pipe into crm as the single write surface.
- **WS10 (NEW, completeness)** graphify re-index cron (tab 8); R6 correlated activity ledger (did-vs-claimed); R8 memory-correctness test harness (makes the rest falsifiable). Woven in: R8 pairs with WS2, graph re-index folds into WS4/WS5.

## Sequence
WS1 → WS9(a) sync-board flip (shares the fix) → WS2 (+R8 harness) → WS3 → WS4 (+graph re-index) → WS9(b,c) CRM push/backfill → WS5 knowledge pipeline + extraction-in-house → WS6 context diet → WS7 instance cutover → WS8 model routing. R6 ledger last.

## Two layers of "one place for identity"
- Agent persona identity → IDENTITY.md per agent (WS6).
- Entity identity (contacts/deals/orgs) → the crm/Connect agent (WS9).
