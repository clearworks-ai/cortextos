# Goalify Durable Loop — Consolidated Spec + Build Plan v2

**Date:** 2026-08-08 (PDT), evening pass
**Author:** Claudeman (spec/plan only; no source touched)
**Supersedes:** `00-consolidated-plan-2026-08-08.md` (v1, same directory — kept as historical record). v1's lineage finding and design skeleton stand; v2 **answers v1's §7 open question from disk evidence**, adds one new root cause (RC11), corrects v1's timeline, and folds in two pre-existing harnesses (`dynamic-pipeline.js`, `task-reconciler.py`) that neither prior pass had seen.
**Repo:** `/Users/joshweiss/code/cortextos`

---

## 0. Lineage decision — FINAL, independently re-verified

**Converge on `src/goals/` (lineage A, origin/main, PR #323 `a438da6d`). Abandon lineage B (`src/daemon/goal-*.ts` on branch `larry/goal-durable-runner`) and delete lineage C (`pipeline-run-store.ts`/`pipeline-supervisor.ts`).** This is not a judgment call; it is arithmetic:

- Re-verified this pass: `git merge-base larry/goal-durable-runner origin/main` = `61901c21` (predates #323); `git ls-tree larry/goal-durable-runner -- src/goals` is **empty**; `git ls-tree origin/main -- src/goals` shows 7 files (`goal-manifest.ts`, `goal-run-store.ts`, `goal-run.ts`, `goal-runner.ts`, `goal-thread-manager.ts`, `goal-verifier.ts`, `index.ts`).
- A has, merged and reviewed: startup + interval scheduler with coalescing (`codex-app-server-pty.ts:697-724` on main), real turn-completion correlation (`dispatchPrompt` awaits `createTurnCompletion`, serialized via `waitForOrdinaryQueue`), a lease/CAS store with path-traversal guards, secret redaction, retention, per-item implementation→verification→review receipts, and a strict `repository-full` baseline validator (`goal-run.ts:validateGoalAcceptanceProfile`). B has none of this; B is the one-shot race-prone version both prior passes spent the day diagnosing. C has no caller of `.create()` anywhere — dead.

**What this means for the build plan:** unchanged from v1 in direction (v1 already targeted `src/goals/` on a branch cut from `origin/main`) — v2 confirms it and adjusts the steps in §5. Any file:line target in older artifacts that points at `src/daemon/goal-runner.ts` or the current branch's `src/pty/codex-app-server-pty.ts` is **wrong by construction**: the current checkout does not contain the canonical code. The fix branch must be cut from `origin/main`; the working checkout on `larry/goal-durable-runner` is only a salvage source (v1 Step 10, kept).

**Timeline correction to v1 §0/§7:** v1 said A was "live with its flag on for ~16 hours" (00:22→16:47 Aug 7). Disk says otherwise: `~/.cortextos/cortextos1/state/larry-codex/goal-runs/` dir mtime is **Aug 7 10:26 PDT** — that is when the `larry-codex/` agent subdir was created, which only happens on the scheduler's **first prune tick** (`goal-run-store.ts prune()` does the `mkdir`). `.retention-observation` last write is 16:47 PDT (`{"timestamp":"2026-08-07T23:47:56Z","removedRuns":0}`). So the durable runtime (A build + `CXR_GOAL_DURABLE=true`) was live **~10:26–16:47 PDT (~6.4h)**, not 16h. PR #323 merging at 00:22 did not deploy anything — merge ≠ restart, which is itself Exhibit A for v1 §2's "shared checkout is the deploy artifact" disease.

---

## 1. ANSWERED: why lineage A never wrote a single run JSON

v1 §7 flagged this unanswerable from disk. It is answerable, and the answer is fully evidence-backed — **the durable ingress was never invoked, and could not have been.**

The only call path to `GoalRunStore.create()` in lineage A is: PTY inbound text → `handleInput` (`codex-app-server-pty.ts:253`) → `parseGoalCommand` (`:414`) matches `/goal <objective>` → `handleGoalCommand` (`:750`) → `create()` (`:755`) → reply `[goal] queued <id>: N item(s)`. There is no other caller in `src/` (grep-verified on origin/main). If `handleGoalCommand` threw (e.g. `selectGoalAcceptanceProfile` under a misconfigured `repository-full` env), the error surfaces as `[codex-app-server] input failed: …` in the output buffer (`:194-196`).

Disk evidence (`~/.cortextos/cortextos1/logs/larry-codex/`):

1. **Zero `[goal] queued` lines in the entire 21MB `stdout.log`** — in either lineage's format (A: `queued <id>: N item(s)`; B: `queued <id>: <objective>`). `create()` never succeeded, on any build, ever.
2. **Zero `[codex-app-server] input failed:` and zero `[goal] scheduler failed:` lines.** `create()` never *threw* either — it was never reached.
3. **No inbound `/goal <objective>` command exists.** `inbound-messages.jsonl` for Aug 7 shows Josh asking in prose: "well you have 521 and fireflies and the google onto cron fix lanes. all 3 need to be formal goals please" (07:31Z), then "sso your goal skill doesnt work, noth ing moved on ay of those 3 in 8 hours" (23:22Z). No message begins with `/goal`.
4. **The "goals" that did exist were native codex thread goals, set by the model itself.** The log floods with `[goal] active: Complete the SEIU 521 authoritative live repair…` — that string is emitted by **neither lineage's source** (grep both), i.e. it is the codex app-server binary echoing its native thread-goal feature; and the 521 goal text appears in **zero** inbound messages, so no human command set it. The model set its own native goal — the exact "narrated commitment nothing enforces" mode.
5. **Sequence:** Josh's goal-creation directives landed 00:07–00:31 PDT — *before* the durable runtime existed in-process (first prune tick 10:26). When the A scheduler came up at 10:26 it ticked an empty store for 6.4 hours (every `.retention-observation` write says `removedRuns:0`), because nothing ever re-queued the morning's native/narrated goals into the durable store — no migration path exists in the code, and no `/goal` command was ever issued afterward. At 16:49 the daemon restarted onto branch B, un-deploying A. The three "run IDs" in status messages were model narration; there was never a queued-receipt for any of them.

**Conclusion: not a store bug, not a silent `create()` failure — a never-invoked ingress.** Which exposes a root cause v1 missed:

**RC11 — The durable store has exactly one ingress: a human literally typing `/goal <objective>` into the PTY.** A prose request ("make these 3 formal goals"), a model deciding to run a goal loop, a CLI/bus dispatch, a cron — none of these can create a durable run. Meanwhile the model *can* freely set native thread goals, producing convincing `[goal] active:` output that looks like the durable system working. The failure mode is structural: the enforced path is nearly unreachable, and the unenforced path is the default. RC4 (silent fallback) is real but was not what fired on Aug 7 — nothing even reached the fallback.

v1's RC1–RC10 all stand (RC1/RC2 fixed in A; RC3–RC10 as written). RC11 joins them and changes the build plan (§5 Step 2b).

---

## 2. Root causes and design — deltas to v1 only

v1 §§1–4 remain the baseline. Deltas:

### 2.1 New: §3.8 Durable ingress surface (RC11)

- **CLI ingress:** `cortextos goal queue <agent> --repo <path> [--objective-file <md>]` (new `src/cli/` subcommand) that writes a schema-v3 run via `GoalRunStore.create()` directly (the store is file-based and lock-safe — `withFileLockAsync` — so an out-of-process create is safe), then signals the daemon (existing bus/event path) so the PTY scheduler ticks. This makes goals creatable by Josh, by an orchestrator agent, by a cron, or by the model (through its normal shell tool) — with the *same* validated manifest/acceptance machinery.
- **Prose→durable bridge:** the `/goalify` skill (already the spec-compression tool) becomes the canonical front door: its output is fed to `cortextos goal queue`, not pasted as narration. The `ACCEPTANCE:` block (v1 §3.3a) rides along.
- **Kill the native shadow:** when durable mode is on, a model-side or fallback native thread-goal set must be visibly branded (v1 §3.2) — and the daemon-side stall watchdog (v1 §3.6) must treat "native goal active + zero durable runs for this agent" as an alert condition, because that exact state masqueraded as a working system for 16 hours on Aug 7.

### 2.2 Amended: §3.3 acceptance gates — prior art + a PR-shaped check type

**Prior art (cite in rationale):** `orgs/clearworksai/agents/larry-codex/scripts/task-reconciler.py` (Josh, 2026-06-30) is the working in-fleet precedent for exactly this principle — completion is derived from a **real artifact** (GitHub PR merge state via `gh pr view --json state,mergedAt`), never from a self-reported status flip; report-only by default; `--apply` gated to confirmed-MERGED only; judgmental demotions (`--apply-demote`) separately gated. The goal loop's non-vacuous gate is the same doctrine applied to code changes.

**Concrete reuse:** add a built-in acceptance check type `pr-merged:<owner/repo>#<n>` implemented with the reconciler's exact semantics — MERGED means `mergedAt` non-null (not `state`), and **run `gh` with `GH_TOKEN` scrubbed from env** (the reconciler's field-tested gotcha: a stale `.env` `GH_TOKEN` silently shadows the valid keyring credential). Reuse the *pattern*, not the script — the script itself is larry-task-specific (TASKS_DIR, repo-inference keyword rules). Separately, wire task-reconciler (report mode) into the goal completion audit for any goal that references bus tasks, so "goal done" and "bus task complete" cannot drift apart.

### 2.3 Amended: §3.4 builder isolation — `dynamic-pipeline.js` as prior art and candidate driver

`.claude/workflows/dynamic-pipeline.js` (430 lines, Workflow-tool script) already has, built and working: parallel read-only explore, a plan stage with schema-enforced **file-disjoint workstreams**, parallel `codex-rescue` implementers with **native worktree isolation** (`isolation: 'worktree'`), a deterministic merge stage, a **locked-to-Opus review loop** with problem→workstream routing, and a PR stage. Its stale smoke copy (`orgs/clearworksai/agents/larry-codex/state/pipeline-smoke/dynamic-pipeline-63b107b.js`, 2026-07-07) documents the July precedent of the same disease: "Prior run got 'NO TASK PROVIDED', built nothing" — infra silently dropping work is not new to August.

Position in this plan — three tiers, honest about integration cost:

1. **Adopt now (patterns):** v1 Step 7's worktree binding stays, but must follow dynamic-pipeline's proven conventions (branch-per-unit, base-ref explicit, merge-to-candidate). Do not invent a third worktree convention. A's `createThread({repo, worktree})` already accepts the worktree — the goal runner just has to supply it.
2. **Fix now (tiny, separate PR):** dynamic-pipeline.js line 16 *still* defaults a missing task to the sentinel string `'NO TASK PROVIDED — …'` and proceeds — the documented July failure is still live. Change to a hard throw on missing/empty `args.task`. One line; prevents a proven silent-drop recurrence. (The goal loop's red-baseline gate is the systemic antidote — a no-op build can never turn a red check green — but the harness should also fail closed on its own.)
3. **Candidate implement-stage driver (verify before committing):** for repo-scale goal items, the item's implementation phase could invoke dynamic-pipeline (with the goal's worktree/branch as base) instead of a single bare codex turn — giving parallel file-disjoint implementation + the Opus review loop for free, while the **daemon-owned goal runner remains the durable owner** (dynamic-pipeline stays what it is: on-demand, one-pass, no owner — composed *under* an owner, its root disease is neutralized). Hard prerequisite to verify: the Workflow runtime (`agent()`, `parallel()`, `phase()` primitives) runs inside a Claude session, not the daemon; driving it from the goal runner requires a headless Workflow invocation or spawning a managed session. If that adapter is not cheap, defer to v2 of this system and keep A's per-item codex-thread implementation for v1. This is a bounded spike (Step 7b), not a dependency.

---

## 3. Sequenced build plan (v2 — supersedes v1 §5)

Executor: Codexer via normal GATE dispatch with this file as the plan artifact. Branch `goal-durable-v2` cut from **`origin/main`**, in an isolated worktree. Falsifiable proof per step; green suites alone never count.

- **Step 0 — Converge (unchanged from v1).** Branch from `origin/main`; delete lineage C files and surgically revert its `agent-process.ts` wiring. *Proof:* `grep -rn "PipelineSupervisor\|pipeline-run-store" src/ tests/` empty; `dist/daemon.js` contains `goalTickTimer`, not `PipelineSupervisor`.
- **Step 1 — Failing test first (unchanged).** Restart-resume integration test through the real PTY `/goal` entry point.
- **Step 2 — Live-prove A as-is (amended proof).** Deploy step-0 build; issue one real `/goal <objective>` **through the PTY ingress** on a test agent with one genuinely-red check; verify run JSON, restart-resume, honest terminal state. **Add:** reproduce the Aug 7 failure deliberately — send the goal *in prose* first and confirm the durable store stays empty while `[goal] active:` narration appears; that reproduction is the regression fixture for RC11 and the watchdog alert of §2.1. *Proof:* run JSON + event log bracketing a `pm2 restart`, plus the recorded prose-request/empty-store reproduction.
- **Step 2b — Durable ingress (NEW, RC11).** `cortextos goal queue` CLI writing via `GoalRunStore.create()` + daemon tick signal; `/goalify` skill updated to end by invoking it. *Proof:* a goal created from a bare shell (no PTY input at all) appears as a run JSON and is claimed by the next scheduler tick; a model-issued shell invocation does the same.
- **Step 3 — Mode visibility + default-on (RC4, unchanged)** plus the native-goal-shadow watchdog condition from §2.1.
- **Step 4 — Acceptance-from-goal + red-baseline (RC3, amended).** As v1, **plus** the `pr-merged:` check type with task-reconciler semantics (mergedAt-based, GH_TOKEN-scrubbed env).
- **Step 5 — Same-fail-set escalation + `needs_escalation` (RC5, unchanged).**
- **Step 6 — Gate-integrity Safety check (RC6, unchanged).**
- **Step 7 — Worktree isolation (RC7, amended).** Follow dynamic-pipeline's branch/worktree conventions; supply `worktree` to A's `createThread`.
- **Step 7b — Spike: dynamic-pipeline as implement driver (NEW, timeboxed).** Determine whether the Workflow runtime is headlessly invokable from the daemon. If yes: adapter design doc + one demo goal item implemented through it. If no: write the finding down and close — no adapter building inside this plan. Independent of steps 3–6. **Also (tiny separate PR): make dynamic-pipeline.js throw on missing `args.task`.**
- **Step 8 — Daemon-owned notifier + stall watchdog (RC8, unchanged)** including the §2.1 native-shadow alert.
- **Step 9 — Lane registry + rogue-session guard (RC9, unchanged).**
- **Step 10 — Salvage B's non-goal changes, delete B (unchanged).**
- **Step 11 — Two-lane concurrency demonstration (unchanged).**

Sequencing: Step 2 remains the hard barrier (no feature work before live proof). Step 2b immediately after (it is the fix for the answered failure). Steps 3–8 shardable after 2b; 7b and 9 parallel.

---

## 4. Acceptance bar (v2 — v1 §6 plus one item)

All eight v1 criteria stand verbatim. Add:

9. **Prose-to-durable closed:** a goal requested in prose (or by the model itself) results in an inspectable durable run JSON via the `goalify → cortextos goal queue` path — demonstrated once end-to-end — and the watchdog alerts within 3 ticks if an agent carries an active native goal with zero durable runs. The Aug 7 failure mode is structurally unreachable, not just discouraged.

---

## 5. What changed from v1 (summary for the record)

| Area | v1 | v2 |
|---|---|---|
| Lineage | Converge on `src/goals/` (A) | Same — independently re-verified this pass |
| A's live window | ~16h (00:22–16:47 Aug 7) | **~6.4h (10:26–16:47)** — goal-runs dir birth = first prune tick |
| §7 open question | Unanswerable from disk | **Answered:** ingress never invoked; no `/goal` command ever sent; goals were model-set *native* thread goals; run IDs were narration. Zero `queued`/`input failed`/`scheduler failed` lines in the full PTY log. |
| Root causes | RC1–RC10 | + **RC11** (single, nearly-unreachable ingress; unenforced native path is the default) |
| Build steps | 0–11 | + Step 2b (durable ingress), Step 7b (dynamic-pipeline spike + fail-closed args fix), amended Steps 2/3/4/7 |
| Prior art | — | `task-reconciler.py` (verify-via-artifact doctrine; `pr-merged:` check semantics), `dynamic-pipeline.js` (worktree + Opus-review-loop conventions; July silent-drop precedent) |
