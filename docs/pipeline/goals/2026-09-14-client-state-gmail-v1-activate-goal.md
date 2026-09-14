# Client State v1 — Gmail thin slice — R2 ACTIVATE (`goal-client-state-gmail-v1-activate`)

```text
WORKFLOW PACK: fast-release
  Split reason: this is the first-prod-write half of the spec. The sibling
  `2026-09-14-client-state-gmail-v1-build-goal.md` (chain node
  `goal-client-state-gmail-v1-build`) built, reviewed, staged, and proved the whole thin
  slice on COPIES with zero production writes. This goal turns it on: live cron on the
  fleet, real CRM rows, real vault History entries, real human-routed bus tasks, real
  Telegram digest — exactly what spec D-03 (as amended: detection, not approval) says the
  automated writers do. ENTRY is a human gate (below); after entry the loop is
  autonomous per D-03.
  bonesify: chain `/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`,
  node `goal-client-state-gmail-v1-activate`, depends_on `goal-client-state-gmail-v1-build`.

ENTRY GATE (HALT until ALL hold — quote the evidence on the ledger before any write):
- E1. Josh has promoted `feature/client-state-gmail-v1` to `main`: `git -C /Users/joshweiss/code/cortextos fetch origin && git merge-base --is-ancestor <build G3 merge SHA> origin/main` exits 0.
- E2. The runtime checkout the cron will execute from contains that code:
  `git -C /Users/joshweiss/code/cortextos merge-base --is-ancestor <build G3 merge SHA> HEAD`
  exits 0 (the shared checkout is the daemon cwd; the loop NEVER checks out / resets it —
  if this fails, the HALT report names the exact `git -C … checkout main && git pull`
  Josh runs, or the pm2 marker per the brain chain's redeploy note).
- E3. Josh's explicit go for live activation, quoted with timestamp on the ledger (a
  message in this session or in the chain's channel saying to activate / turn it on /
  install the cron). Approval for the build goal, or "yes" to anything else, does NOT
  count. Absent E3 this goal reports E1/E2 status and stops.
No production write of any kind before E1–E3 hold. This is HALT clause (2)-style: a
checkpoint the loop cannot pass alone.

MODEL MAP
- plan draft: sonnet (`planify`) — short plan; G0-compile over its shell/python blocks;
  G0a opus read-through (there is little code — apply-and-run only if the plan adds any);
  G0b `codex exec … < /dev/null`; G0c grok `skipped-by-Josh`.
- implement: sonnet; **opus** on anything touching the live cron text or the coverage
  diff ruling.
- G1: `record-gate --gate G1-suite` COUNT DELTA vs a fresh BASELINE on
  `feat/client-state-gmail-v1-activate` (this goal adds at most the committed baseline
  snapshot + coverage-diff tests; delta may legitimately be 0 — say so).
- G2: `codex review --base <kickoff>`; `codex challenge` REQUIRED (diff touches
  `scripts/brain/**` / crm config / crons); grok skipped.
- G4: deterministic `record-gate --gate G4-matrix` wrapping
  `docs/pipeline/run-artifacts/client-state-gmail-v1/g4-activate-check.sh` over the
  evidence list below — LIVE artifacts (real ledger rows, real CRM rows, real vault
  commit, real Telegram message id), not previews.
- FINAL: grok skipped-by-Josh; `Agent(model: "fable")` on
  `<kickoff>..<feature/client-state-gmail-v1 HEAD>` **and on the live output** (the real
  vault commit diff, the real CRM rows, the first digest text) — FINAL reads the live
  artifact of the first prod write.

SOURCE OF TRUTH
- Spec (BINDING): `/Users/joshweiss/code/cortextos/state/specs/2026-09-14-client-state-gmail-v1-spec.md`
  → FR-002 (cron via `bus add-cron`, live-fleet range-with-step pre-check, lock, receipt,
  gap line), FR-006 (SUBSUME: parallel writers 7 days → coverage diff → ruling per
  excluded class → only then the piggyback line goes), FR-009 (one-time committed
  baseline; daily digest; one-line OK), §Decisions D-03 as amended, §Accepted assumptions.
- Build goal + its ledger + its G4 artifacts (what was proven on copies):
  `/Users/joshweiss/code/cortextos/docs/pipeline/goals/2026-09-14-client-state-gmail-v1-build-goal.md`,
  `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-build.md`,
  `/Users/joshweiss/code/cortextos/docs/pipeline/run-artifacts/client-state-gmail-v1/g4/`.
- Release ledger: `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-activate.md`
- Plan: `/Users/joshweiss/code/cortextos/docs/pipeline/plans/2026-09-14-client-state-gmail-v1-activate.md`
- Anchors: `bus add-cron <agent> <name> <interval> <prompt…> [--desc]` (`src/cli/bus.ts:3911-3944`;
  writes crons.json directly — NEVER via config.json migration); crm-codex piggyback line
  `orgs/clearworksai/agents/crm/config.json:27`; pa-codex agent dir
  `orgs/clearworksai/agents/pa-codex/` (repo `config.json` has `crons: []`; live crons are
  runtime state under `.cortextOS/state/agents/pa-codex/crons.json` — read with a
  concrete path, never `grep -r` the runtime root); `meeting_loop_watch.py` Telegram via
  `cortextos bus send-telegram` with `CTX_AGENT_DIR=orgs/clearworksai/agents/pa-codex`.

STANDING RULES
- Release unit and test economy (Fast) — verbatim from goalify SKILL.md (generated region):
<!-- begin:release-unit-fast -->
  **Release unit.** The default ship unit is a **release** — one plan, one
  full-suite gate, one combined diff review (G2), one `/stage`, one staging
  matrix — not a ledger sub-phase row. Work packages inside a release may
  implement in parallel under SDD; they do **not** each get their own stage
  ceremony. Split into a separate condition file / stage unit only for a
  real checkpoint: human mockup approval, metered spend, first prod-write
  decision, or a migration that must land alone.

  **Test economy.** During implementation run focused package/file tests and
  typecheck. Full suite + exact count delta vs BASELINE runs **once** before
  `/stage` for the release (and again only if a post-suite fix could have
  broken the suite). BASELINE is captured once per release branch, not per
  work package.

  **Pre-stage disposition.** Critical and Important findings from G0/G2 are
  fixed and re-verified before `/stage`. Do not park Important until after
  stage.

  **Evidence.** Evidence artifacts land in the same release PR/commits. An
  evidence-only PR is not a stage unit and must not re-trigger deploy +
  matrix.

  **FINAL dual unconditional.** After the release is staged and its matrix is
  GREEN, run whole-spec `/grok-build:critique` then Fable on the same pinned
  range — always both, never risk-gated, never dropped under Fast.

  **Mockup gate is mode-invariant.** If SOURCE OF TRUTH names a mockup, full
  Mockup-fidelity applies (binding mockups, parity matrix, no dead
  affordances, regions + placement). Fast does not skip or soften it. Human
  mockup approval, when required, is a prior release or HALT checkpoint.

  **Resume spine.** After every compaction or fresh session: re-read THIS
  goal file first, then the release ledger, then git — lowest unfinished
  **release** (not the next package that happens to look open). Package
  status lives in the ledger only; git is ground truth for STAGED/PROMOTED
  of the release.
<!-- end:release-unit-fast -->
- Risk upgrade — verbatim from goalify SKILL.md (generated region):
<!-- begin:risk-upgrade -->
  **Risk upgrade (not a second mode).** When the combined release diff
  matches STANDING RULES risk patterns (`**/auth/**`, migrations/schema,
  billing, PII tables, external-write helpers, first-touch surface named in
  ENVIRONMENT), require Codex challenge and keep dual plan/diff models as
  today for that release. Absence of match does **not** drop FINAL dual,
  Important pre-stage fixes, mockup, or the single full-suite release gate.
  Risk deepens G0/G2 only; it does not invent a Full lifestyle mode and does
  not re-introduce per-package stage ceremony.
<!-- end:risk-upgrade -->
- Grok gate invocation — verbatim from goalify SKILL.md (generated region):
<!-- begin:grok-invocation -->
  **Grok gate invocation.** `/grok-build:review` and
  `/grok-build:critique` are gate names, not installed commands. Run each as
  a headless Grok CLI call:

  ```bash
  grok -p "<brief>"                       # single-turn; prints to stdout and exits
  grok -p "<brief>" --output-format json  # when the gate wants a parseable artifact
  ```

  `grok` is `~/.grok/bin/grok`, also reachable as `~/.local/bin/grok`. The
  brief is the gate's existing scope: the plan file for G0c, the combined
  release diff for G2c, and `<kickoff SHA>..<staging HEAD>` for FINAL.

  A non-zero exit or a "no artifact" message is not proof the run failed.
  Check `~/.grok/sessions/<id>/`: a completed run writes `signals.json`; a
  crashed one does not. Grepping a reconstruction for "Findings" proves
  nothing because the brief itself contains that word. If the run did not
  complete, record the gate as **not run**, never as clean.
<!-- end:grok-invocation -->
- Severity rubric — verbatim from goalify SKILL.md (generated region):
<!-- begin:severity -->
  Critical = violates a BINDING spec line, a security or data-integrity
  risk, or would fail a gate if left unfixed. Important = correct and does
  not fail a gate on its own, but is worth fixing. Nothing softer than
  Important is a reportable finding — style opinions don't count and
  shouldn't be logged as one.

  **A finding that contradicts a LOCKED spec decision is not a finding.**
  If a reviewer flags behaviour the spec's §Decisions deliberately chose
  (a fail-open, an accepted degradation, a scoped-down guarantee), it is
  either out of scope — say so and move on — or, if the reviewer has
  surfaced a case the decision genuinely did not consider, HALT clause (2)
  spec ambiguity. It is never a Critical to be "fixed", because fixing it
  reverts a decision that already survived adversarial review. The builder
  rule ("do NOT fix the spec's decisions while building") and this line are
  the same rule applied to the two directions a change can come from.

  This classifies SEVERITY only — it does not dictate disposition. Each
  gate below states its own: Codex review/challenge and the Opus
  plan-review fix Important findings inline before proceeding, no reason to
  defer something that's still pre-stage or pre-code. The Fable final-build
  review may carry an Important finding past promote as a watch item — but
  only where carrying it is actually safe; see the Final-build review gate
  below for the case where it isn't.

  **Newly-discovered findings outrank catalogued ones.** A finding the spec
  already lists as a known follow-up gets carried quietly. A finding that is
  real, out of scope, and **not** in the spec at all gets a severity, a
  recommended next step, and top billing in the HALT-3 report — never the
  same flat "carried as a watch item" line as the known debt, which buries
  it exactly where nobody is looking.
<!-- end:severity -->
- Review-loop bounds — verbatim from goalify SKILL.md (generated region):
<!-- begin:review-loop-bounds -->
  **Review-loop bounds** — apply to EVERY review gate in this condition (G0,
  G2, FINAL REVIEW).

  1. A review gate gets **3 rounds**. At the cap, stop dispatching and
     adjudicate each open finding yourself — fix / park-with-ruling / HALT —
     writing every adjudication to the ledger with its reasoning. Without a
     cap the gate cannot terminate, and "one more round will converge" is a
     known-false rationalization.
  2. Record findings-per-round in the ledger. **If the count fails to
     decrease across two consecutive rounds, stop and report** — that is
     evidence the fold is generating the findings, and another fold is the
     one thing guaranteed not to help.
  3. **Severity is scoped by blast radius:** a defect that cannot reach the
     product — test-only infrastructure, scaffolding, a harness — caps at
     Important however it would grade in product code.
  4. **Whenever a guard has needed more than two rounds, assert the invariant
     instead of hardening against its violation.** When a guard defends a
     secret, first ask whether the secret is there at all. A cheap enforced
     precondition beats an expensive incomplete defence, and it demotes the
     apparatus from load-bearing to defence-in-depth, which makes its open
     findings honestly parkable.
<!-- end:review-loop-bounds -->
- Review-artifact contract — verbatim from goalify SKILL.md (generated region):
<!-- begin:review-artifact -->
  "Clean" is not evidence — and a transcript that *says* "clean" is not
  either, because the same agent that ran the review is the one grading its
  own output. A subagent review (the Opus plan-review, the
  Grok critique + Fable final-build review at the Final-build review gate)
  only counts as done when it is written to a real artifact **file**
  (`docs/superpowers/run-artifacts/<spec key>/<gate-id>-<reviewer>.json`) —
  narrated transcript prose is not the artifact, it is a claim about one —
  containing: the reviewer (model name), what was reviewed
  (spec section + plan file path, or the exact diff SHA range), a findings
  list — literally `[]` if there are none, not silence — with each finding
  mapped to Critical or Important per the severity rubric, and a
  disposition per finding: `fixed-and-reverified` (fixed, then the review
  re-run on the corrected material — never the pre-fix verdict, and the
  re-run verifies **the corrections themselves**, including any replacement
  text the reviewer authored in its own fix suggestion; reviewers inject
  defects too, and a re-review that only confirms "the original finding is
  gone" will wave through an error it created — observed 2026-08-01, where a
  reviewer's own prescribed fix carried a wrong expected test count that the
  plan adopted verbatim and the next round caught against itself),
  `carried-as-watch-item` (Important only, with its own verification
  trigger), `folded-as-latent` (confirmed in principle but **not
  reproducible on the version or platform actually in use** — fold the safer
  form anyway when it is free, and record it as *latent*, never as *live*;
  the disposition carries the probe that failed to reproduce it and the
  version it ran against, or it is a dismissal wearing a label),
  `confirmed-code-kept` (the finding is correct and the code stays anyway,
  because the current form is deliberately stricter or otherwise right here
  — requires naming what makes it right AND fixing whatever comment, doc, or
  test name asserted the equivalence the reviewer believed; if nothing was
  edited, this is not the disposition, it is a refusal), or
  `halted-awaiting-human-decision` (a Critical found in code
  that has already promoted independently of this review — see
  Final-build review gate's disposition rules; this one is deliberately
  NOT "fixed", because the loop cannot safely fix it alone). A bare "plan
  review clean" or "no issues found" with none of that behind it is
  exactly the cheat "Testing the condition" already warns against for
  `/codex review` — it just wasn't closed for the two subagent reviews when
  they were added.

  **kind=deterministic, not ai.** G0 and FINAL are gated by
  `bonesify record-gate --gate <G0|FINAL>-review --cmd "node
  ~/.claude/skills/goalify/scripts/verify-review-artifact.mjs --file <path>
  [--file <path> ...] --sha <sha>"`, exit 0 required, folded into mark-done
  evidence `gate_invocation`. The script fails closed on a missing file, a
  stale sha, or any Critical whose disposition isn't one of
  `fixed-and-reverified` / `fixed-final-adjudication` / `folded-as-latent` /
  `confirmed-code-kept` — `halted-awaiting-human-decision` and
  `carried-as-watch-item` do not close a Critical, by design. This is the
  same treatment G1's full-suite gate already gets; G0 and FINAL no longer
  get a softer, self-reported one.
<!-- end:review-artifact -->
- Comments are claims — verbatim from goalify SKILL.md (generated region):
<!-- begin:comments-are-claims -->
  **Comments are claims.** Every comment, docstring, and test name that
  asserts a behavior is a claim to VERIFY, not context to read the code with.
  Where the two disagree the comment wins the reading and the code wins at
  runtime, so no amount of re-reading separates them: execute the claim where
  that is cheap, and where it is not, name in the review artifact which claims
  were checked and which were taken on trust. Correct code carrying a wrong
  claim is a real finding whose fix is the comment (`confirmed-code-kept`).
<!-- end:comments-are-claims -->
- Learn-from proposal — verbatim from goalify SKILL.md (generated region):
<!-- begin:learn-from -->
  **Learn-from proposal.** As the LAST action before compiling HALT clause
  (3)'s report, after FINAL REVIEW is clean: scan this run's own ledger +
  transcript for anything the loop had to improvise that ISN'T already
  covered by this condition — a rebase protocol, a failure-attribution call,
  an environment fact that had to be rediscovered, a cheat a reviewer almost
  let through, a gate that false-passed or false-failed. Class-level only;
  the one-off instance stays in the ledger.

  **If candidates exist:** first run the corpus entry validation procedure at
  `$HOME/.claude/skills/shared/references/corpus-entry-validation.md` on each
  — its L2 verdict decides `append` / `extend` / `reject`. Then list each as
  a proposed `learnings.md` bullet (one line, class-level, ending in a
  proposed "→ where the fix would land") **with its verdict attached**, in
  the SAME report that asks for the /promote decision, and ask via
  `AskUserQuestion` (multiSelect) which to append. Occurrence updates for
  `extend` and `reject` are selectable items in that same question — never
  written unprompted. Append only what's selected, verbatim into
  `learnings.md`'s existing dated-section format. Never auto-append, and
  never merge this ask with the promote decision itself — two questions.

  **If nothing was improvised beyond what this condition already specified:**
  say so in one line ("no learn-from candidates this run") and move on. Do
  NOT invoke `AskUserQuestion` on an empty list, and do NOT manufacture a
  lesson to avoid an empty section — silence here is a valid, common outcome.

  This writes to `learnings.md` ONLY, never to the skill files themselves.
  Advisory, never a HALT on its own: a skipped or declined proposal does not
  block the /promote decision in the same report.
<!-- end:learn-from -->
- Subagents by default — verbatim from goalify SKILL.md (generated region):
<!-- begin:subagents-default -->
  **Subagents by default.** Delegate any step whose inputs are large and whose
  output is small — codebase digests, convention lookups, multi-file greps,
  plan/diff investigation, parallel task implementation under SDD, review
  probes that are not themselves the exit-code gate. Dispatch independent
  units **in parallel, in one message**. The main thread holds decisions,
  condition/ledger state, and gate exit codes — not the material behind them.

  **Return contract:** the agent's final message IS the return value (rows,
  paths, verdicts, `file:line`). Never a transcript. Bulky evidence → write a
  file, return path + gist. Doctrine that must land verbatim comes back
  verbatim.

  **Independence = separate dispatch.** Lenses that shared one context are one
  witness; never claim "independently confirmed" for same-context multi-angle
  reads. Verify load-bearing `file:line` claims yourself before they decide a
  gate or architecture.

  **Never delegate:** status-changing CLI gates whose exit code is the
  evidence; human asks (HALT / AskUserQuestion); the split of WHAT to build;
  and do not supervise a long-running process with a subagent (background task
  instead — see Gates that cannot silently weaken §10).
<!-- end:subagents-default -->
- **Workspace.** Worktree `/Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1`
  on a NEW branch `feat/client-state-gmail-v1-activate` cut from
  `origin/feature/client-state-gmail-v1` after E1 (`git -C <worktree> fetch && git checkout -b feat/client-state-gmail-v1-activate origin/feature/client-state-gmail-v1`);
  `npm ci` if `package-lock.json` moved. Shared checkout: fetch/push only; runtime
  commands (`--repo-root`, cron prompts) point at the SHARED checkout because that is
  where the daemon, CRM data, and `secrets.env` live.
- **G3 / G4 honest substitutes.** `/stage` = PR `feat/client-state-gmail-v1-activate` →
  `feature/client-state-gmail-v1`, plain `gh pr merge --merge`, never `--delete-branch`;
  never merge to `origin/main` (Josh's promote). `/test-on-staging` = the live G4
  checker. The committed artifacts in this goal are small (baseline snapshot, cron
  precheck output, coverage-diff results); the RUNTIME effects (cron entry, ledger rows,
  CRM rows, vault History entries, tasks, Telegram) are the real evidence and live
  outside git — the G4 checker reads them from their live paths and the vault commit.
- **Spec is BINDING; locked decisions as listed in the build goal's STANDING RULES apply
  verbatim here.** In particular D-03 as amended: once E1–E3 hold, automated writes are
  NOT individually approved — the digest is the detection net. Do not invent a
  per-message approval step; do not ask Josh to confirm each write. New scope → HALT (2).
- **External-write boundary (this goal).** Permitted production writes, each with its
  reader: (a) `bus add-cron pa-codex client-state-gmail "*/10 * * * *" "<prompt>"` and,
  if no daily digest cron exists for `meeting_loop_watch.py`, one daily cron for it —
  read back from the live crons.json; (b) ledger/receipt/claims under the shared
  checkout's `state/client-state/` (gitignored by the build goal); (c) CRM rows via the
  REAL `orgs/clearworksai/agents/crm/crm/add-interaction.py` / `upsert-contact.py`; (d)
  vault History entries on bound pages under `/Users/joshweiss/code/knowledge-sync`
  (committed by the vault auto-sync cron or by this goal with a pathspec — never `git add -A`
  in the vault); (e) `cortextos bus create-task … --assignee human --type human`; (f)
  Telegram digest + escalations via `send-telegram`. FORBIDDEN: removing the crm-codex
  piggyback line (`config.json:27`) — that is gated on the 7-day coverage diff ruling and
  is NOT in this goal's DONE bar; any `bus comms-filter` call from this lane; any write
  to `~/.cortextos` other than what `bus` itself does; any Gmail write verb.
- **Metered spend.** `--max-usd 2` on the first live run; the cron prompt passes
  `--max-usd 1` per tick (a 10-minute tick over a 3-day window with cached extractions
  is cents; a tick that exits 12 is a digest line, not a HALT — but the FIRST manual run
  hitting 12 is HALT (1)). Cumulative spend on the ledger.
- **Rollout pre-check (FR-002).** Before `add-cron`: run
  `run-artifacts/client-state-gmail-v1/cron-precheck.sh` against the LIVE
  `.cortextOS/state/agents/pa-codex/crons.json` (and every other live crons.json the
  daemon loads, enumerated from `enabled-agents.json`, concrete paths) — any
  range-with-step form present is a HALT (1) with the file+line, because the daemon
  parser mis-parses it silently. `*/10 * * * *` itself is supported (G-02, corrected).
- **Baseline commit (FR-009).** `invariants-baseline.json` is computed ONCE from the
  production vault + CRM at activation, committed to `state/client-state/` on this
  branch, and its sha256 recorded on the ledger; pre-existing violations are
  grandfathered. Never regenerate it later to make a digest quiet.
- **Parallel-writer window (FR-006).** From the first cron tick, both writers run: the
  old crm-codex heartbeat piggyback (`comms-backfill.py`, 7-day window incl. SENT mail)
  and the new poller. `coverage-diff.py` is scheduled daily (as a line in the digest
  cron prompt or its own cron — plan decides) and writes
  `state/client-state/coverage-diff/<date>.json` grouping every old-path row the new
  path did not write by class (`sent-mail`, `automated-sender`, `unknown-entity`,
  `other`). The 7-day ruling and the piggyback removal are a FOLLOW-UP carried in the
  HALT-3 report with trigger "7 daily diffs exist"; they are not this goal's work.
- **Test runner / BASELINE / kickoff / ledger checkpoints / review-loop bounds /
  standing facts** — identical to the build goal's STANDING RULES; re-read that file's
  STANDING RULES at iteration 1 (they are binding here verbatim). Grok out of credits;
  `codex exec < /dev/null`; realpath skill scripts; bare `rc=$?`.
- **Fail-closed halts persist the cause** (tick exits, gws errors, extraction failures →
  receipt/ledger with stderr), and the digest names the repair.

RELEASES
[R2] Activate the poller in production and prove the first live loop. Packages:
  - P-baseline: compute + commit `state/client-state/invariants-baseline.json`; record
    counts (org-name violations, domain violations, pre-epoch `gmail:` refs) on the
    ledger; commit the epoch timestamp.
  - P-cron: live `cron-precheck.sh` (HALT on any hit); `bus add-cron pa-codex client-state-gmail "*/10 * * * *" "<prompt that runs python3 /Users/joshweiss/code/cortextos/scripts/brain/client_state_gmail.py --days 3 --repo-root /Users/joshweiss/code/cortextos --vault /Users/joshweiss/code/knowledge-sync --state-dir /Users/joshweiss/code/cortextos/state/client-state --max-usd 1 and appends stdout to state/client-state/ticks.log>" --desc "client-state gmail poller (FR-002)"`;
    ensure a daily `meeting_loop_watch.py` cron exists on pa-codex (add only if absent);
    read both back from the live crons.json (concrete path) → ledger.
  - P-first-run: one manual live run `--days 3 --max-usd 2` (same command as the cron,
    from the shared checkout) BEFORE the first tick fires (hold the lock or run it
    first) → real ledger rows, real CRM rows, real History entries, real tasks (type
    human), escalations if any; then verify the next two cron ticks ran (two receipts
    with advancing `last_success_at`, zero duplicate writes).
  - P-digest-live: trigger the digest once (`meeting_loop_watch.py` without `--dry-run`)
    → Telegram message received (message id / timestamp on the ledger) listing every
    write from P-first-run + zero NEW invariant violations (or the real ones, listed).
  - P-parallel: `coverage-diff.py` scheduled; first diff produced and stored; classes
    reported on the ledger (no ruling yet).
  DONE when: ENTRY GATE E1–E3 quoted on the ledger → G0 (compile + opus artifact +
  codex; grok skipped) `record-gate --gate G0-review` exit 0 → plan stamped → implemented
  → G1 COUNT DELTA vs this branch's BASELINE (`record-gate --gate G1-suite` exit 0) →
  G2 codex review + challenge clean, allowlist check (this diff touches only
  `state/client-state/invariants-baseline.json`, run-artifacts, the digest cron prompt
  text if committed, and tests) → G3 PR merged into `feature/client-state-gmail-v1`
  (SHA) → G4 `record-gate --gate G4-matrix --cmd "bash docs/pipeline/run-artifacts/client-state-gmail-v1/g4-activate-check.sh <G3 SHA>"`
  exit 0 asserting, each from its own live artifact copied under
  `run-artifacts/client-state-gmail-v1/g4-activate/`:
    1. `precheck.txt`: live crons.json scan — zero range-with-step hits (the scan is
       shown to bite on the 2026-08-11 fixture first).
    2. `crons.json` (copy): the `client-state-gmail` entry with `*/10 * * * *` and the
       exact prompt; the daily digest cron present.
    3. `first-run.txt` + `observations.jsonl` (copy) + `run-receipt.json` (copy): the
       manual run exited 0; ≥1 row `filed`; every filed row's `writes[]` names a CRM
       interaction row (`interactions.jsonl` line with `source_ref gmail:<id>`, verified
       present in the REAL file), a vault page path whose History section contains the
       `[source: gmail:<id>]` line (verified in the REAL vault), and task ids that
       `cortextos bus list-tasks --class <class> --limit <n>` shows as `type: human` /
       `assignee human`; cost line ≤ 2.
    4. `ticks.txt`: two subsequent cron receipts with advancing `last_success_at`, ledger
       row count unchanged for already-filed refs (idempotent), no duplicate CRM rows
       (source_ref+contact_id unique), no duplicate History lines.
    5. `digest.txt`: the real Telegram message text + send timestamp; it lists every
       P-first-run write with page + line + source_ref, ignored-sender counts, and the
       invariants section (zero NEW, or listed); the one-line OK path is exercised by a
       second send on a quiet window if one occurs within the goal (else recorded as
       not exercised — a carried watch item, not a fail).
    6. `coverage-diff-<date>.json`: first daily diff exists with class counts.
    7. `vault-commit.txt`: the vault commit(s) carrying the History entries (SHA +
       pathspec-only `git show --stat`), no unrelated files.
    8. `floor.txt`: floor layers named.
  AND the verification floor holds: **This release is DONE only when Layer 2 (deployed
  environment: the live cron ticks, live ledger/receipt, live CRM rows, live vault
  commit, live Telegram digest — items 1–7 read from their live paths by
  `g4-activate-check.sh`) and Layer 3 (codex review + challenge; Fable FINAL on the live
  output) are reached and named in the ledger with their evidence, on top of Layer 1
  (G1 COUNT DELTA, deterministic gate scripts). Reaching a lower layer than stated is a
  HALT, not a downgrade. If the stated layer turns out to be unreachable, stop and say so
  — do not silently substitute a weaker one.**

EACH ITERATION
0. Ledger checkpoints; subagents by default; exit-code gates in this thread.
1. Re-read THIS file, the build goal's STANDING RULES, this ledger, `git log`. Evaluate
   ENTRY GATE E1–E3; if any fails, write the status + the exact human action to the
   ledger and HALT (report). Do not proceed to step 2 without E1–E3 quoted.
2. Cut the branch; BASELINE; kickoff SHAs; `Skill(planify)` → plan path above (packages
   above; the cron prompt text verbatim; the coverage-diff schedule decision).
3. G0 (compile, opus artifact, codex, grok skipped) → `record-plan-artifact` → `record-gate --gate G0-review`.
4. `Skill(implementify)`: P-baseline, P-cron (pre-check first), P-first-run, P-digest-live,
   P-parallel — in that order (they are sequential: the baseline must exist before the
   first digest; the first run before the ticks).
5. G1 → 6. G2 (+challenge) → 7. G3 PR + merge → G4 live checker → 8. FINAL → ledger.

FINAL REVIEW: grok `skipped-by-Josh` (recorded); `Agent(model: "fable")` once on
`<kickoff>..<origin/feature/client-state-gmail-v1 HEAD>` against the ENTIRE spec, given
the live artifacts under `run-artifacts/client-state-gmail-v1/g4-activate/` (real vault
diff, real CRM rows, real digest); artifact `run-artifacts/client-state-gmail-v1/final-review-activate-fable.json`;
`record-gate --gate FINAL-review --cmd "node /Users/joshweiss/code/bones-dev-skills/goalify/scripts/verify-review-artifact.mjs --file <that file> --sha <HEAD>"`
exit 0. A Critical here is in code that HAS promoted (the build goal's code is on main)
→ per the Final-build review disposition rules: HALT, report finding + prod impact, do
NOT silently hotfix; a Critical confined to this goal's un-promoted additions → fix,
re-run gates, re-run Fable. Important → watch item with trigger.

DONE: R2 DONE-when + FINAL clean, verified from this session's own output (live
artifact copies, `gate_invocation` exit-0 records, Telegram message id). Then
`b mark-done <chain> goal-client-state-gmail-v1-activate --evidence <evidence.json>`
with `matrix: GREEN`, the G3 SHA, gate invocations. Carried follow-ups with triggers:
(1) FR-006 7-day coverage-diff ruling → piggyback removal (trigger: 7 daily diff files
exist; Josh rules on each class; then remove `config.json:27` line in a separate PR);
(2) one-line-OK digest path exercised (trigger: first quiet day); (3) v1.1 deferrals as
the spec's Non-goals list them. Do not auto-promote.

ENVIRONMENT: same as the build goal's ENVIRONMENT (re-read it), plus:
- Live crons: `.cortextOS/state/agents/pa-codex/crons.json` under the shared checkout —
  read with that concrete path; `bus add-cron` writes it directly (crons.ts addCron →
  writeCrons); never edit config.json crons and never trigger the migration path.
- Runtime state dir: `/Users/joshweiss/code/cortextos/state/client-state/` (gitignored
  except `invariants-baseline.json`).
- Vault commits: pathspec-only (`git -C /Users/joshweiss/code/knowledge-sync add <page paths>`),
  and an already-committed pathspec (auto-sync cron beat you) = success, not a failure.
- Telegram receipt: `send-telegram` prints the API result; capture it; the digest agent
  dir is pa-codex (`CTX_AGENT_DIR`).
- `docs/` is gitignored at the repo root: every new file under `docs/pipeline/**` needs
  `git add -f <path>` or it never lands in the PR.

HALT: Staging merges are pre-authorized — run /stage and let the PR merge
without asking. Do not pause to confirm opening or merging a PR to
staging; this loop runs unattended. After each **release** merge, run
/test-on-staging against the deployed staging env; its union
spec-coverage matrix must be GREEN before the **release** counts as done.
Multi-release conditions still stage release-by-release. A pre-existing
failure elsewhere in a shared suite with ZERO file overlap with this
release's combined diff is NOT a HALT — record it in the run artifact and
carry it as a promote blocker; any overlap makes it this release's RED.
HALT only on: (1) a gate fails (a RED /test-on-staging matrix counts) —
stop, report gate+diff+error, no silent fix-forward; this does NOT cover
Codex/Grok review/challenge, the Opus plan-review, or the Grok critique +
Fable final-build review finding a pre-promote Critical — those are fixed
inline per their own disposition rules, not a HALT, UNLESS the final-build
review's disposition rules themselves say HALT (a Critical in
already-promoted code — see Final-build review gate); (2) spec ambiguity or
conflict — stop, ask; (3) all releases staged AND the whole-spec Grok
critique + Fable final-build review are clean per the review-artifact
contract (zero unfixed Critical findings from EITHER, re-verified by
re-running whichever review found it after any fix — not the pre-fix
verdict) — stop, run the Learn-from proposal gate above and fold its
output into this same report, then report with ALL carried blockers and
watch items (each with the trigger that verifies it), await the
explicit /promote decision (do not auto-promote to main unless this
spec's own DONE section says otherwise).

OVERRIDE: ENTRY GATE E1–E3 is an additional HALT before any work — the first
production write of this spec needs Josh's promote AND explicit go. After entry,
automated writes are not individually approved (D-03 as amended). `/stage` = PR into
`feature/client-state-gmail-v1`. `/test-on-staging` = live G4 checker. Grok recorded
`skipped-by-Josh`. Metered spend `--max-usd 2` first run, `--max-usd 1` per tick.
Piggyback-line removal is NOT in scope. No merge to `origin/main`.
```
