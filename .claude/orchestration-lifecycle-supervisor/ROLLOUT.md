# Agent Lifecycle Supervisor — Rollout, Canary, and Soak Plan

**Status: PROPOSAL ONLY. NOT EXECUTED.**
**Written**: 2026-09-13 · Task 5.7 (final task, Phase 5, of the 39-task lifecycle-supervisor build)

---

> ## ⚠️ THIS DOCUMENT IS A PLAN ONLY.
> **No agent adoption, canary flip, soak execution, or cron guidance change described in this document may be carried out without Josh's separate, explicit, after-this-document sign-off.** Producing this plan is Task 5.7's entire scope. Nothing below has been run against the live daemon, no live agent's config has been touched, no live cron file has been edited, and no code from this branch has been merged or pushed. Every action item below is a recommendation awaiting a human decision, not a completed step.

---

## 1. Precondition: Task 5.6's clean-environment gate

This plan is conditioned on Task 5.6's ledger. Recorded in `PROGRESS.md` ("Phase 5 Final Gate" section, and the Phase 5 row of the Phase Overview table):

- **SHA verified**: `e9150a66` (also the current branch tip referenced by this document, and the tip at the time of this writing — see §7 for why the actual deployment target must be re-confirmed at execution time, not assumed to still be this SHA).
- **Result**: `npm run typecheck` clean, `npm run build` clean, full `npm test` — **297 passed / 2 failed / 3 skipped files (302)**, **4151 passed / 3 failed / 27 skipped / 5 todo tests (4186)**.
- **The 3 failures**: all reconfirmed transient/pre-existing, not introduced by this build:
  1. `tests/unit/daemon/fast-checker.test.ts` — 2 sub-tests, host-load-contention-dependent; 110/110 clean in isolation.
  2. `tests/unit/pty/pty-host-dispose.test.ts` — 1 sub-test (CONTROL case), a real-clock/OS-timing artifact of this specific machine's process-reaping, documented since Task 1.4, zero Phase 1-5 commits touch the file.
- **#372/#384/#386 regressions**: explicitly re-verified green (Telegram poll cancellation, descendant snapshot/sweep + alert-only wedge, watchdog heartbeat identity).
- **3 deliberately-deferred `it.todo()` gaps** (not failures — honestly documented open items, carried into this plan as known limitations — see §8):
  1. `AgentProcess.handleExit()`'s `daemonShuttingDown`/`disabled`/`planned` exit gates have no `observe()`/durable-state wiring (Invariant 4 is closed only for the `intentional`-stop gate).
  2. `AgentManager.startAgent()`'s brand-new-agent branch calls `agentProcess.start()` directly, never through `AgentLifecycleSupervisor.request()`, even when `config.supervised === true` — mechanism 9's actual recovery-start bypass (distinct from `bootSelfHeal()` and `discoverAndStart()`, both of which were found and fixed in Tasks 5.3-fix and 5.4).
  3. `src/bus/system.ts`'s `selfRestart()`/`hardRestart()` remain raw marker writers, confirmed via source-scan to contain zero `owner.request()`/`AgentLifecycleSupervisor` references.

**Conclusion**: none of the 3 unresolved items block canary selection. All three are exercised only by seams the canary agent will not touch during a routine soak (daemon shutdown / disabled / planned gates are administrative paths, not the crash/manual-stop/session-refresh/context-full paths this build's supervisor actually owns for a `supervised:true` agent; the `startAgent()` brand-new-agent branch only fires for an agent with **no** existing map entry, which does not describe an already-running canary being adopted; `selfRestart`/`hardRestart` are invoked by an agent's own tool use, not by any planned soak action below). They are carried forward explicitly as **known limitations to disclose before any real rollout** — see §8 — not silently worked around.

---

## 2. Canary selection

**Candidate: `knox`** — named directly in PRD.md §5 Open Question 4's resolved decision ("flip one agent like `knox` to supervised while the rest stay legacy"). No alternative agent is proposed; the check below confirms `knox` is still reasonable at plan-writing time.

**Reasonableness check performed 2026-09-13**:
- `knox`'s crons file (`~/.cortextos/cortextos1/.cortextOS/state/agents/knox/crons.json`) shows zero active crons (`"crons": []`) — a quiet, non-cron-driven agent, which minimizes soak-window interference from unrelated scheduled work.
- Shared-memory history (MEMORY.md) shows two `knox` incidents in the prior week (2026-09-08: a wedge-storm root-caused to workload, not code — heavy browser automation drove turn volume up ~50x and blocked on Chrome contention; and an unrelated relabeling/fabrication incident from 2026-08-10). Neither is an open/active incident as of 2026-09-13 — both are closed, diagnosed, and unrelated to the lifecycle-supervisor code path itself (one is a workload/telemetry issue, the other a content-fabrication issue in a different subsystem). Neither disqualifies `knox` as canary.
- No current mid-incident state, no fragile in-flight work, found for `knox` at plan-writing time.
- **Decision: `knox` remains a reasonable canary.** No alternative agent name is substituted.

### Adoption sequence

At no point in this sequence are both the legacy path and the supervisor simultaneously authorized to mutate `knox` — this is PRD §5's own resolved constraint (per-agent config, "No agent is ever controlled by both authorities at once"), reproduced here, not new guidance.

**(a) Clean retirement of the legacy generation first.**
Before `knox`'s `config.supervised` flag is ever flipped to `true`, its currently-running legacy-path generation must be cleanly stopped via the existing legacy `cortextos stop knox` / `AgentManager.stopAgent('knox')` path, and that stop must reach the real Task 2.6 retirement postcondition — not "signal sent," not "handle cleared," not "timeout elapsed," but the verified-absent process/PTY-host/descendant state that Task 2.6/5.2's structured retirement result actually reports. Concretely: the operator (Josh, at execution time) runs the stop, then confirms via `cortextos status knox` (or the equivalent IPC/CLI truthful-reporting surface built in Task 2.8) that the reported phase is `retired`, not `blocked`. A `blocked` result at this step means adoption does not proceed — see (c).

**(b) Record the initial desired state explicitly.**
Per PRD §2.1 ("adoption of an agent records its initial desired state explicitly"), `knox`'s supervisor record is adopted with an explicit initial `desiredState`. **Decision: the initial value is `running`** — matching `knox`'s pre-adoption state, since adoption itself must not change what the agent is doing (it was running under legacy management immediately before (a)'s clean stop; the clean stop in (a) is a mechanical precondition for changing *ownership*, not a decision to leave `knox` stopped going forward). Concretely, this is the config change: set `supervised: true` on `knox`'s `AgentConfig` (the field added in Task 2.5, `src/types/index.ts`), then the next daemon start/config reload triggers `AgentManager`'s lazy-adoption-on-first-touch (Task 1.4) to construct `knox`'s `AgentLifecycleSupervisor` and call `adopt('running', ...)` against its `LifecycleStateStore`, then start `knox` (via the now-supervised `startAgent('knox')` path) so it resumes running under the new owner.

**(c) Conflicting legacy evidence blocks adoption.**
If, at adoption time, there is a live `knox` process the store has no record of (e.g. (a)'s stop was reported `retired` but a stray legacy marker file or an orphaned legacy process is still present — checked via `cortextos doctor` / `orphan-scan.ts`, both read-only per PRD §2.6), adoption **must not proceed** — per Task 1.4's `adopt()` design, a record already existing in any state (valid, foreign-identity, or corrupt) blocks a fresh `adopt()` call rather than being silently overridden. Operationally, "blocks adoption" means: the operator (Josh) is notified via the same channel this plan itself is delivered through (Telegram, per the fleet's existing alert convention), the adoption attempt is aborted with no `supervised: true` flip committed, and the recovery step is a manual reconciliation — inspect the conflicting evidence (stray marker / orphaned process), resolve it via the legacy path's own existing tools (not the supervisor, which has no authority over `knox` yet), then retry (a)+(b) from a clean state. No automatic override, no guessed generation-1 reset.

---

## 3. Soak plan

Per PHASES.md Task 5.7's own arithmetic: the canary's `max_session_seconds` is currently `255600` (71 hours, confirmed as the live value for Codex agents including `knox` in the deep dive's §2 config evidence). **The soak duration is at least 72 hours**, covering one full configured session-age cycle, unless `max_session_seconds` is deliberately shortened for an isolated leg of the test (see below).

The soak covers, at minimum:

1. **Controlled explicit start.** Following (b) above, confirm `knox` is running under the supervisor (`cortextos status knox` reports a supervised snapshot, not just a legacy status line).
2. **Controlled explicit stop.** At some point during the 72h window, issue an explicit `cortextos stop knox`, confirm the operation is reported truthfully (`accepted` + `operationId` + terminal `phase: retired`, never a bare "stopped" before verification), then explicitly `cortextos start knox --resume` to resume (a plain `cortextos start knox` without `--resume` is expected, per Task 2.8, to return `REQUIRES_RESUME` and must **not** resurrect `knox` — this is itself a soak assertion, not an aside).
3. **Controlled session-age refresh.** Two options, and this plan does not pre-select between them — that is an execution-time decision for whoever runs the soak:
   - **Option A (real window)**: let the real 71-hour `max_session_seconds` timer fire naturally within the ≥72h soak window and observe the resulting `sessionRefresh()` retire→start cycle.
   - **Option B (shortened, isolated leg)**: if a faster confirmatory test is preferred in addition to Option A, `max_session_seconds` may be explicitly lowered **for `knox`'s config only, for the duration of that isolated leg** — e.g. to `600` (10 minutes) to force several refresh cycles quickly. If this option is used: **name the exact value set, name the exact revert step** (set `max_session_seconds` back to `255600` for `knox` immediately after the isolated leg concludes, before continuing or concluding the 72h soak), and record both the change and the revert in the soak's own log, not just in this plan.
4. **A context-handoff / context-hard-full cycle**, if reachable during the window without fabricating one — i.e., observed opportunistically if `knox`'s real workload happens to approach a context-full condition during the 72h; this plan does not propose deliberately forcing Codex into a poisoned/overflowed context state, since PRD §2.5's "never fabricate" spirit for the *replay tests* (Scenario A/B) extends naturally to not fabricating an artificial failure mode against a real, live agent that Josh depends on for actual work. If it does not occur naturally, this leg is recorded as **not exercised this soak**, not silently marked pass.
5. **A deliberate retry** (e.g., a duplicate/retried dispatch through `knox`'s normal ingress — Telegram, bus message, or whatever `knox` normally receives work through) to confirm the work-ledger's `DUPLICATE = receipt`, not `DUPLICATE = delivered`, behavior (PRD §2.5) holds for a real dispatch, not just the unit/integration fixtures.
6. **A deliberate failure injection** (e.g., force a crash of `knox`'s runtime process — a real `kill -9` of the PTY child, or the least destructive real-process equivalent the operator judges appropriate at execution time) to confirm the crash-path recovery-policy budgets (Task 2.3/2.4's cause-specific backoff/daily-limit accounting) behave as documented against a real process, not a mock.

---

## 4. Soak success criteria

Per PHASES.md's explicit instruction, reproduced verbatim: **"Soak success is judged on observed turn/work outcomes and resource identities, never on heartbeat freshness alone."** This is not a stylistic preference — it is the direct lesson of the 229-restart storm (memory: `incident_wedge_detector_false_positives_and_restart_loop_2026-09-08.md`), where a fresh heartbeat was exactly the misleading signal that let a broken loop look "alive."

Concretely, for this canary, success means:

- **Every work item `knox` is dispatched during the 72h window reaches a terminal phase** (`completed` / `failed` / `cancelled`) **or an explicit `needs-review`/blocked state** visible in the supervisor's snapshot (`cortextos status knox` or the equivalent `agent-lifecycle-status` IPC read added in Task 2.8) — never simply "disappears" the way Scenario A's original bug allowed.
- **Every generation transition observed during the soak** (the session-age refresh in §3.3, the crash-recovery cycle in §3.6, and the explicit stop/start in §3.2) **shows the expected resource-release/re-acquisition sequence** — the outgoing generation's process/PTY-host/descendants/session/checker bundle reported retired (or explicitly blocked, with unresolved resources named) before or as part of the successor's start — not merely "the agent is still heartbeating" or "the agent responded to a message."
- **No control-surface false report**: at no point does `cortextos status`/`stop`/`restart`/`start` report "stopped" or "restarted" for an operation that was merely accepted; a blocked teardown (if one occurs) is visible as blocked with its unresolved resources, not silently swallowed.
- **A plain `cortextos start knox` (no `--resume`) never resurrects a contained `knox`** during any interval where `knox`'s durable desired state is `stopped`/`halted`/`quarantined` — this is the exact PRD §7 success criterion ("a maintenance `cortextos start` cannot resurrect a contained agent"), and it is the one this plan's own §6 cron-guidance draft exists to protect once the soak passes.
- Heartbeat freshness may be *consulted as one signal among several* but is **never sufficient on its own** to declare any leg of the soak a pass.

---

## 5. Expansion gate

Expansion beyond `knox` (adopting a second agent onto the supervised path) is gated on:

- The invariant suite (Task 5.1's `tests/integration/lifecycle-invariants.test.ts`, and Task 5.3's `tests/unit/daemon/lifecycle-boundary.test.ts` routing assertions) **remaining green**, re-run immediately before considering agent #2 — not assumed still-passing from Task 5.6's gate if any code has changed since.
- **A review of whether anything about `knox`'s real-world soak surfaced a gap those suites don't already cover.** If the soak surfaces such a gap (e.g., a real resource-identity edge case, a real timing race the fixtures didn't reproduce), that gap is added to the invariant suite **before** expansion — as a new test case, following the same "reproduce as a real, passing assertion, then decide fix-now-vs-documented-`it.todo`" discipline this build has used throughout Phase 5 — never worked around ad hoc for agent #2 alone.
- No fixed number of agents or timeline is proposed for expansion beyond `knox` in this document; that is a separate future decision, informed by the actual soak's outcome, not pre-committed here.

---

## 6. Draft cron guidance change (draft only — NOT applied to the live file)

**Target file** (not touched by this task or this build): `/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/frank2-codex/crons.json`, the `heartbeat` cron (currently `enabled: true`, `schedule: "4h"`, live content read 2026-09-13).

**Current live prompt** (relevant clause, verbatim from the live file): *"Review agent fleet health: `cortextos bus read-all-heartbeats` — any agent silent >5h, attempt restart via `cortextos start <name>` and alert Josh via Telegram 6690120787 if restart fails."*

**Why this needs to change once `knox` is supervised**: Task 2.8 makes a plain `cortextos start <name>` against a `halted`/`quarantined`/blocked supervised agent return a structured `REQUIRES_RESUME` blocked reason instead of resurrecting it (confirmed in the live source: `src/cli/start.ts` line 222 checks `response.code === 'REQUIRES_RESUME'`). Once `knox` is supervised, frank2's cron, as currently written, will hit exactly this case if `knox` is ever found stale while intentionally halted/quarantined/stopped — and the current prompt has no instruction for what to do with that structured response; it will either misreport a no-op as a failed restart, or (worse) an agent using `--resume` reflexively could clear an operator-intended HALT/quarantine that frank2 has no business clearing autonomously.

**Decision (a real operational judgment call, stated explicitly, not a mechanical translation)**: frank2 is **not** granted blanket authority to `--resume` a supervised agent it finds silent. A plain stop is different from a HALT/quarantine in intent — a plain stop could plausibly be a forgotten maintenance action frank2 clearing is low-risk, whereas HALT/quarantine are deliberately escalated containment states (per PRD §2.7, quarantine additionally requires a successful resource reconciliation before resume, which is not something an unattended cron should attempt). **This plan proposes**: frank2's cron may attempt `cortextos start <name> --resume` only when the structured response identifies the prior state as a plain `stopped` (not `halted`/`quarantined`); for `halted`/`quarantined`, frank2 reports the structured blocked reason to Josh via the existing Telegram alert path and takes no resume action.

**Proposed diff (prose, for `frank2-codex`'s `heartbeat` cron `prompt` field)** — replacing the one clause above:

> *"Review agent fleet health: `cortextos bus read-all-heartbeats` — any agent silent >5h, attempt `cortextos start <name>`. If the response is a plain success, done. If the response reports `REQUIRES_RESUME` with prior state `stopped`, retry as `cortextos start <name> --resume` and note in your event log that you cleared a plain stop. If the response reports `REQUIRES_RESUME` with prior state `halted` or `quarantined` (or reconciliation-pending for quarantine), do NOT pass `--resume` — this is a deliberate containment state, not a stale maintenance gap. Instead alert Josh via Telegram 6690120787 with the exact structured blocked reason and the agent name, and take no further restart action on that agent this cycle."*

**This diff is not applied to the live `frank2-codex/crons.json` file by this task or this build.** It is a proposal for Josh (or a future explicitly-approved task) to apply, and only makes sense to apply once `knox` (or any agent) is actually flipped to `supervised: true` — applying it earlier is harmless but pointless, since no agent currently returns `REQUIRES_RESUME` until at least one is supervised.

`sage-codex`'s `fleet-health-check` cron requires **no** guidance change: its live prompt (read 2026-09-13) only reads heartbeats and alerts `frank2` — it contains no `cortextos start`/restart action of any kind, so it remains a pure observer under PRD §2.6/§2.8 with no back-door risk from this cutover.

---

## 7. Deployment target

Canary deployment (the `supervised: true` config flip and the daemon restart that picks it up) **must target the exact reviewed/merged commit SHA that Task 5.6's ledger verified — currently `e9150a66` — never an uncommitted working tree.** Concretely: `feat/lifecycle-supervisor` (or whatever branch/tag it is merged to by execution time) must be the checked-out, committed state the daemon is restarted against; `git status` must be clean (no staged or unstaged diffs) at the moment of restart. If any commits land on this branch between this document's writing and execution, the deployment target is **that later verified SHA**, re-confirmed against a fresh regression gate equivalent to Task 5.6's — not silently assumed to still be `e9150a66`.

This build has not been merged to `main` and has not been pushed to `origin` as of this writing (`git log` shows 34 commits ahead of `origin/main`, unpushed). Merging to `main` is itself a separate, Josh-approved action this plan does not perform or schedule.

---

## 8. Known limitations to disclose before any real rollout

Before Josh authorizes any step in §2-§7, the following should be explicitly re-surfaced (they are not new — they are Task 5.1/5.3/5.5's own honestly-documented deferred gaps, repeated here per this task's own instruction):

1. **Daemon-shutdown / disabled / planned exit-observe wiring gap** — `AgentProcess.handleExit()`'s `daemonShuttingDown`, `disabled`, and `planned` gates do not call `observe()` / update durable state at all. A daemon restart or an explicit disable of `knox` during the soak window will not be recorded as an observed lifecycle event the same way a crash or manual stop is. This does not invalidate the soak (durable desired state itself is still correctly preserved across daemon shutdown per Task 2.5 Step 6), but it means these three specific exit paths are **not** covered by Invariant 4's "every exit updates observed state" guarantee yet.
2. **`AgentManager.startAgent()`'s brand-new-agent-branch bypass** — if `knox`'s map entry is ever fully absent (not just stopped) and `startAgent('knox')` is called, the brand-new-start path calls `agentProcess.start()` directly rather than through the supervisor, even with `supervised: true`. This is distinct from the `bootSelfHeal`/`discoverAndStart` resurrection gaps already fixed in Tasks 5.3-fix/5.4, and remains open. It would only matter for `knox` if its map entry were removed entirely (not merely stopped) and then restarted — not a step this plan's soak performs, but a real gap to know about.
3. **`bus/system.ts`'s `selfRestart()`/`hardRestart()` remain unrouted raw marker writers.** If `knox` (or any agent) invokes its own `cortextos bus self-restart` or `hard-restart` from within its own tool use, that call bypasses the supervisor entirely. The one place this mattered in practice, `FastChecker.forceContextRestart()`, already sidesteps this by calling the real routed `sessionRefresh()` directly — but a manual or agent-initiated `bus hard-restart` invocation against `knox` during the soak would not be supervisor-mediated. This plan does not propose exercising that path as part of the soak, precisely because it is a known unrouted seam.

None of these three block the canary decision (per §1's conclusion), but all three should be read by Josh as part of the sign-off, not discovered later.

---

## 9. Summary checklist (PHASES.md Task 5.7 acceptance criteria, restated)

- [x] Canary is **one** selected agent (`knox`), to be supervised only after clean retirement of its legacy generation and an explicitly recorded initial desired state (`running`) — see §2.
- [x] No simultaneous legacy and supervisor mutation paths for the same agent at any point — see §2's adoption sequence.
- [x] Soak plan covers controlled start/stop/refresh/context/retry/failure cases and at least one configured session-age cycle (≥72h, or an explicitly-named-and-reverted shortened isolated leg) — see §3.
- [x] Soak success is judged on observed turn/work outcomes and resource identities, never on heartbeat freshness alone — see §4.
- [x] Expansion beyond the canary is gated on invariants remaining intact — see §5.
- [x] The approved guidance change for the frank2 `heartbeat` cron is drafted here; the live cron file is not edited — see §6.
- [x] Deployment targets the reviewed SHA (`e9150a66`, or a later re-verified SHA), never a working tree — see §7.
- [x] **Execution requires Josh's separate sign-off and is not performed as part of this task.**

---

> ## ⚠️ REMINDER
> **This document is a plan only. No agent adoption, canary flip, soak execution, or cron guidance change described here may be carried out without Josh's separate, explicit, after-this-document sign-off.**
