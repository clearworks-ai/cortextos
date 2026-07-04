# LIVE STATE — autonomous run (Josh out, 2026-07-03 ~6pm)

## Fixed live (verified)
- WS11 crash spam — dist rebuilt, worker-guard live, frank2 healthy.
- `pre-meeting-brief` cron DISABLED in live crons.json (kills the 5:09 Telegram prep blocks). Note: the every-few-hours Alloi "confirmed/accepted" dupes are a SEPARATE issue = comms-check re-surfacing (fixed by P2).

## Merged / deployed
- briefs #30 — tasks lost-update fix (merged → deploying to briefs.clearworks.ai).

## PRs open ON YOUR FORK (clearworks-ai/cortextos) — review + merge
- #44 — batchD commitment-mining finish-wire (CLEAN, additive).

## Running now (from your fork = correct base)
- P1 — new page-based pre-meeting brief (Clearpath 10-section shape → tokened briefs page → Telegram link only).
- P2 — event/comms triage dedup (source-event id, fixes the repeating confirmations).
- Fable interview pass — how to build your self-interview / Full Work Inventory into the system (design, not code).

## Pending — already-planned salvage (needs careful landing on fork)
FINDING (read-only check against fork main, 2026-07-03 ~6pm): your fork ALREADY HAS parts of this work —
- WS5a mmrag timeout hardening: ALREADY in fork (mmrag.py, 29 timeout/reconcile refs) → DROP salvage, obsolete.
- WS7 instance resolution: fork already has src/cli/resolve-instance-id.ts → its approach likely wins; do NOT force my ACTIVE_INSTANCE version without a careful reconcile.
- WS2 claim-gate: fork bus.ts already has dedup (checkAndRecord); my verify-receipt/validateOutboundTelegram is COMPLEMENTARY (union), not a replacement — careful merge, not force.
- WS8 worker-runtime: NOT in fork (0 refs) → genuinely new, safe to add.
- WS3 handoff-tail, WS9 CRM-canonical, WS10 ledger, WS5b/c: applied CLEAN to fork (fork lacks them) = genuinely new.

DECISION (conservative, Josh out): do NOT force the mis-based salvage — the upstream base is partially obsolete vs your 303-ahead fork. The genuinely-new, clean pieces (WS3/WS8/WS9/WS10/WS5b-c/commitment) are better landed via FORK-BASED pipeline runs (like P1/P2) or a careful per-WS review WITH you — not by forcing upstream-based diffs that could regress your fork. batchD (#44) already landed clean because it was pure-new additive files. The rest: flagged for a fork-based pass, not autonomous forcing.

## Deferred (need a Fable plan first — do NOT build blind)
ophir+Moxie finance, frank2 weekly-review upgrade, onboarding-discovery (Chase), building-in-public publish.

## Auto-resume
If any run hits the Anthropic usage limit: pause, set a timer past the reset, resume automatically. No babysitting.

## Progress log + queue (autonomous)
- ✅ P1 → PR #45 (page-based meeting brief) on fork. Build green. ⚠️ Opus flagged a MAJOR dup-worker race: 15-min cron × 45-min window, no in-flight lock → could publish 2 links for one meeting (reproduces the spam). Exact fix documented in PR (optimistic-mark before spawn, clear on failure). DO NOT MERGE #45 until the dup-guard fix lands — queued as a fix-pass.
- ▶️ P2 (event dedup) still running.
- Queue (paced ≤2, after P2 frees a slot): (1) #45 dup-guard fix-pass; (2) genuinely-new fork-based workstreams — WS3 handoff-tail, WS8 worker-runtime, WS9 CRM-canonical, WS10 ledger (fork lacks these); skip WS5a/WS7 (fork already has them).
- Auto-resume if usage limit hit.

## ⟳ RESTART HANDOFF (2026-07-03 ~8:22pm — main session at 90% ctx)
MERGED: briefs #30 (tasks fix), fork #44 (commitment-mining). CLOSED: obsolete #41/42/43.
RUNNING (background workflows — will open PRs on clearworks-ai/cortextos on their own):
  - woeh6h5sy = #45 dup-guard fix (meeting-brief duplicate-worker race) → new PR wf/p1-meeting-brief-dupguard.
  - wnd316shy = P2 event/comms dedup (status unconfirmed — check `gh pr list --repo clearworks-ai/cortextos`).
NEXT SESSION SHOULD:
  1. When woeh6h5sy lands: verify the dup-guard PR, then that supersedes #45 (close #45 or merge the fixed one). Merge if clean.
  2. Confirm P2 (wnd316shy) — merge its PR if clean.
  3. Then queue genuinely-new fork-based workstreams paced ≤2: WS3 handoff-tail, WS8 worker-runtime, WS9 CRM-canonical, WS10 ledger (fork LACKS these; SKIP WS5a/WS7 — fork already has them). Clone from clearworks-ai/cortextos (fork), NEVER grandamenium.
  4. Deferred (need Fable plan first): ophir+Moxie, weekly-review, onboarding-discovery, building-in-public.
  5. Still-live fixes done: WS11 crash spam (dist), pre-meeting-brief cron disabled.
All context: this folder + ROADMAP.md + fleet memory (project_consolidation_roadmap_whats_left).

## Do NOT repeat
- Clone from the FORK (clearworks-ai/cortextos), never upstream (grandamenium) — upstream is pull-only and 246/303 diverged.
- Run pipelines in isolated clones; broad-refactor workstreams alone (conflict bombs when batched).
