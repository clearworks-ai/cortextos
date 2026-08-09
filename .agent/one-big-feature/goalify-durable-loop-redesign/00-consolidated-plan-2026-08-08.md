# Goalify Durable Loop — Consolidated Spec + Build Plan

**Date:** 2026-08-08 (PDT)
**Author:** Claudeman (spec/plan only; no source touched)
**Supersedes:** `.agent/one-big-feature/goal-run-control-plane/02-master-plan.md` (partially — see §4), `.agent/one-big-feature/autonomous-fanout-ledger/*` (prototype abandoned; 521 records 08/09 remain authoritative for 521).
**Repo:** `/Users/joshweiss/code/cortextos`

---

## 0. The finding that changes everything

There are **THREE parallel durable-goal implementations** in this repo right now. Neither of today's two review passes knew this.

| # | Location | Lineage | State |
|---|----------|---------|-------|
| A | `src/goals/` (7 files) + PTY integration | **origin/main**, PR #323, merged 2026-08-07 00:22 after an independent REJECT → remediation cycle (`.agent/one-big-feature/goal-run-control-plane/05-reviews/`) | Most advanced. Has a real periodic scheduler, turn-completion correlation, per-item receipts, review threads, completion audit, retention, `/goal resume`. **Never proven live** — zero run JSONs have ever existed on disk. |
| B | `src/daemon/goal-*.ts` (7 files) + PTY integration | branch `larry/goal-durable-runner` (current working checkout; forked from main **before** #323, merge-base `61901c21`) | The one-shot, race-prone version. **This lineage is what the live daemon has been running since ~2026-08-07 16:49.** All of today's "confirmed findings" are true of B, and most were already fixed in A. |
| C | `src/daemon/pipeline-run-store.ts` + `pipeline-supervisor.ts` (untracked) + wiring in `src/daemon/agent-process.ts` | today's confused codex session | Orphaned prototype. No production code ever calls `PipelineRunStore.create()`. Delete. |

Evidence:
- `git merge-base HEAD origin/main` = `61901c21` (predates #323/#324); `git diff --stat origin/main...HEAD` shows `src/daemon/goal-*.ts` as branch-only additions; `src/goals/` exists only on main.
- Live state `~/.cortextos/cortextos1/state/larry-codex/goal-runs/larry-codex/` contains **only** `.retention-observation` (mtime 2026-08-07 16:47) and **zero run JSONs**. The observation file is written exclusively by A's `GoalRunStore.prune()` (`src/goals/goal-run-store.ts:106` on main) on every scheduler tick — so A's scheduler ran until ~16:47 Aug 7 and never since. PM2 shows `cortextos-daemon` uptime ≈26h (started ~16:49 Aug 7) with `CXR_GOAL_DURABLE=true`, cwd = this checkout (branch B). Current `dist/` (rebuilt today 14:31) contains `PipelineSupervisor` and no `goalTickTimer` — branch lineage.
- Conclusion: on Aug 7 afternoon the daemon was restarted onto a build of lineage B, silently replacing the reviewed-and-merged A. Everything observed since (dead loop, larry-codex narrating check-ins it never performs) is B's known behavior.

This is not just context — it **is** the disease. See §2.

---

## 1. Root cause, final (code-grounded, reconciled)

Grounding convention: `B:` = current checkout (branch), `A:` = `git show origin/main:<path>`.

**RC1 — One-shot tick, no daemon scheduler (B only; fixed in A).**
`B: src/pty/codex-app-server-pty.ts:733` — `handleGoalCommand()` calls `this.goalRunner.processTick(...)` exactly once per `/goal`. `processTick` has no other caller in `src/` (verified by grep). A queued/`retry_wait` run persists on disk but nothing ever re-invokes it after restart.
`A: src/pty/codex-app-server-pty.ts:697-728` fixes this: `initializeGoalIntegration()` fires `signalGoalTick()` at startup (= restart resume) and `setInterval(..., config.tickIntervalMs)` (default 60s), with tick coalescing (`goalTickRunning`/`goalTickPending`), errors surfaced to the output buffer, and `stopGoalScheduler()` on kill.

**RC2 — Verification races the model turn (B only; fixed in A).**
`B: codex-app-server-pty.ts:721` — goal `dispatchPrompt` awaits only the `turn/start` RPC ack. Compare the interactive path `startTurn()` at `B:667-672`, which awaits `createTurnCompletion()`. Consequence at `B: src/daemon/goal-runner.ts:17`: `turn_completed` is logged and `verifying` entered immediately after the RPC ack — checks run against a repo the model hasn't finished (or started) modifying.
`A: codex-app-server-pty.ts` `dispatchPrompt` (inside `initializeGoalIntegration`) awaits `createTurnCompletion(checkTimeoutMs)`, correlates via `goalPendingTurn` {threadId, turnId}, and serializes against the interactive queue via `waitForOrdinaryQueue()`.

**RC3 — Vacuous acceptance (present in BOTH, differently).**
`B: codex-app-server-pty.ts:751-756` — default checks are `npm run build` + `npm test`, which pass on an untouched repo. No red-baseline requirement; a goal can go `done` with zero diff.
`A: src/goals/goal-run.ts:51-59` — the default `goal-focused` profile **hard-codes cortextOS's own goal-system test paths** (`tests/unit/goals`, `tests/integration/goal-run-control-plane.test.ts`, …). For a goal in any other repo those commands are wrong or meaningless; for goals in cortextOS they test the goal system, not the goal. A's `repository-full` profile does have real anti-vacuity machinery (fresh baseline observation matching `git rev-parse HEAD`, green-evidence/waiver matching, `goal-run.ts:38-49`) — the right idea, wrong default, env-var-fed, and never exercised.

**RC4 — Silent mode fallback (BOTH).**
`B:182` / `A:171` — `if (process.env.CXR_GOAL_DURABLE === 'true')`. Unset ⇒ `/goal` silently degrades to the native ephemeral thread goal (`B:727` → `setGoal()`), i.e. exactly the "model narrates a commitment nothing enforces" mode. Flag is toggled ad-hoc in PM2; nothing in the reply tells you which mode you got.

**RC5 — No same-fail-set escalation, no honest terminal state for grinding (BOTH).**
A retries with backoff per item (`A: goal-runner.ts retryItem/retryDelay`) and exhausts on `maxAttempts`, but never detects that consecutive cycles failed with the *identical* fail-set, and has no `needs_escalation` outcome. B just loops `retry_wait`. Anvil doctrine: identical fail-set twice ⇒ stop; one read-only diagnostic turn from a smarter model, or an honest terminal state — never a hopeful retry.

**RC6 — No gate-integrity check (BOTH).** Nothing stops a candidate from editing the tests/scripts that verify it. Anvil treats this as a non-negotiable Safety-class failure.

**RC7 — Goals execute in the shared checkout (BOTH).** `A: handleGoalCommand` sets `repo: this._cwd`, never creates a worktree (thread API supports `worktree || repo` but ingress never supplies one). This repo's memory has 4+ shared-checkout destruction incidents in one week. Builder isolation (Anvil: isolated worktree, main tree never touched, result lands on a review branch) is absent.

**RC8 — No daemon-owned notification/stall watchdog (BOTH).** The live proof: larry-codex told Josh at 1:20pm it would check a worker "every 10 minutes," then was silent until Josh pinged at 6:08pm. Run-state transitions and stalls are only ever reported if a model happens to narrate them. The enforcement mechanism for recurring commitments must be the daemon, not the narration.

**RC9 — Nothing prevents unmanaged sessions from entering live lanes.** Today's rogue codex CLI session (outside daemon/PTY supervision, inside the repo) drifted, built scaffolding C, and nearly touched the live 521 repair worktree. There is no lane registry, no attestation, no hook that blocks an untracked session from committing into an active lane.

**RC10 — Orphaned prototype C wired into the daemon.**
`src/daemon/agent-process.ts:21` (import), `:191`, `:206-225` (constructor builds a `PipelineSupervisor` for larry/larry-codex with a `GATE: plan` dispatch to `opencode`), `:279-282` (starts before PTY), `:501` (stop). No production code creates a `PipelineRun`; no reply listener calls `complete()`; no ledger emit. It is dead weight and a latent second owner. **Delete, do not extend** — confirmed.

---

## 2. Why "close but never arriving"

The pattern, named: **every session that finds the loop broken builds a new parallel implementation and accepts its own green unit tests as progress, instead of locating the canonical implementation and proving it live.**

Three implementations in ~72 hours. A was reviewed, rejected, remediated, merged — then silently un-deployed by a branch rebuild the same afternoon, and no one noticed because **the definition of done was "tests pass in my checkout," which cannot detect that the live daemon runs different code.** Yesterday's addendum caught the symptom precisely ("status messages claimed three run IDs; disk had no run JSON") and then today's session repeated the disease anyway by building C.

Two structural facts make this recur:
1. **No live-runtime receipt in the acceptance path.** Nothing forces "a real `/goal` on the live daemon produced an inspectable run file" before "done" may be claimed. Every prior gate (vitest, tsc, build, even independent review) is satisfiable in a checkout that never ships.
2. **The shared mutable checkout is both the deploy artifact and the workbench.** Whoever rebuilds `dist/` last silently decides what the fleet runs. Branch B un-deployed A without any signal.

Corollary rule for the executing agent, non-negotiable: **this plan authorizes ZERO new stores, supervisors, or runner files.** Any new sibling of `goal-run-store`/`pipeline-run-store` appearing in the diff is an automatic reject. All work lands in `src/goals/` and its call sites.

---

## 3. Design

### 3.1 Canonical implementation and ownership

- **Canonical code: `src/goals/` on origin/main (lineage A).** Lineages B and C are abandoned (B's non-goal changes are salvaged separately, §5 step 9).
- **Scheduler owner:** exactly one — the per-agent `CodexAppServerPTY` (A's `goalTickTimer`), which already ticks on startup (restart resume) and on interval, and stops on PTY kill. The daemon's job is to keep the PTY alive (it already does). No AgentProcess/AgentManager-level goal supervisor. Rationale: the runner needs the live RPC to the app-server; an out-of-process owner re-creates the split-brain C introduced.
- **State machine:** A's schema-v3 as merged — manifest of verbatim items, per-item `implementation → verification → review` cycle with receipts, findings, completion audit, lease/CAS store, retention. Plus one new state: `needs_escalation` (terminal, §3.3).

### 3.2 Mode visibility — kill the silent fallback (RC4)

- Durable mode becomes **default-on** for codex app-server agents. `CXR_GOAL_DURABLE` inverts to an explicit opt-out (`=false`).
- Every `/goal` reply names its mode and receipt: `[goal] durable queued <run-id> (N items, profile <name>, worktree <path>)` vs `[goal] NATIVE (non-durable) — will not survive restart`. A fallback that can be mistaken for the durable path is the RC4 bug; it must be impossible to not know which you got.

### 3.3 Acceptance gates — Anvil doctrine, adapted (RC3, RC5, RC6)

**(a) Checks come from the goal, not from an env-selected hard-coded profile.**
`/goalify` output (the existing skill) gains a structured `ACCEPTANCE:` block (check id, argv command, timeout, required). `handleGoalCommand` parses it into `run.acceptanceChecks`. If the goal text carries no checks, fall back to a *repo-derived* profile (scripts present in the target repo's `package.json`), never to cortextOS's own goal tests (A's current default). Keep A's `repository-full` baseline-observation machinery unchanged — it is the strictest thing in the codebase and already fail-closed.

**(b) Red-baseline gate (anti-vacuity).**
At run creation the verifier executes the required checks once in the (isolated, §3.4) worktree and persists a `baseline` record (per check: pass/fail, failure inventory). Rule:
- ≥1 required check red at baseline ⇒ queue normally. "Verified" later means: previously-red checks now green, no required check regressed.
- ALL required checks green at baseline ⇒ the acceptance is vacuous. Refuse to queue: `needs_human` with reason `vacuous acceptance — every required check already passes; name a check that currently fails or attach a green-baseline waiver`. Explicit escape hatch for refactor goals: `--allow-green-baseline` persists a waiver in the run and switches the done-condition to `non-empty diff AND checks stay green AND review passes`.
This is the direct adaptation of Anvil's red-baseline: "verified" can only come from a machine gate that could have failed.

**(c) Same-fail-set escalation.**
After each verification cycle compute `failSignature = sha256(sorted [checkId + normalized first error line])`. Persist per item and run. If two consecutive cycles produce identical signatures:
- If `CXR_GOAL_ESCALATION_MODEL` is set: burn exactly ONE read-only diagnostic turn (new thread, that model, no write tools, prompt = fail history + diff) and attach its report as a finding; then one more cycle is permitted.
- Otherwise, or if the post-diagnostic cycle repeats the signature again: transition to terminal **`needs_escalation`** with the honest report (fail-set, cycles, cost). Never silently keep grinding, never report hopeful progress.
Timeouts likewise terminate as `exhausted`/`needs_escalation` with real reasons — the terminal state vocabulary is `done | needs_human | needs_escalation | exhausted | cancelled`, all honest.

**(d) Gate-integrity (Safety-class, non-negotiable).**
Before running checks each cycle, diff the worktree (`git diff --name-only <cycle-base>`) against the protected set: files/globs referenced by any required check's command (test paths in argv), `package.json` scripts invoked by checks, and the goal manifest/run record itself. Any overlap ⇒ that cycle FAILS with a `safety` finding regardless of check results (goal may explicitly whitelist test paths it is *supposed* to modify, e.g. TDD goals declare their new test file). Two safety failures ⇒ `needs_escalation`.

**(e) Cost honesty.** Accumulate per-goal-thread token usage from the app-server's turn/context events into `run.costTokens`; `/goal` (list) prints tokens (and $ if a rate is configured) or the literal word `unpriced`. Never an implicit $0.

### 3.4 Builder isolation — worktrees (RC7)

- `handleGoalCommand` creates `git worktree add <repo>/.goal-worktrees/<run-id> -b goal/<run-id>` (when repo is a git repo; refuse durable goals in non-repo cwds and in agent control dirs — the addendum's binding rule, already spec'd in `03-specs/02-runtime-recovery-and-proof.md`).
- `run.worktree` persisted; A's thread API already honors `worktree || repo` for cwd; the verifier and gate-integrity diff run in the worktree.
- The main tree is never touched. A passing result exists as commits on `goal/<run-id>` — a review branch. Merge/PR/push remain human-gated exactly as today (no change to the approval gates).
- Terminal runs: worktree pruned after retention window; branch kept.

### 3.5 Rogue-session prevention — lane registry + attestation (RC9)

- **Lane registry:** `<ctxRoot>/state/lanes.json` — `{ laneId, agent, repo, worktreePath, scopePaths[], runId?, token, startedAt }`. Durable goal runs auto-claim a lane at creation and release at terminal state. Manual lanes (like the live 521 repair worktree) claimable via CLI.
- **CLI:** `cortextos lanes list|claim|release` (new subcommand in `src/cli/`).
- **Hard enforcement at the git boundary:** a committed guard script wired via `core.hooksPath` (repo already ships a hooks system) as `pre-commit`/`pre-push` in the shared checkout and in every registered worktree. If the current worktree (or a path being committed) belongs to a registered lane and the environment lacks the matching `CXR_LANE_TOKEN`, the commit is refused with the owning agent + lane printed. Managed daemon-spawned processes get their token injected automatically per agent; an unmanaged codex/claude CLI session has no token and is structurally blocked from committing into a live lane — no politeness required.
- Accepted residual risk (stated honestly): a rogue session can still *read* and can dirty files without committing; full FS isolation is out of scope for v1. The hook stops the damaging act (landing changes / clobbering a lane's branch state), and `lanes list` gives any well-behaved session a machine-readable "do not enter" map.

### 3.6 Observability — the daemon does the checking, not the narration (RC8)

- **Transition notifier (daemon-owned):** on `needs_human | needs_escalation | done | exhausted` the daemon (not the model) sends the Telegram message with run id, phase, reason, evidence path. This is the structural fix for the 1:20pm→6:08pm silence: recurring-check commitments are only ever made by machinery that owns a timer.
- **Stall watchdog:** a fast-checker-style scan (`src/daemon/fast-checker.ts` already owns periodic per-agent work) flags any non-terminal run with `updatedAt` older than 3× `tickIntervalMs` and no valid lease ⇒ Telegram alert + event. A frozen `.retention-observation` mtime — exactly the signal that sat undetected for 26 hours — becomes an alarm.

### 3.7 Single-lane vs multi-lane — explicit v1 position

- **Per agent: ONE active durable goal** (`claimBudget` forced to 1 for v1; A defaults to 4 — lower it). A single PTY serializes goal turns against its interactive queue anyway (`waitForOrdinaryQueue`), so >1 goal per agent cannot truly parallelize; it only interleaves and multiplies failure modes.
- **Across agents: N concurrent lanes are enabled by this design.** Worktree isolation (§3.4) + lane registry (§3.5) remove the two things that forced the manual "521-only" focus lock (shared-checkout collisions and no machine-readable map of what's in flight). The three currently-frozen tasks (Gmail push migration, Fireflies webhook repair, cron modernization) are each a candidate lane on its own agent once v1 passes its soak (§6). Full fan-out of one goal into parallel worker sub-lanes (the fanout-ledger WS3 idea) stays out of scope for v1 — it belongs to the GATE/pipeline system and mixing it into the goal runner is precisely the scope-blend that destroyed today's session.

---

## 4. Reconciliation with the prior artifacts

**Keep from `goal-run-control-plane/02-master-plan.md` (2026-08-06/07):**
- The data model, CAS/lease store, state machine, dedicated-thread design — all already merged better than the plan draft (schema-v3, PR #323). Do not re-litigate.
- The **Runtime Recovery Addendum (2026-08-07)** and `03-specs/02-runtime-recovery-and-proof.md` — its 7 locked points are all correct and mostly implemented in A; the un-met residue is exactly "prove it on the live daemon" (§5 step 2) and repo/worktree binding (§3.4). Its completion gate ("PASS only when a real daemon-backed `/goal` creates an inspectable run JSON … survives a daemon restart") is adopted verbatim into §6.
- The idea of intentional per-goal validation (Phase 3.0) — kept as §3.3(a), but sourced from the goal/goalify, not a static profile registry.

**Discard from that plan, with reasons:**
- `goal-blocker-parser.ts` (keyword + confidence sniffing of turn text for "approval/human/permission") — A's merged design already uses structured JSON report envelopes with an explicit `blocked` status; keyword sniffing over prose invites false `needs_human` and is strictly worse. Dead.
- The `minimal` validation profile ("no checks, for emergency fixes") — a vacuity generator; contradicts §3.3(b). Dead.
- The 6-phase generic rollout ("beta testing with select users", tiered rollout) — boilerplate that doesn't fit a single-operator fleet; replaced by §5 step 2 + §6 soak.
- The Days-1-18 build phasing — the code exists; the remaining work is convergence, gap-close, and live proof.

**From `autonomous-fanout-ledger/` (today):**
- Files C (`pipeline-run-store.ts`, `pipeline-supervisor.ts`, test, agent-process wiring) — **delete** (RC10). Its one correct instinct — a worker receipt must join a signed ledger row before anything counts — already lives in the pipeline/GATE system and its requirement stays THERE, as a follow-up goal, not in the /goal runner.
- Files 08/09 (521 deployment cert + worker gate) — remain the authoritative 521 record. This plan does not touch `/private/tmp/larry-seiu-multi-order-178606/` or any 521 gate; instead the 521 repair worktree becomes the first *manually registered lane* in §3.5.
- The two prior review passes' findings — all confirmed for lineage B (§1), with the correction that RC1/RC2 are already fixed on main and the real emergency is deployment convergence, not re-implementation.

---

## 5. Sequenced build plan

Executor: Codexer (or equivalent), via the normal GATE dispatch with this file as the plan artifact. Work happens in an **isolated worktree of cortextOS** (never the shared live checkout), branch `goal-durable-v2` cut from `origin/main`. Each step names its own falsifiable proof; "tests pass" alone is never the proof.

**Step 0 — Converge: remove lineages B and C from the future.**
- Branch from `origin/main` (contains A). Do NOT merge `larry/goal-durable-runner`.
- In the live checkout (coordinated small change, or carried on the new branch when it deploys): delete untracked `src/daemon/pipeline-run-store.ts`, `src/daemon/pipeline-supervisor.ts`, `tests/unit/daemon/pipeline-supervisor.test.ts`; surgically revert the supervisor wiring in `src/daemon/agent-process.ts` (`:21` import, `:189-191` field, `:206-225` constructor block, `:279-282` start, `:501` stop) while preserving that file's unrelated modifications (enabled-agent fallback, handoff startup-prompt).
- *Proof:* `grep -rn "PipelineSupervisor\|pipeline-run-store" src/ tests/` returns nothing; fresh `npm run build`; `grep -c goalTickTimer dist/daemon.js` ≥1 and `grep -c PipelineSupervisor dist/daemon.js` = 0.

**Step 1 — Failing test first: restart-resume against the REAL entry point.**
Write the integration test the handoff demanded: create a durable run via the PTY `/goal` path (mock app-server per `tests/e2e/mock-codex.js`), kill/recreate the PTY, assert the persisted queued/`retry_wait` run is claimed and advanced by the startup tick with **no second slash command**. On lineage A this should pass or expose a real bug — either result is the point.
- *Proof:* the test file exists, and its git history shows it red (or green-on-A with a demonstrated red when the scheduler is disabled) before any production change.

**Step 2 — Live-prove A as-is, BEFORE writing new features.** (The anti-pattern breaker; do not skip to step 3.)
Deploy the step-0 build to the live daemon in a coordinated restart window (Josh-approved deploy, per gates). Issue one trivial real `/goal` on a test codex agent with one genuinely-red check. Verify on disk: run JSON created at `state/<agent>/goal-runs/<agent>/<id>.json`; events advance; `pm2 restart cortextos-daemon` mid-run; run resumes unprompted; terminal state honest. **This step also answers §7's open question** (why A never wrote a run JSON on Aug 7): if ingress falls back or `create()` fails live, fix that bug in `src/goals/` before anything else.
- *Proof:* the run JSON path + full event sequence + daemon restart timestamps bracketed inside the run's event log, attached to the PR.

**Step 3 — Mode visibility + default-on (RC4).**
`src/pty/codex-app-server-pty.ts` (main lineage `:171` gate, `:697` init, `handleGoalCommand`): invert flag semantics (`CXR_GOAL_DURABLE=false` opts out), and make every `/goal` reply name mode + receipt per §3.2.
- *Proof:* with the env var entirely unset, `/goal x` on a test agent replies `[goal] durable queued <id>…` and the run JSON exists; with `=false` the reply contains `NATIVE (non-durable)`.

**Step 4 — Acceptance-from-goal + red-baseline (RC3).**
`src/goals/goal-run.ts` (`selectGoalAcceptanceProfile` `:51-59` — remove hard-coded cortextOS test paths as default), `handleGoalCommand` (parse `ACCEPTANCE:` block), `src/goals/goal-verifier.ts` (baseline pass at creation; done-condition = previously-red now green, no regression), plus the `--allow-green-baseline` waiver path. Update the `goalify` skill (`~/.claude/skills/goalify/`) to emit the `ACCEPTANCE:` block.
- *Proof:* (i) goal whose checks all pass at baseline is refused with the vacuous-acceptance reason persisted; (ii) goal with a red check queues, and its run JSON contains the baseline failure inventory; (iii) same goal with waiver flag queues with waiver persisted.

**Step 5 — Same-fail-set escalation + `needs_escalation` (RC5).**
`src/goals/goal-runner.ts` (`retryItem`/`finishVerification`): compute/persist `failSignature`; implement the 2-strike rule, optional single read-only diagnostic turn (`CXR_GOAL_ESCALATION_MODEL`), new terminal state in `goal-run.ts` types + store validation + notifier.
- *Proof:* fixture goal with a deterministically failing check reaches `needs_escalation` after exactly 2 identical cycles (event log shows both signatures equal); with escalation model configured, event log shows exactly one diagnostic turn and its report attached as a finding.

**Step 6 — Gate-integrity Safety check (RC6).**
`src/goals/goal-verifier.ts`: pre-check diff vs protected set per §3.3(d); `safety` finding severity; 2-strike → `needs_escalation`.
- *Proof:* a fixture run whose implementation turn (mock) edits a file named in a required check's argv fails that cycle with a `safety` finding even though the checks pass.

**Step 7 — Worktree isolation (RC7).**
`handleGoalCommand`: worktree creation + repo binding refusal rules (agent control dir ⇒ `needs_human`, per addendum); verifier + gate-diff run in `run.worktree`; retention prunes worktrees of terminal runs.
- *Proof:* during a live run, `git -C <repo> status` on the main tree stays clean; the diff exists only on branch `goal/<run-id>`; run JSON records the worktree path; a `/goal` issued from an agent control dir is refused with the durable reason.

**Step 8 — Daemon-owned notifier + stall watchdog (RC8) + cost line.**
New small module invoked from `src/daemon/fast-checker.ts`'s existing cadence (no new supervisor process): transition Telegram sends + 3×-tick stall alert; token accumulation into `run.costTokens`; `/goal` list shows cost or `unpriced`.
- *Proof:* kill the PTY mid-run → a real Telegram message (message id captured) fires within 3× tick without any model turn; a `needs_human` transition produces a daemon-sent message naming the run; `/goal` output shows a cost figure or `unpriced`.

**Step 9 — Lane registry + rogue-session guard (RC9).**
`src/cli/` new `lanes` subcommand; `state/lanes.json` schema; committed `hooks/` guard + `core.hooksPath` wiring; daemon injects `CXR_LANE_TOKEN` per agent; goal runs auto-claim/release lanes; register the 521 worktree as the first manual lane.
- *Proof:* from a bare shell (no token), `git commit` inside a registered lane worktree is refused and prints the owning agent; the same commit from the managed agent's environment succeeds; `cortextos lanes list` shows the goal lane appear at `/goal` and disappear at terminal state.

**Step 10 — Salvage lineage B's non-goal changes, then delete B.**
From `git diff origin/main...larry/goal-durable-runner`, extract the wanted non-goal diffs (`agent-manager.ts`, `cron-migration.ts`, `pipeline/ledger.ts`, `outbound-policy.ts`, `opencode-pty.ts`, `cli/bus.ts`, plus the uncommitted `agent-process.ts`/`fast-checker.ts` work) into a separate PR; abandon `src/daemon/goal-*.ts` entirely; delete the branch after both PRs land.
- *Proof:* `git ls-files src/daemon | grep goal-` empty on the merged main; branch deleted; the salvage PR's diff contains zero goal-runner files.

**Step 11 — Two-lane concurrency demonstration (v1 ceiling).**
Two different agents each run one real durable goal concurrently in separate repos/worktrees to honest terminal states.
- *Proof:* two run JSONs with overlapping event timelines, disjoint worktrees, both terminal-honest, zero lane-guard violations logged.

Sequencing note: steps 3-8 are independent enough to shard after step 2, but step 2 is a hard barrier — **no feature work before the live proof** — and step 9 can proceed in parallel with 4-8.

---

## 6. Acceptance bar — when Josh should believe it

This has failed repeatedly, so the bar is receipts on the LIVE daemon, not green suites. All of:

1. **Durable resume, live:** a real `/goal` produced an inspectable run JSON; `pm2 restart cortextos-daemon` mid-run; the run resumed and reached a terminal state with **zero further human prompts**; the event log brackets the restart. (Addendum completion gate, verbatim adopted.)
2. **Non-vacuous done:** the goal's `done` state shows a check that was red at baseline and green at completion, with the diff on `goal/<run-id>`, main tree untouched.
3. **Honest failure:** a deliberately impossible goal terminated in `needs_escalation` after exactly 2 identical fail cycles — no infinite grinding, no fabricated success, and the report states the fail-set and cost.
4. **Tamper-proof gate:** an induced test-edit candidate failed its cycle with a `safety` finding.
5. **Machine-owned comms:** every status Josh received during the above came from the daemon notifier (verifiable message provenance), none from model narration; a forced mid-run PTY kill produced a stall alert within 3 ticks.
6. **Rogue block:** an unmanaged CLI session was demonstrably refused a commit into a registered lane.
7. **No fourth implementation:** the merged diff contains no new store/supervisor/runner siblings; `src/daemon/goal-*` and `pipeline-{run-store,supervisor}` are gone from main.
8. **Soak:** over 7 days, ≥3 real goals (at least one per: done, needs_human/`needs_escalation`) ran to honest terminal states on the live daemon with zero silent stalls (watchdog log empty of unexplained entries).

Until all eight hold, the correct status is "not fixed," regardless of how many tests pass.

---

## 7. Highest-risk open question

**Why did lineage A — live with `CXR_GOAL_DURABLE=true` from Aug 7 00:22 to ~16:47 — never write a single run JSON?** Disk evidence proves its scheduler ticked (`.retention-observation` writes) but no run was ever created, while status messages claimed three run IDs. Candidate explanations: `/goal` was never actually invoked through the durable ingress in that window (only narrated); ingress silently fell back (flag not visible to that process at PTY init); or `GoalRunStore.create()` failed silently. This cannot be resolved from disk after the fact. Step 2 is designed to answer it under observation before any new code is trusted — if a real `/goal` on the A build still yields no run file, that bug outranks everything else in this plan.
