# THE ONE-GO BATCH — everything that needs Josh, collected for a single review

Autonomous execution runs code → PRs (isolated clones, no merges, no prod-ops). This doc accumulates every merge, prod-op, and decision so Josh handles them all at once.

## PRs to review + merge (as they land)
- **WS1 — briefs tasks lost-update fix → PR #30** ✅ https://github.com/clearworks-ai/briefs/pull/30 — Opus-approved (optimistic-lock 409 + merge-by-id). NOTE: merging to briefs `main` auto-deploys to Railway (that's how the fix goes live).
- **Batch A → PR #718** ⚠️ NEEDS REWORK https://github.com/grandamenium/cortextos/pull/718 — WS2 + WS3 + WS8 landed, but WS4 (fleet-reconcile) OVER-REACHED (~80-file conflict) and did NOT merge; WS4 also has no daemon auto-trigger (major); WS2 stop-flag has no writer (inert, minor); WS3 open-loop previews raw JSON envelope (minor). DO NOT merge as-is — needs a targeted fix pass (redo WS4 in-scope + trigger + 2 minor fixes). Argues for the WS12 SCOPE_GUARD.
- **Batch B (WS5 kb-pipeline hardening, WS9 CRM canonical, WS10 graph/ledger/tests) → PR #717** ✅ https://github.com/grandamenium/cortextos/pull/717 — Opus-approved, build green. 3 MINOR issues, all in gated scaffold code (Clearpath push/export schema mismatch, dry-run over-count, same-basename overwrite) — reconcile at staging, none block merge. WS10 activity-ledger confirmed in the diff.
- **Batch C → PR #719** — WS7 instance-default landed CLEAN (mergeable). WS6 context-diet hit the same ~80-file conflict-bomb and WS12 was blocked behind it — both NEED individual redo in a fresh clone. https://github.com/grandamenium/cortextos/pull/719

## REDO PASS (run each ALONE in a fresh clone — broad workstreams conflict when batched)
- WS4 fleet-reconcile (in-scope + daemon auto-trigger) · WS6 context-diet · WS12 coding-agent defaults. Plus #718 minor fixes (WS2 stop-flag writer, WS3 JSON-envelope preview). Root-cause lesson: broad-refactor workstreams are conflict bombs when batched; isolate them.

## Prod-ops to run AFTER the relevant PR merges (Josh-gated, staging-first)
1. **WS11 — rebuild dist + reload frank2** → kills the "🚨 CRASH … died unexpectedly" spam. The fix is already in source; dist was never built. `npm run build` + `cortextos restart frank2 --instance cortextos1`, then verify dist has the worker-guard + confirm no phantom page. RECOMMEND FIRST (stops active pain, ~1 min).
2. **WS5 — run the Clearpath export + re-embed** the ~2,700 high-value meeting rows into MMRAG at 768d, then re-enable the nightly kb-ingest (now fail-loud).
3. **WS9 — run the contact backfill** (crm 291 → Clearpath 651) and switch on the Clearpath→crm push.
4. **WS7 — instance cutover**: flip the ACTIVE_INSTANCE marker to cortextos1, take the first hot-state backup, then archive the dead `default` instance + stray fragments. Fleet-stopped window (whenever).

## Decisions already made (no action needed)
768d MMRAG-native embeddings · Clearpath high-value slice only (retire rest, kill Supabase later as its own project) · upstream convergence by default · WS8 = wire the opencode adapter into the worker path · Connect/crm agent = canonical entity identity · ophir kept for finance.

## Open questions for Josh (answer in the one go)
- **WS8 model routing** — how aggressively to route to cheap open-weight via OpenRouter, and any monthly spend cap? (You said "as much as possible" + "let's think about it.")
- **Merge/deploy order** — OK to merge PR #30 first (auto-deploys briefs) and confirm the tasks bug is dead on your phone before merging the cortextos batches?

## Phase-2 (post-foundation, from 06) — not built yet
Pre-meeting brief (Clearpath shape), commitment-mining finish-wire, ophir+Moxie, weekly-review upgrade, onboarding-discovery (Chase), building-in-public publish. Stashed: content-publish, agency-installer (Docker/one-click + provisioning pack).

## RESOLVED — Josh's answers (2026-07-03)
- **WS8 model routing = FAILOVER ONLY for now.** Keep everything on Claude; use OpenRouter only when Anthropic rate-limits hit. Batch A still builds the adapter plumbing (needed for failover); broad cheap routing stays OFF until Josh sees open-weight quality.
- **WS11 crash-fix = DONE ✅ + verified** — dist rebuilt (guard present, was 0), frank2 reloaded and running. Crash spam fixed at the artifact level.
- **Prod-ops pre-approved: WS5 (Clearpath export + re-embed) ✅ and WS7 (instance cutover) ✅** — run after their PRs merge, staging-first + verified.
- **WS9 contact backfill = SKIP (Josh's instinct validated).** Real delta is only 102 (not ~360): 4 strong (marginal — RRK/Rethink dupes + Logic-TCG ex-employer), 65 unusable (encrypted emails), 33 junk (self, demo, bots). Not worth importing into the canonical CRM. Full list: 10-ws9-backfill-contacts.md. NOTE: this only drops the contact-backfill RUN — WS5 meeting-intel export (~2,700 gold rows) and the WS9 CODE (sync-board flip + canonical id) still stand.
- **Merge policy = Josh reviews + merges each PR himself** — nothing auto-merges. Order: merge PR #30 first (auto-deploys briefs, confirm tasks bug dead on phone), then the cortextos batches.
