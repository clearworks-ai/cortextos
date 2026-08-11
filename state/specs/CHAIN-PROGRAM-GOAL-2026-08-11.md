# /goal condition — Meeting-Intelligence Chain PROGRAM (Specs 1–3) — 2026-08-11

Paste the block below into `/goal`. Backing plan: this file's SUB-PHASES + trackers.

---

GOAL: Finish the meeting-intelligence chain PROGRAM (Specs 1-3) in `/Users/joshweiss/code/cortextos` (remote `clearworks-ai/cortextos`; prod runtime `~/.cortextos/cortextos1`; staging `cortextos-staging` via `scripts/staging/`). READ FIRST: `state/CHAIN-COMPLETION-2026-08-10.md` + `state/specs/event-driven-and-cron-modernization-spec-2026-08-10.md`.

STANDING RULES:
- STAGING-FIRST (non-negotiable): prove any control-plane (daemon dispatch, lane flip, cron rewire) or data-plane (client `.md`, crm/*.jsonl, pipeline.json) change on `cortextos-staging` (cwd=FW_ROOT, PIN `CTX_INSTANCE_ID=cortextos-staging` on EVERY call — bare = PROD) before any prod effect.
- VERIFY BEFORE FIXING: reproduce against live code/data first; a fix with no failing repro is a phantom, don't write it. FR-C4 is a confirmed non-issue (`a-b/N` gap hits zero live crons) — do NOT fix.
- NEVER reintroduce the ÷200K window guess: measure codex context vs runtime-reported `context_window_size`, never a model→200K table (the #353 fleet-bootloop regression).
- Dev loop: branch off origin/main → `npm run build`+`npm test` green → PR `--repo clearworks-ai/cortextos` → CI green → merge main. No `/stage`/`/promote`. Never `git checkout/reset/clean` main checkout.
- LIVE RECEIPT = a REAL fireflies meeting through the RUNNING prod daemon yielding all 4 artifacts, true-verified w/ path+line+ts: (1) bus task (+approval if client-facing) FR-004; (2) crm interaction row (+pipeline deal-stage if sales) FR-007; (3) recap doc+OUR/THEIR tracker FR-005; (4) deal-debrief if sales FR-006. Test-green is NOT a receipt.
- PROD RESTART = `pm2 restart cortextos-daemon` — JOSH-GATED, never auto-run.
- PARALLELISM: independents run CONCURRENTLY, each own worktree+builder — never one at a time; spawn every ready lane before blocking.

SUB-PHASES (lowest unshipped; independents fan out):
P1 [indep] Merge Spec-2 backbone #354 (FR-E1 worker-spawn-plan, FR-E2 shadow flag). DONE: CI green, merged, lanes still default shadow.
P2 [needs P1] Merge Spec-2 Gmail lane #357 (replacement for auto-closed stacked #356; FR-E3 active gmail→comms-check-worker). DONE: rebased post-#354, CI green, merged, gmail still shadow (flip=P6).
P3 [indep] Merge Spec-3 #355 (FR-C4 non-issue; FR-C2 `nightly-fleet-scan.py` pattern+tests). DONE: CI green, merged, live cron not yet rewired (=P7).
P4 [indep] Prod live receipt (daemon armed). DONE: a REAL meeting yields all 4 artifacts per LIVE RECEIPT rule, recorded in tracker.
P5 [needs P4] Retire 2 dupes #349 (frank2 meeting-commitments-worker + crm blanket-followup). DONE: P4 confirms coverage (fanout BRIEFS==old worker; crm-sync upsert==old ingest minus abbey blanket), CI green, merged.
P6 [needs P2,P4,GATED] Activate Gmail: staging-validate active spawn, then flip gmail→active + retire pa comms-check poll in SAME change. DONE: staging shows spawn, no double-fire vs poll, then gated prod flip.
P7 [needs P3,GATED] Roll out FR-C2 cron: staging-validate scan candidates vs current output, then rewire live cron (`cortextos bus update-cron`) to deterministic core+thin verify. DONE: staging parity, then gated rewire.

DONE: P1-P5 merged + true-verified from this session's output (CI logs, staging receipts, P4 receipt — not assumed); P6-P7 rolled out via gated flips; 2 dupes retired. Update `state/CHAIN-COMPLETION-2026-08-10.md` as each clears.

AUTONOMY: build + PR + merge-to-main (after CI green) PRE-AUTHORIZED — run unattended, don't pause to confirm PRs. HALT only on: (1) gate fails (CI red, absent live receipt, staging mismatch) — report sub-phase+diff+error, no silent fix-forward; (2) spec ambiguity — ask; (3) any prod-promote needing the gated restart, a P6/P7 flip, or the #349 merge — await Josh.
