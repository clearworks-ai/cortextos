# Spec 03 — F8: cap the --continue full-history reload (planned fresh-rollover)

Effort M-L. Blast radius HIGH (daemon restart lifecycle, whole fleet). Adversarial review MANDATORY. Ship OPT-IN.

## Ground truth
- session-time-cap rollover = startSessionTimer() (agent-process.ts:1373-1415, default 71h) → sessionRefresh() (456-478) writes .session-refresh marker then stop()+start() → shouldContinue() sees JSONL → --continue full reload (the 100k+ cache_creation spike). THIS existing mechanism is the CAUSE of the recurring reload — F8 EXTENDS sessionRefresh(), does not add a parallel mechanism.
- User soft restart does NOT go through sessionRefresh (IPC restart-agent → AgentManager.restartAgent, agent-manager.ts:1080-1088) — so gating inside sessionRefresh cannot break the user soft=keep-history contract.
- Fresh-start machinery all exists: .force-fresh (shouldContinue 962-969), mission anchor+live tail (buildResumeContextBlocks 1123-1156), handoff-doc (.handoff-doc-path → consumeHandoffBlock 1279+), hardRestart (bus/system.ts:78). 90% path (fast-checker checkContextStatus 1480-1742) UNTOUCHED.

## Decision rule (only inside sessionRefresh) — go FRESH not --continue when EITHER:
1. continuesSinceFresh >= config.fresh_rollover_max_continues (default 3, undefined=OFF), OR
2. state/<agent>/context_status.json written_at <10min old AND used_percentage >= config.fresh_rollover_ctx_pct (default 40 — below the 60% handoff, closes the gap).

## Counter: state/<agent>/session-rollover.json {lastFreshAtMs, continuesSinceFresh}, atomic-written in start() after mode determination (210-215): fresh→0, continue→increment. Counts crash recoveries toward next planned rollover but NEVER converts a crash restart to fresh (avoids thrash).

## Fresh-rollover execution: injectMessage [PLANNED FRESH ROLLOVER] (write handoff to memory/handoffs/, refresh current-mission.txt, ≤5min), poll findFreshRecentHandoffDoc 10s×5min (callers are fire-and-forget .catch, blocks nothing). On found: write .handoff-doc-path. Either way: ensureMissionAnchorFromBuffer + hardRestart('CONTEXT-FORCE-RESTART: F8 fresh rollover') + keep .session-refresh. Then existing stop()/start() — .force-fresh → buildStartupPrompt (anchor+tail+handoff included).

## Exact changes
- src/types/index.ts (~164 AgentConfig): add fresh_rollover_max_continues?/fresh_rollover_ctx_pct? (undefined=off).
- src/daemon/restart-context.ts (NEW): move ensureMissionAnchorFromBuffer + deriveMissionFromTrailingInbound + findFreshRecentHandoffDoc (fast-checker.ts:60-79+) here exported — avoids import cycle (fast-checker imports agent-process).
- fast-checker.ts: import the moved fns; call sites 1689/1767/1779 unchanged.
- agent-process.ts:456-478 sessionRefresh: insert decision + cooperative-handoff + hardRestart between marker write and stop(). Add rolloverInProgress guard.
- agent-process.ts:210-215 start: read/update session-rollover.json.
- tests: pure decision-fn matrix (count/pct/config→fresh|continue) + counter round-trip.

## Risks: in-flight context loss (mitigated by 3 layers: handoff doc + anchor + live tail — same contract as Tier-3 today; optional: postpone fresh if current-mission.txt <2h old, take another --continue). Restart machinery scar tissue (BUG-011/040/048) — add no new timers/paths. Synchronized rollovers — note, don't build jitter v1.

## Verification: build+test; canary scout max_session_seconds:600 + fresh_rollover_max_continues:1 (hot-read) → cycle1 --continue counter=1, cycle2 fresh + handoff doc + counter reset + clean crashes.log + "restarting with memory" telegram + context_status at floor. Regression: drive Tier-2 handoff (ctx_handoff_threshold:5) identical to pre-change. 3+ rollover soak over 2 days. Enable opt-in on frank2 first.
