# CORTEXT CONSOLIDATION — MASTER ROADMAP (the one thread, don't lose it)

Everything from the 2026-07-03 session lives in this folder: `~/code/cortextos/.agent/one-big-feature/fleet-consolidation/`.
To resurface it from your phone: ask frank2/cortext "what's left on the consolidation roadmap" — it's saved in fleet memory (`project_consolidation_roadmap_whats_left`).

## The two goals
1. ONE reliable repo / one version of everything. 2. A reliable REMOTE manager you run from your phone.

## The files (what's where)
- `00-fable-plan.json` — Fable's root-cause analysis + full plan.
- `01-josh-decisions.md` — every decision you made.
- `02-updated-workstreams.md` / `03-master-roadmap.md` — the 10 core workstreams + routing.
- `05-fable-ideation.json` — the opportunities Fable discovered (3 angles + top 3).
- `06-phase2-capabilities.md` — phase-2 features + your rulings + grounded shapes.
- `07-added-workstreams-and-audit.md` — WS11 (comms workers), WS12 (better coding agent), self-audit.
- `08-work-inventory-scaffold.md` — your deeper Agentic-OS work inventory (~70 items).
- `09-one-go-batch.md` — **THE ACTION LIST**: PRs to merge, prod-ops to run, questions to answer.

## STATUS (live) — updated 2026-07-03 night (see `12-session-2026-07-03-night-merge-and-redo.md`)
Repo of record = **clearworks-ai/cortextos** (the fork). Batch A/B/C branches were built on UPSTREAM
and are DELETED (PRs closed, not merged); only Batch D (commitment-mining) reached the fork (#44).
So A/C are now **redos against the fork**, isolated per workstream. Progress:
- ✅ MERGED to fork main: #39 (WS2 cron banned-prompt gate), #40 (ci-alert-gate), #46 (source-event
  dedup), #45 (page-based pre-meeting brief + **claim-first atomic O_EXCL lease** race fix; competing
  PR #48 closed). ✅ #44 commitment-mining (earlier).
- 🔧 WS7 → PR #49 open, **needs a follow-up fix** (commander `--instance … 'default'` bypasses the
  marker in ~10 CLI cmds → `restart <agent>` still broken). Do NOT merge until fixed.
- ▶️ WS4 fleet-reconcile — workflow running (isolated), one PR incoming.
- ⏭️ Queued isolated redos: WS6 context-diet, WS2 verify-receipts remainder, WS12 scope-guard.
- ⏭️ WS3 handoff-tail = fork PR #30 (real, not superseded) — rebase + merge pending.

## STILL TO DO (the thread)
**Fork PRs to land:** WS7 #49 (after the commander fix), WS4 (incoming), WS3 #30, then WS6/WS2/WS12.
**Prod-ops** (Josh-gated, in `09`): WS11 dist rebuild = DONE; WS5 Clearpath export+re-embed;
WS7 instance CUTOVER (marker write + backup + archive dead `default`); WS9 backfill = SKIP (decided).
**Open questions:** OpenRouter spend = FAILOVER-ONLY (resolved); merge/deploy order = Josh merges each.

## OPPORTUNITIES FABLE FOUND (phase-2, not built yet — from `05`/`06`)
Top 3: (1) **Commitment mining + pre-meeting briefs** (relationship OS) — commitment-mining now in flight (Batch D); (2) **Verified price book + proposal-to-cash** (kills fabricated prices, automates revenue path); (3) **Tenant provisioning kit + vertical packs** (turns your fleet into a sellable product).
Also: ophir+Moxie finance, weekly-review upgrade, onboarding-discovery (Chase AI), building-in-public publish. Stashed: content-publish, agency-installer (Docker/one-click + provisioning pack).

## PHASE-2 RULINGS (yours)
Pre-meeting brief = copy Clearpath's briefing-generator shape → tokened web link. Commitment mining = finish-wire (in flight). Personal finance = keep ophir, plug Moxie, unblock its comms. Content-publish = stash. Weekly review = improve frank2's. Agency-installer = later, but Docker/one-click + provisioning pack is the productize phase. Onboarding = wire in Chase AI's prompt-discovery.
