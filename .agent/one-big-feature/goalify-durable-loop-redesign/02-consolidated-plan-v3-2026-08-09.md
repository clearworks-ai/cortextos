# Goalify Durable Loop — Consolidated Spec + Build Plan v3

**Date:** 2026-08-09 (PDT)
**Author:** Claudeman (spec/plan only; no source touched)
**Supersedes:** `01-consolidated-plan-v2-2026-08-08.md` (v2 stands as baseline — this file is additive deltas only, per Josh's 2026-08-09 02:14–02:34Z corrections). v1/v2's lineage decision, RC1–RC11, and Step 0–11 build plan all stand unchanged.
**Repo:** `/Users/joshweiss/code/cortextos`

Josh's verbatim correction (Telegram, 2026-08-09T02:34Z): *"even the gemini explore isnt specificalyl designed to check for externalr repos that should be a hard gate. look in the knowledge sync you should find research we did from larry making a build."*

This file answers three things v2 did not: (1) proves the prior Research stage skipped external prior art and turns that into a binding process gate, not just an apology; (2) supplies the actual external-repo findings that gate should have produced; (3) folds in the multi-day abandoned-task failure history Josh has lived through, as evidence for why several of v2's root causes are not hypothetical.

---

## 1. The Research-stage gate was never real — proof, not assertion

Found the artifact Josh pointed at: `.claude/orchestration-goal-run-control-plane/02-research/01-source-findings.md` and `.agent/one-big-feature/goal-run-control-plane/01-research.md` — the actual Research-stage output that produced PR #323 (`src/goals/`, the lineage this plan converges on). Read both in full. Neither contains a single external URL, OSS project name, or citation. Both are 100% internal seam-mapping: "verified existing seams" in our own `src/pty/codex-app-server-pty.ts`, our own `src/daemon/agent-process.ts`, our own `src/utils/atomic.ts`. The "Open Questions" section (7 items: acceptance-check format, retry defaults, lease TTL, thread-ID management, event retention, cross-agent scoping, cleanup policy) is exactly the set of questions mature durable-execution systems have already answered in public — and none were checked before the team picked its own defaults.

This is not a one-off miss. It's the same failure shape as [[project_p1_p6_strict_sequencing_2026-08-01]]: a same-day verbal correction ("don't skip phases") didn't hold — the identical skip recurred hours later in a different agent. Josh's own conclusion there: *"a verbal/memory fix does not hold; only a machine-enforced gate will."* Applied here: telling future-Research-stage-runners "also check external repos" will not hold either. The fix is process, not a promise.

**Binding rule, effective now, for this plan and every future M2C1/OBF Research stage on cortextOS infrastructure work (daemon, scheduler, state stores, retry/lease logic — i.e. anything with a known OSS prior-art category):**

- Research stage output is **not complete** until it contains a named external-prior-art section with real sources (URL + finding + applicability, the format used in §2 below). A research artifact with zero external citations is a stub, not a deliverable — the phase-gate check (whatever enforces P1→P6 sequencing) should treat "external prior art: none" the same as "acceptance criteria: none" — a hard block, not a warning.
- This is not "do a web search for flavor." It's: name the 2–4 nearest OSS/commercial categories (here: durable-execution engines, agent-specific goal/checkpoint frameworks, verification-before-completion patterns), pull concrete parameters (TTLs, backoff multipliers, retry counts) where they exist, and say explicitly which of our design choices those either validate, contradict, or leave as a genuine open call.
- Retroactively for this feature: §2 is that missing section, produced 2026-08-09 by a dedicated research pass (not Gemini-explore — plain web research, sourced, no fabricated citations per instruction).

---

## 2. External prior-art findings (the missing Research-stage output)

Full sourced report on file (agent output, 2026-08-09, `ac313a9db5565cbd7`). Summary, with one correction to the raw report noted below.

**Correction first:** the report assumes cortextOS's goal store is PostgreSQL-backed and recommends `UPDATE ... RETURNING` patterns. **That's wrong for us — verified directly against `origin/main:src/goals/goal-run-store.ts`.** Our store is file-based JSON (`goal-runs/{agentName}/{id}.json`), lock-serialized via `withFileLockAsync`, not a database. The *patterns* below still translate (CAS-by-token is CAS-by-token whether the substrate is a SQL row or a locked file), but any recommendation phrased as SQL needs re-expressing against our actual file+lock primitive, not lifted verbatim.

### Validated (we already do this)
- **CAS-based exclusive claim** (Temporal, Restate, DBOS all converge on this). Confirmed in our code: `goal-run-store.ts:73` — claim requires `state in {claimed,running,verifying}` false or lease expired, assigns a fresh `leaseToken`; `:81` — every mutation checks `run.leaseToken !== token` and rejects. This is the same doctrine as DBOS's "commit step + checkpoint atomically" and Temporal's replay-safe activity claim. No design change needed here.
- **Lease-expiry reclaim exists**, not just claim: `goal-run-store.ts:73` computes `expired` from `leaseExpiresAt` and allows a fresh claim to proceed with `reclaimed: expired` recorded in the event. Matches the "stale-lease reclaim" pattern research Finding 4 describes as commonly *missing* — ours has the reclaim-on-next-claim half already.
- **Verify-before-done as a structurally separate phase** (`verifying` state distinct from `running`, per v1/v2 state machine) matches the field's strongest consensus finding (Findings 6–7, and the cited academic result that self-authored/self-declared completion is unreliable — [arxiv.org/html/2607.24300v1]). This validates v1's non-negotiable "red-baseline, no self-declared done" design rather than suggesting any change.

### Gaps confirmed against real source, not assumed
- **No lease *heartbeat*.** The grep of `goal-run-store.ts` found claim + reclaim-on-next-attempt, but no renew/heartbeat call from a live worker extending its own lease mid-run. Practical effect: a long-running goal's lease can expire out from under a worker that is still alive and working, causing a second claim to race it — the CAS then makes the *second* claimant win and the first worker's subsequent writes get rejected as stale-token, which is safe but wastes the first worker's completed work. **Action for build plan:** add an explicit heartbeat call inside the goal-runner's per-turn loop (extend `leaseExpiresAt` on every turn-completion, not just at claim time). Small, concrete addition to Step 8 (stall watchdog) — the watchdog and the heartbeat are two sides of the same mechanism and should ship together.
- **No goal-level max-duration / exhaustion-by-timeout independent of retry-count.** v1/v2's retry model bounds by `maxAttempts`; nothing bounds by wall-clock. Research Finding 5 (Restate/Temporal) is explicit that unbounded wall-clock waits are a known failure class ("event starvation") distinct from "ran out of retries." **Action:** add a `maxDurationMs` field to the run record (v1's `GoalRun` interface, §3.3 data model) and a check in the same tick loop that already checks retry/attempt bounds — transition to `exhausted` on wall-clock breach even if `attempt < maxAttempts`. One field, one comparison; folds into Step 4 (acceptance-from-goal + red-baseline), not a new step.
- **Retry/backoff defaults were never pinned to a number** (v1 §4 Open Question, still open). Research gives concrete, sourced defaults to start from rather than inventing: Inngest ships 4 retries default with jittered exponential backoff; AWS Step Functions' common convention is ~8s initial delay, 1.5× multiplier. Recommend adapting (not copying, since our unit of work is an LLM turn, not an API call): **5 max attempts, 1s initial delay, 1.5× multiplier, 30s cap**, overridable per goal. Answers v1's open question with a sourced starting point instead of a guess; still tunable, not carved in stone.
- **Acceptance-check type taxonomy is currently narrower than the field's norm.** v2 already adds `pr-merged:` (from task-reconciler.py prior art). Research Finding 6 suggests rounding this out with `file_contains` / `file_json_path` / generic `command`-with-exit-code as first-class check types, since v2's Step 4 already needs a check-type registry for `pr-merged:` — cheap to make it a real taxonomy instead of a one-off.

### Explicitly NOT recommended
- **Do not adopt Temporal.** Research Finding 10, independently corroborated by three separate comparison sources (Inngest-vs-Temporal, Restate-vs-Temporal, ZenML): Temporal's determinism/replay model is built for deterministic distributed transactions, not LLM-agent turns, and the operational overhead (strict Activity wrapping, replay-safe code) is a poor fit for a system whose unit of work is inherently non-deterministic. Our file-based-store-plus-explicit-state-machine approach is closer to the DBOS/Inngest end of the spectrum, which is the correct end for this workload. No lineage change implied — this confirms v1/v2's from-scratch approach was the right call, not a shortcut that needs replacing with an off-the-shelf engine.

**What this changes in the v2 build plan:** two small additions inside existing steps (heartbeat in Step 8, `maxDurationMs` in Step 4), one answered-not-invented parameter set (retry defaults), one taxonomy generalization (Step 4's check types) — no new steps, no lineage change, no scope increase. The external check validated the architecture far more than it found holes, which is itself useful signal: this was worth doing once, cheaply, rather than skipping it and hoping.

---

## 3. Human-outcome true verification — made explicit, not implied

v2 §4 item 9 already requires an end-to-end demonstration of the prose→durable path. Josh's 2026-08-09 instruction generalizes this: **every acceptance criterion in this plan (v1's original eight plus v2's ninth) must be proven by a human-observable outcome, not a green test suite standing alone.** Concretely, for each:

- A green `npm test` proves the code path *can* run correctly under the test harness's assumptions. It does not prove the real PTY ingress, the real daemon scheduler, or the real Codex app-server binary behave the same way outside that harness — which is exactly how the Aug 7 failure hid: nothing in the test suite would have caught "the ingress is never invoked in production," because the tests exercise `create()` directly, not the `/goal` command through a live PTY session.
- **Restated verification standard for this plan's Step 2 and Step 2b (already the hard barriers in v2 §3):** proof means an actual `/goal <objective>` sent through a live PTY session on a real agent, a real run JSON inspected on disk afterward, a real `pm2 restart` performed and the run resumed afterward, and — for Step 2b specifically — a goal created from a bare shell with zero PTY input, confirmed claimed by the next real scheduler tick. Screenshots/log excerpts of these real actions are the proof artifact, not a description of what should happen.
- Same standard applies to the heartbeat and `maxDurationMs` additions from §2: prove by killing a worker mid-run and observing a live reclaim, and by setting a short `maxDurationMs` on a real goal and observing a live transition to `exhausted` — not by reading the code and asserting it looks right.

This is not a new rule; it's v2 §3's existing "Falsifiable proof per step; green suites alone never count" line, made unambiguous so it can't be satisfied by a passing CI run alone.

---

## 4. Failure history this design has to survive, with receipts

Josh's instruction: incorporate the abandoned-task and multi-day-failure pattern, not just the 521/goal-run incident already covered in v1/v2. Pulled live task-bus history (`cortextos bus task-history`, checked 2026-08-09) for the three tasks Josh named plus the 521 case already diagnosed:

| Task | History | Pattern |
|---|---|---|
| Gmail push→event migration (`task_1785972952359_30686002`) | One entry: `create` 2026-08-05T23:35Z. Never claimed, never touched since. 3+ days. | Not "paused by a lock" — never started. Matches RC11: no enforced ingress means a queued intent with no active claimer just sits, indistinguishable from "in progress" in narration. |
| Fireflies meeting-chain repair (`task_1786082267095_32952418`) | `create` → `in_progress` (08-07T05:57) → `in_progress` (08-07T20:02, re-stamped) → **bounced back to `pending`** (08-08T20:21). | Went in_progress, made no durable progress, silently reverted state — the same "looked active, produced nothing durable" shape as the Aug 7 goal-run incident (native `[goal] active:` narration, zero durable runs). |
| Fleet cron modernization (`task_1786124091063_44235615`) | `create` → `in_progress` (08-07T17:34) → `blocked` (08-07T20:38), same day. | Stalled within 3 hours of starting; no unblock action recorded since. |
| SEIU 521 goal narration (v1/v2, already root-caused) | Model set native thread goals for 6.4h, zero durable runs created, three "run IDs" cited in status messages were pure narration. | The worked example: RC11's "unenforced native path is the default" is not theoretical — it consumed a real workday. |

Josh's own framing when correcting a status report on these same three tasks (2026-08-08, see [[project_gmail_fireflies_cron_independently_broken_2026-08-08]]): *"they are all independently broken, because i've been trying to code them all for days"* — rejecting an agent's "blocked by the 521 lock" explanation as insufficient. The lock compounds these; it did not cause them.

**Why this belongs in the durable-goal-run design, not just as a sad list:** every one of these three tasks is exactly the kind of unit of work the goal-run control plane is meant to own — multi-day, resumable, needs-a-real-completion-gate. None of them currently runs through anything durable; they live entirely in bus-task state, which (per this table) can silently regress `in_progress → pending` or stall at `blocked` with no automatic re-wake, no lease, no timeout-driven escalation. That is RC8 (stall watchdog) and RC5 (same-fail-set escalation) from v1, and the new `maxDurationMs` gap from §2 above, all pointing at the same underlying hole: **bus tasks and durable goal runs are two different persistence mechanisms today, and only one of them (goal runs, once actually wired per RC11/Step 2b) has any of the machinery — lease, retry bound, wall-clock bound, verification gate — needed to keep a multi-day task from silently going dead.**

**Concrete build-plan implication (extends v2 §2.2's task-reconciler tie-in, does not replace it):** once Step 2b (durable ingress) ships, these three specific tasks are the first real backlog to route through it — not as new scope for this plan, but as the acceptance proof that the new ingress actually rescues exactly the failure mode that produced them. Recommend Josh route Gmail/Fireflies/fleet-cron through `cortextos goal queue` once Step 2b lands, as the plan's real-world Step-2-equivalent proof rather than (or in addition to) a synthetic test goal.

---

## 5. What changed from v2 (summary for the record)

| Area | v2 | v3 |
|---|---|---|
| Research stage | Absent — no external artifact existed for this feature | §1 makes external-prior-art citation a hard gate for future Research stages; §2 supplies the missing artifact for this one, retroactively |
| Retry/backoff defaults | Open question (v1 §4, unresolved) | Answered with sourced starting point: 5 attempts, 1s initial, 1.5× multiplier, 30s cap (§2) |
| Lease mechanism | Claim + reclaim-on-next-attempt (verified in code) | + heartbeat/renew during active run (new, folds into Step 8) |
| Timeout model | Retry-count bound only | + wall-clock `maxDurationMs` bound, independent of attempt count (new, folds into Step 4) |
| Acceptance-check types | `pr-merged:` only (v2 §2.2) | + taxonomy generalization (`command`, `file_contains`, `file_json_path`) alongside it (folds into Step 4) |
| Verification standard | Stated once (v2 §3, "falsifiable proof… green suites never count") | Restated per-criterion in §3, tied explicitly to the Aug 7 failure mode it exists to prevent |
| Failure evidence base | 521 goal-run incident only | + Gmail/Fireflies/fleet-cron task-bus history with receipts (§4), reframed as the plan's real backlog, not just motivation |
| Lineage/build steps | Unchanged | Unchanged — no new steps; two parameter additions inside existing Steps 4 and 8 |
