# 01-research — frank2-reboot-reliability

## Incident
frank2 disabled via `cortextos disable frank2` at 2026-07-26T01:37Z. Prior diagnosis (subagent
a10131c9552a9ce8f) characterized the failure as: ~1min uptime per cycle, context regrowing
75K→149K tokens per reboot, ~880K cache_creation tokens burned, and proposed two candidate
causes: (a) `--continue` reloading full conversation history on every restart, defeating any
context reduction, or (b) a context-threshold misconfiguration (frank2's config.json has
`ctx_warning_threshold: 70` / `ctx_handoff_threshold: 80` vs larry's 60/70).

A separate, already-merged PR (#144 "fix/cron-register-reliability", commit `4131b6b`, merged
2026-07-25T21:56:02Z) landed FM-9 "preserve in-flight cron identity on reload-while-firing"
plus reload-verify / instance-guard / cron-liveness work. frank2's loop continued well after
that merge, so the task was to determine whether it's unrelated or whether #144 was incomplete.

## Method
Read the real daemon source (`src/daemon/agent-process.ts`, `src/daemon/agent-manager.ts`,
`src/daemon/fast-checker.ts`, `src/pty/agent-pty.ts`, `src/bus/system.ts`,
`src/daemon/cron-liveness.ts`) and cross-referenced against frank2's live, on-disk evidence:
`~/.cortextos/cortextos1/logs/frank2/{restarts.log,crashes.log}`,
`~/.cortextos/cortextos1/state/frank2/{context_status.json,cron-state.json,.ctx-circuit.json}`,
and `orgs/clearworksai/agents/frank2/config.json`.

## Findings

1. **`--continue` does reload full history on every restart** — confirmed both by
   `agent-pty.ts:222-232` (`buildClaudeArgs`: `mode === 'continue'` → `args.push('--continue')`)
   and by the in-repo image-poison comment at `agent-process.ts:851-856` ("every `--continue`
   restart reloads the same conversation history and re-hits the same 400"). This part of the
   prior hypothesis is correct as a mechanism, but is not by itself sufficient — the fast-checker
   context-handoff mechanism (`checkContextStatus` / `forceContextRestart`,
   `fast-checker.ts:1480-1822`) already pre-arms `.force-fresh` before every restart it
   triggers, which makes `shouldContinue()` (`agent-process.ts:953-969`) return `false` and
   avoid `--continue`. Its restarts show up correctly in `crashes.log` as
   `type=planned-restart reason=context handoff at N%` and are not, on their own, looping.

2. **The `ctx_warning_threshold`/`ctx_handoff_threshold` 70/80-vs-60/70 question is real but not
   this incident's cause.** `git log --all -p -- orgs/clearworksai/agents/frank2/config.json`
   shows `max_session_seconds`/`ctx_warning_threshold`/`ctx_handoff_threshold` have never
   changed since the file was added — no misconfiguration event correlates with the loop's
   onset. Separately, per the task brief, this file is git-tracked and any live edit risks
   clobber on next sync — a fix living in daemon logic is required regardless.

3. **The actual mechanism: `checkCronLiveness()` (`fast-checker.ts:1206-1266`), added by PR
   #144 Phase 6.** Live evidence:
   - `crashes.log` shows `type=session-refresh reason=session-time-cap rollover` entries at an
     almost exact 15-minute cadence starting at 2026-07-25T21:56Z (PR #144's merge minute) —
     e.g. 01:19:46 → 01:34:50 → 01:37:14 (the final, sub-3-minute gap is where control was
     lost, right before disable).
   - `state/frank2/cron-state.json`: the `pre-meeting-brief-page` cron (15m interval per
     frank2's config) has `last_fire: 2026-07-12T07:50:59Z` — 13+ days stale. This is a
     separate, pre-existing cron-dispatch bug (out of scope here) that `checkCronLiveness()` is
     correctly detecting as overdue.
   - `checkCronLiveness()`'s escalation (line 1264-1265) calls `this.agent.sessionRefresh()`
     directly — no `hardRestart()` call first, no circuit breaker. Its own governing spec
     (`.agent/one-big-feature/cron-register-reliability/03-specs/04-fastchecker-cron-liveness.md`,
     "Change 2") says to reuse "the same entry the loop-stall watchdog uses" and "count it
     against the EXISTING circuit breaker" — neither happened in the shipped code. Compare
     `forceLoopStallRestart()` (~1378-1397) and `forceContextRestart()` (~1749-1822), both of
     which call `hardRestart(...)` (fresh restart, `.force-fresh`) before `sessionRefresh()`
     and both of which persist a 3-in-15min circuit breaker
     (`stallCircuitBrokenAt`/`ctxCircuitBrokenAt` + `.stall-circuit.json`/`.ctx-circuit.json`).
   - Net effect: because the agent restarting cannot fix why `pre-meeting-brief-page` stopped
     updating its own fire timestamp, the cron is still overdue on the very next check, and
     `checkCronLiveness()` re-escalates every 15 minutes (its only throttle) — forever, with no
     circuit breaker to stop it. Every escalation is a bare `sessionRefresh()`, i.e. `--continue`,
     reloading and re-accumulating the same growing conversation history each time. This is the
     token-bleed and the reboot loop.
   - This is a bug newly introduced by PR #144 Phase 6, not a pre-existing issue PR #144 should
     already have closed — the timeline (merge → onset, to the minute) confirms it.

## Conclusion
Root cause = (c) from the task brief: "something else entirely — a specific frank2 cron/tool
call that spikes tokens immediately post-boot," refined to: a specific NEW daemon watchdog
(`checkCronLiveness`, PR #144 Phase 6) whose escalation path both (a) uses `--continue` instead
of a fresh restart and (b) has no circuit breaker, unlike its two sibling watchdogs in the same
file. See `02-master-plan.md` for the fix design and `03-specs/01-cron-liveness-circuit-breaker.md`
for the exact diff.
