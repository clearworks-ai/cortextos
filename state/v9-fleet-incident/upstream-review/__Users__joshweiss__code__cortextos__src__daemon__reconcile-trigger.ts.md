# Upstream-review deep pass: src/daemon/reconcile-trigger.ts

**File status vs upstream/main:** FORK-ONLY. Does not exist in upstream (`git cat-file -e upstream/main:src/daemon/reconcile-trigger.ts` → not found). Entire 446-line file is fork divergence. Whole file read + all callers/helpers traced.

**Commit history (git log --follow):**
- `e1d45f7` 2026-07-03 — feat(daemon): WS4 fleet reconcile + drift alarms with daemon auto-trigger (#50) — file created
- `f516311` 2026-07-12 — fix(daemon): task-ownership Phase 1 — apply-mode orphan reclaim (#100)
- `f7879aa` 2026-07-12 — feat(tasks): task-overhaul Phase 2 — due sweep + resurface/stall-escalate (#101)
- `828811c` 2026-07-18 — feat(experiments): forced-decision sweep for expired experiment windows

**Wiring:** `src/daemon/index.ts:276-281` — constructed and `.start()`ed at daemon boot. First pass 90s after boot (`INITIAL_DELAY_MS`, reconcile-trigger.ts:52), then every 15 min (`DEFAULT_RECONCILE_INTERVAL_MS`, :49). Timers unref'd (:242,:245). Re-entrancy guarded (:268).

---

## Divergence-by-divergence analysis

### D1 — Entire reconcile pass runs SYNCHRONOUSLY on the daemon main event loop
- **What:** `runOnce()` (reconcile-trigger.ts:267-319) is 100% synchronous fs work executed on the daemon's single event-loop thread: `gatherDeclaredAgents` (:91-137) readdirs every `orgs/*/agents/*`, JSON-parses every `config.json` (:119) and parses every agent `.env` (:73) per pass; then the reclaim, due-sweep, and experiment-sweep passes each re-read state (below).
- **Introduced:** `e1d45f7` 2026-07-03 (base); cost multiplied by `f516311`/`f7879aa` 2026-07-12 and `828811c` 2026-07-18 (blame confirmed on runOnce lines 289-309).
- **Instability:** While `runOnce` executes, the daemon cannot service IPC, drain PTY output, tick heartbeat/readiness checks, or handle signals. Worst case is bounded but real: see D2's blocking lock. Every 15 min the daemon takes a synchronous fs-scan freeze proportional to fleet size + task-dir size.
- **Classification:** ROOT-CAUSE-INSTABILITY (minor contributor) for the sync-on-event-loop design; the drift-*detection* payload itself is BAND-AID (monitoring for a fleet that keeps dying — upstream needs no such alarm).

### D2 — `withFileLockSync` inside the daemon thread: Atomics.wait hard-blocks the event loop up to 5s per lock, twice per pass
- **What:** `runOrphanReclaim` → `reclaimOrphanTasks(dryRun:false)` (task.ts:199-268) and `runDueSweep` → `sweepDueTasks(dryRun:false)` (task.ts:289-388) each wrap a full task-dir read-modify-write in `withFileLockSync(paths.taskDir, ...)` (task.ts:262-263, :383-384). The lock sleeps via `Atomics.wait` (lock.ts:135) — a TRUE thread block, not an event-loop yield — retrying up to `timeoutMs` default **5000ms** (lock.ts:118). The same task-dir lock is contended by every agent CLI `bus task` operation fleet-wide.
- **Introduced:** `f516311` + `f7879aa`, both 2026-07-12.
- **Instability:** Under lock contention the daemon main thread freezes for up to 5s (reclaim) + up to 5s (sweep) + per-message inbox locks in `deliverDueSweepActions` → `sendMessage` (message.ts:54,:92, inbox lock message.ts:181). During a freeze: PTY buffers back up, IPC clients time out, readiness/heartbeat logic stalls. Inside each lock it JSON-parses EVERY `task_*.json` (`readAllTasks`, task.ts) — unbounded with task-count growth.
- **Classification:** ROOT-CAUSE-INSTABILITY (moderate, bounded). Not the orphan-pty leak, but a genuine periodic daemon-thread stall upstream does not have.

### D3 — Daemon mutates shared bus state off a liveness signal that is known-wrong
- **What:** `runOrphanReclaim` (reconcile-trigger.ts:332-362) computes `liveAgents` from `manager.getAllStatuses()` filtered to `'running' || 'starting'` (:337) and calls `reclaimOrphanTasks` with **dryRun:false** (task.ts:347 caller path; task.ts:208 `dryRun = options.dryRun !== false`). Any open task whose assignee is not in that set is silently reassigned (`non_live_agent`, task.ts:245) to `frank2`/`larry` defaults (task.ts:44-45) with an `atomicWriteSync` (task.ts:254).
- **Introduced:** `f516311` 2026-07-12 (blame lines 289-295).
- **Instability:** Two confirmed failure modes make the signal wrong: (a) status='running' asserted before REPL renders (agent-process.ts:297) — loop-dead agents count as live, so their tasks are NEVER reclaimed (defeats the feature, benign to stability); (b) the confirmed 2026-08-01 in-memory-registry desync incident — a genuinely LIVE agent absent from the registry has ALL its open tasks yanked every 15 min. Also: any agent mid-restart at the 15-min tick (status 'stopped'/'error') loses its tasks. This is silent state churn driven by a stale signal — exactly the mutable-fact-as-truth failure class. Note the daemon wiring comment (index.ts:270-274) still claims the trigger is "READ-ONLY — never restarts or mutates agents" — FALSE since 2026-07-12; the doc/behavior divergence hides the mutation from anyone auditing index.ts.
- **Classification:** BAND-AID (compensates for agents dying/leaving orphan tasks) **that introduces secondary instability** (state churn off stale liveness). It is not the root wound but it amplifies wrong-liveness bugs into bus mutations.

### D4 — Due sweep + per-task message delivery from the daemon
- **What:** `runDueSweep` (:364-395) writes `resurfaced_at`/`escalated_at` (task.ts:378-380) and `deliverDueSweepActions` (task.ts:390-419) sends one inbox message per action. Bounded: 24h resurface cooldown (task.ts:55), 4h stall gate w/ escalated_at check (task.ts:54,:349-355), 20-action cap (task.ts:56).
- **Introduced:** `f7879aa` 2026-07-12.
- **Instability:** Well-gated against message storms; main cost is the second lock/scan (folded into D2). Error-swallowed per action.
- **Classification:** NEUTRAL-FEATURE (with D2's lock cost).

### D5 — Experiment sweep + flag messages
- **What:** `runExperimentSweep` (:397-445) runs `sweepExperiments(dryRun:false)` per declared agent and `sendMessage`s a nag per flagged experiment (:426-432), all sync on the daemon thread.
- **Introduced:** `828811c` 2026-07-18.
- **Instability:** More sync fs + inbox-lock work per pass; per-agent errors swallowed to console (:409-412).
- **Classification:** NEUTRAL-FEATURE.

### D6 — Hardcoded `DEFAULT_KNOWN_OFF = ['hunter']` (:46) and blanket error swallowing (:311-315)
- **Introduced:** `e1d45f7` 2026-07-03.
- **Instability:** knownOff hardcode is policy-in-code, harmless. Pass-level catch means a persistently failing reconcile (e.g. 5s lock timeout throwing every pass) degrades to silent console spam — monitoring dies quietly, no meta-alarm. Minor.
- **Classification:** NEUTRAL-FEATURE / minor error-swallowing smell.

---

## Verdict: root wound or band-aid?

**Primarily BAND-AID with self-inflicted secondary instability.** The file exists BECAUSE the fork's fleet drifts/dies (drift alarms, orphan-task reclaim, stall escalation are all compensations upstream runs fine without). It does NOT cause the orphan pty-host leak, the premature status='running', or the overnight posix_spawnp exhaustion — the root wound is elsewhere (spawn/PTY lifecycle). BUT it adds two real instability vectors of its own:

1. **D2** — `Atomics.wait` file-lock blocking of the daemon main event loop up to ~10s+ per 15-min pass under contention (`f516311`/`f7879aa`, 2026-07-12) — periodic daemon freezes that worsen PTY backpressure and IPC timeouts fleet-wide.
2. **D3** — dryRun:false bus mutation keyed off the daemon's in-memory liveness, which is documented-wrong in two ways (early 'running' assert; registry desync) — silent task-ownership churn every 15 min when liveness lies (`f516311`, 2026-07-12).

**Oldest instability-introducing hunk:** `e1d45f7` 2026-07-03 (sync fs-heavy pass on the daemon event loop); the materially riskier hunks are `f516311` + `f7879aa`, both 2026-07-12 (blocking locks + apply-mode mutation).

**Recommended for the re-baseline:** drop this module entirely (upstream has none) or, if kept, (a) move all passes off the daemon main thread / make them a spawned worker, (b) never mutate task ownership from daemon-internal liveness — require a second independent liveness source, (c) fix the false "READ-ONLY" comment at index.ts:270-274.
