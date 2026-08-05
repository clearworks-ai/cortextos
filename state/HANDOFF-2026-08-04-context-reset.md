# SESSION HANDOFF — 2026-08-04 ~11:20 PDT (context reset)

Long session (overnight build + all-morning daemon debugging). Reset clean; this is the state.

## ✅ DONE (merged on origin/main, verified)
- **6 Phases P1–P6** — all receipted + merged.
- **Loops** — LOOP1 (back-ping cut #285; rest of machinery was already upstream-converged), LOOP2, LOOP6, LOOP7 done. LOOP3/LOOP4 = keep-as-upstream (no cut needed).
- **Altari Phase-1: 8/8** — dashboard (#287) · KB-maintenance (#279) · meeting-decisions (#277) · scoping-gate (#286) · reliability/production-stack (#300) · EA-cluster (#304) · CRM-enrichment (#305) · delivery-status (#306). All independently reviewed + durable receipts on `receipt/<slug>` branches.
- **Daemon/reliability fixes merged** — opencode clean-exit #268, single-flight #269, crash-stderr-capture #303, parent-agent-flag #294, kb-reconcile PDF-timeout root-fix #301.
- **Deliverables** — `altari-skilltree/SYSTEM-GUIDE-AND-NEW-FEATURES.md` (the guide + preserve-manifest), `SKILLS-DORMANT-VS-AUTOMATED.html` (sent to Josh), `PROACTIVITY-INTEGRATION-MAP.html`, `CLIENT-ROSTER-AND-PHASES.md`, the `DESIGN-*.md` docs.

## 🔴 OPEN — Josh's decisions (do NOT act without his word)
1. **REBUILD FROM UPSTREAM** — Josh is weighing nuking the fork + rebuilding clean from upstream + product-only (his convergence doc's own conclusion). A week of incremental convergence failed. Preserve-manifest = GUIDE §2-3; drop = the ~130 daemon/ledger compensators (§4). If he calls it: produce the exact preserve manifest first.
2. **#302 (1M + 60-70% window)** — Josh wants 1M window + handoff/restart at 60-70% (NOT compaction — a clean handoff-restart). #302 measures ctx-% vs the real model window (the mechanism). REOPENED, pending his go + a daemon deploy. `ctx_handoff_threshold=-1` currently set is a blunt suppress, not the fix.

## 🔴 OPEN — live bugs found, not yet fixed
- **Multica sync is BROKEN** — not live/real-time. No sync cron firing (last sync was 11.6h stale). Running `bus multica-sync` manually = **145 outbound pushes fail with HTTP 400**, 0 pushed. The dashboard reads the (stale) bridge, so status shows frozen. Fix = debug the 400 (Multica API request malformed?) THEN wire a ~10-min sync cron. Do NOT claim Multica live until 400s fixed + cron firing.
- **EA booking slot-time** — uses UTC hours not PT → proposed slots skew ~8h (reviewer-caught, non-blocking since drafts are human-reviewed). Quick fix queued.
- **wedge-watchdog #281** — a symptom-patch that merged against the "hold" call; flagged for removal (LOOP1 doesn't supersede it since the machinery was already converged).

## SYSTEM STATE
- **13 agents** live (auditmaster codexer crm frank2 knox-codex larry maven muse opencode ophir pa sage scout). **knox (claude) REMOVED** — knox-codex is canonical.
- **Crash-loop RESOLVED by reboot** — exit_code=1 loop was stale daemon state; a fresh daemon (rebooted 17:22) cleared it, clean 60min+. NOT a code bug. #303 crash-capture is live if it recurs. **Reboots do NOT cause churn** (a Josh-corrected hallucination of mine).
- **Daemon fixes merged but NOT deployed** (except opencode/single-flight/crash-capture which are live) — live-promote is Josh's gate.
- Shared checkout has some leftover cruft (a stale stash `config-edits-1785864357`, an untracked lifecycle-killer dir in a worktree) — harmless, from my messy git ops mid-session.

## LESSONS (persisted to memory)
- **Never declare a root cause without CAPTURED evidence** — I hallucinated the halt/crash root 6× tonight. Confirm with a log line / stderr / diff before saying "found it." ([[feedback_never_declare_root_cause_without_captured_evidence_2026-08-04]])
- **Verify agent claims + counts before relaying** (larry/frank2 reports go stale; I miscounted agents repeatedly). `enabled-agents.json` is not authoritative for liveness.

## RESUME
Read `altari-skilltree/SYSTEM-GUIDE-AND-NEW-FEATURES.md` for the full picture. First live thing to fix if Josh wants: the Multica 400 sync bug. Biggest pending call: the upstream rebuild.
