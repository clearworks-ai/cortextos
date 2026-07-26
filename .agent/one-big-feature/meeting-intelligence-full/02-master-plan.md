# 02 — Master Plan: meeting-intelligence-full (the "meeting mega-build")

**Slug:** meeting-intelligence-full
**Primary repo:** /Users/joshweiss/code/cortextos
**Secondary repos touched by individual pieces:** ~/code/briefs (piece 4.1), ~/code/lifecycle-killer aka cxportal (piece 4.6 / §8)
**Framework:** one-big-feature (per-piece; each of the 7 shards below is its own bounded feature/spec, dispatched and PR'd independently — NOT one giant diff)
**Grounded in:**
- `.agent/one-big-feature/meeting-followup/01-research.md` (Fable research, 2026-07-25, live-state-verified)
- Google Doc `1TA9bZpm6l6Rc2p8O2K9Oz7N8b1iqpk-kyWIvIsEkBGI`, §4 (target architecture, 4.1–4.6) + §8 (Josh-flagged CRM/cxportal sync gap, added 2026-07-25)

This plan does NOT re-derive scope. It materializes the Google Doc's existing §4/§8 into buildable shards. SCOPE_LOCK count check below.

## SCOPE_LOCK — item count check

Google Doc names exactly **7 items**: 6 numbered subsections under "§4 THE TARGET ARCHITECTURE" (4.1 through 4.6) plus "§8 OPEN GAP flagged by Josh — cxportal/CRM sync". This master plan produces exactly 7 specs, one per item, no compression, no merge:

| # | Google Doc section | Spec file | One-line scope (verbatim-sourced, not paraphrased away) |
|---|---|---|---|
| 1 | §4.1 Capture | `03-specs/01-capture-webhook.md` | "Stop polling. Use briefs.ts:2551 /api/fireflies/webhook/:id... Deterministic dedup ledger (zero LLM)... Collapse the two pollers into one path." |
| 2 | §4.2 Context layer | `03-specs/02-context-layer.md` | "Populate knowledge/clients/\<client\>.md... This is the exact substrate all three tracking crons already try to read." |
| 3 | §4.3 Extraction | `03-specs/03-extraction-context-injection.md` | "Keep the good machinery, feed it context... run once per new meeting (webhook-triggered), inject client_context." |
| 4 | §4.4 Relevance + dedup | `03-specs/04-relevance-dedup.md` | "Fuzzy dedup replacing exact-hash... Relevance score vs client_context. 4-tier priority with hard caps... Tie goes to DROP." |
| 5 | §4.5 Drafting | `03-specs/05-drafting-trust-ladder.md` | "Fix the cron first: change meeting-recap-draft cron to spawn-worker exactly like meeting-commitments... 3-level trust ladder." |
| 6 | §4.6 Tracking + PM sync | `03-specs/06-tracking-pm-sync.md` | "Write to cxportal's Meetings Hub DB (14-table schema, PR #42)... The writer (PR #141) is merged but unwired — wire its Step 4 onto the pipeline." |
| 7 | §8 CRM/cxportal sync gap | `03-specs/07-crm-cxportal-sync-spec.md` | "This needs an explicit sync spec (direction of truth per field, write path, conflict rule) before the tracking/PM-sync piece (4.6) is built." |

7 Google Doc items in → 7 specs out. Verified by re-reading `/tmp/gdoc-plan.txt` lines 417–486 (§4.1–4.6) and 1292–1299 (§8) at plan-write time.

## Known-gap cross-reference (prior diagnosis, still true as of 2026-07-25)

`incident_meeting_intel_writeback_built_never_wired_2026-07-25`: `meeting-intelligence-engineer` Step 4 (the file-writeback half of piece 4.6 — writes `knowledge/meetings/*.md` + `knowledge/clients/*.md`) is built and tested (PR #141) but attached to **no cron**. Verified live 2026-07-25: `knowledge/meetings/` = README.md only, `knowledge/clients/` = `_template.md` only, zero real files, despite 55 real meeting files already sitting in `orgs/clearworksai/agents/crm/crm/meetings/` (crm agent's private dir, invisible to pa/frank2).

This is why the **dispatch-first shard this run is 06a** (the writer-wiring half of piece 6, below) — not piece 1 (webhook) and not piece 2 (context layer), even though the Google Doc's own §5 "smallest first build" recommends the context layer first. Rationale for the override: (a) Josh's task instruction for this run explicitly named Step4-wiring as highest priority, (b) it is the smallest, most mechanical, most already-proven shard (mirrors the exact conditional-spawn pattern already live in `pre-meeting-brief-page` cron + the exact sibling-worker skeleton already live in `meeting-commitments-worker`), (c) unblocking it also unblocks the two downstream consumers (overdue-chase, orphan-audit) that already fire every 2h against empty stores.

## Sequencing / dependencies (from the Doc's own text, not invented)

- §8 (spec 07) says explicitly it must be resolved **before** the DB-write half of 4.6 (spec 06b) is built — so 06 is split into 06a (writer→files, buildable now, no dependency) and 06b (writer→cxportal DB, blocked on 07).
- §5 "smallest first build" (Doc lines 493–529) says build 4.2 (context layer, spec 02) before 4.1 (webhook, spec 01) or the trust ladder (4.5, spec 05) — noise comes from context-free extraction, not from polling-vs-webhook or draft-autonomy. Specs 01–05 preserve this Doc-recommended order for anything dispatched AFTER 06a this run.
- 4.3 (spec 03) and 4.4 (spec 04) both depend on 4.2 (spec 02) existing (`client_context` is 4.2's output, consumed by 4.3's prompt injection and 4.4's relevance scoring).

## Dispatch plan for THIS run

1. **06a (writer wiring)** — dispatched first, this run. Repo: cortextos. See `03-specs/06-tracking-pm-sync.md` §"6a".
2. Remaining specs (01–05, 06b, 07) materialized this run as full specs, NOT dispatched this run (see report for what's left for follow-up). Dispatch order for a follow-up run should follow the dependency chain above: 02 → (03, 04 in parallel) → 01 → 05 → 07 → 06b.

## Cross-repo GATE note

`gate-codexer-planning.sh` requires `repo=<real target repo>` per dispatch. Three of the seven specs are NOT rooted in cortextos:
- Spec 01 (webhook) — repo `/Users/joshweiss/code/briefs` (`src/briefs.ts:2551`, `src/server.ts:34-37`).
- Spec 06b (cxportal DB write) and spec 07 (sync contract) — repo `/Users/joshweiss/code/lifecycle-killer` (symlinked as `~/code/cxportal`; Meetings Hub schema `migrations/0009_meetings_hub.sql`, PR #42/#43/#44).
Each of those specs' OBF planning artifacts must live under `<that repo>/.agent/one-big-feature/<slug>/` per the gate, not under cortextos — this master plan documents the scope centrally, but the per-repo GATE dispatch for those three specs needs its own `02-master-plan.md`/`03-specs/` materialized in the target repo before it can be sent to codexer/opencoder. Flagged as follow-up work, not done this run.
