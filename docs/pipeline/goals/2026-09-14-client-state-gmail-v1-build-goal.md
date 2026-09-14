# Client State v1 — Gmail thin slice — R1 BUILD (`goal-client-state-gmail-v1-build`)

```text
WORKFLOW PACK: fast-release
  Split reason: TWO conditions for this spec, split on the first-prod-write checkpoint.
  THIS file = R1 BUILD: everything in the spec is built, tested, reviewed, staged, and
  proven with a live READ-ONLY Gmail dry-run whose writes land only on COPIES of the vault
  and CRM — zero production writes, zero bus tasks, zero Telegram sends. The sibling
  `2026-09-14-client-state-gmail-v1-activate-goal.md` (chain node
  `goal-client-state-gmail-v1-activate`, depends on this node + human /promote) does the
  first production writes: live cron on the fleet, real CRM/vault/bus/Telegram. Do NOT do
  any of the activate goal's work here.
  bonesify: chain `/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`,
  node `goal-client-state-gmail-v1-build`, staging mutex `cortextos-staging`.

MODEL MAP (defaults — rewrite before /goal if needed)
- plan draft: sonnet (`planify`)
- G0-compile: `python3 -m py_compile` over every plan Python block materialised at its
  declared path in a scratch tree, plus `npx tsc --noEmit -p tsconfig.json` with the TS
  blocks materialised in a scratch copy of the worktree (NOT `node --check` — on Node 22
  it passes incomplete object literals). Inject one deliberate error per language ONCE
  and confirm each check bites; a check that matches zero files reports the same clean
  result as a pass.
- G0a empirical: `Agent(model: "opus")` applying the plan's code blocks verbatim to a
  throwaway worktree, running the exact commands the plan names, recording real output,
  reverting, confirming a clean tree. A prediction is not a finding.
- G0b: `codex exec … < /dev/null` review of the plan file (working-tree scope; the plan
  is the only uncommitted file — commit or stash everything else first).
- G0c: grok-build:review — **NOT RUN: Grok out of credits (Josh 2026-09-05, "skip grok
  gates"); record `grok: skipped-by-Josh` in the ledger and the review artifact, never
  `clean`.** A gate not run is not a gate passed; FINAL and G2 carry the same marker.
- implement packages: sonnet subagents under `implementify` (tddify seams; serialize
  same-file tasks); **opus** on the risk-upgrade packages P-extract (LLM prompt +
  injection bounds), P-writes (CRM/vault/task writers), P-bus (`src/bus/task.ts`,
  `src/cli/bus.ts` guards).
- G1 full suite: deterministic `bonesify record-gate --gate G1-suite` wrapping the COUNT
  DELTA script (`docs/pipeline/run-artifacts/client-state-gmail-v1/g1-count-delta.sh`)
  vs BASELINE — never the raw `npm test` exit (BASELINE may carry pre-existing red files).
- G2a: `codex review --base <kickoff SHA>` (no trailing prompt — `--base`/`--commit`
  cannot combine with a PROMPT). G2b `codex challenge` — **REQUIRED, always** (trigger
  globs below always match this diff); challenge briefs quote spec decision text
  VERBATIM, never a paraphrase. G2c grok — skipped-by-Josh (record).
- G4: deterministic `bonesify record-gate --gate G4-matrix` wrapping
  `docs/pipeline/run-artifacts/client-state-gmail-v1/g4-check.sh` over the evidence list
  in R1's DONE bar (the checker asserts each numbered item from machine artifacts, per
  item, not per file).
- FINAL: grok-build:critique skipped-by-Josh (recorded as not run), then
  `Agent(model: "fable")` ONCE on `<kickoff SHA>..<feature/client-state-gmail-v1 HEAD>`
  against the ENTIRE spec **and** on the produced artifacts (the dry-run capture dir, the
  copy-vault unified diffs, the copy-CRM row diffs, the ledger JSONL) — a diff-only FINAL
  is what missed the email-less-contact bug in brain R2. A usage-capped inherit/Task
  substitute is a `model_receipt`, not a second model; on `API Error: Overloaded` (529)
  retry the same call once before recording Fable unavailable. `record-gate --gate
  FINAL-review --cmd "node /Users/joshweiss/code/bones-dev-skills/goalify/scripts/verify-review-artifact.mjs --file <fable artifact> --sha <branch HEAD>"`.
- Every reviewer command's effective flags are echoed into its artifact
  (`gate_invocation`: cmd, flags, `model_requested`, `model_receipt`).

SOURCE OF TRUTH
- Spec (BINDING — FR-001..FR-010 every bullet; the identity scheme `gmail:<messageId>`,
  the fixed 3-day window + day-sweep, the 60-min lock TTL + heartbeat-touch, the
  known-entities-only filter, the verbatim comms-check exclusion query, full-domain keys
  only, the extraction cache identity `(source_ref, content_digest, bound-entity set)`,
  the two-tier task dedup with tier-1 ratio STRICTLY > 0.75, the `gmail:`-scoped invariants
  + committed baseline, the FR-010 file allowlist):
  `/Users/joshweiss/code/cortextos/state/specs/2026-09-14-client-state-gmail-v1-spec.md`
  → §Requirements, §Decisions (D-11; inherited D-01..D-10 as amended by the roast verdict
  recorded in the superseded brief
  `/Users/joshweiss/code/cortextos/state/specs/2026-09-14-client-state-loop-brief.md`
  §Decisions + §Roast verdict), §Non-goals, §Grounding Ledger (G-01..G-17 with line cites),
  §Accepted assumptions (owned by Josh — not findings).
- Mockup: N/A — backend only; mockup gate N/A (spec header).
- Chain: `/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`
- Release ledger (bonesify creates it at handoff; append, never rewrite):
  `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-build.md`
- Plan (written by EACH ITERATION step 2; stamped on the chain node):
  `/Users/joshweiss/code/cortextos/docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
- Run artifacts: `/Users/joshweiss/code/cortextos/docs/pipeline/run-artifacts/client-state-gmail-v1/`
  (BASELINE.json, g1-count-delta.sh, g4-check.sh, G0/G2/FINAL review artifacts, dry-run
  captures, shim logs, copy diffs).
- Anchors verified 2026-09-14 by read-only probes (re-verify each before it decides a
  gate; a line number is a pointer, not a fact):
  | piece | anchor |
  |---|---|
  | `load_closed_sets` (domain_to_slug gets full-domain AND bare-label keys) | `scripts/brain/resolve_meeting.py:295`, `:312-313` |
  | `_match_contact` / `_resolve_company_slug` nested inside `resolve()` | `resolve_meeting.py:841` / `:777` inside `:643` |
  | `_norm_title` (raises on None) | `resolve_meeting.py:445-446` |
  | `quote_gate(extraction, source)` reads `source["text_units"]` | `resolve_meeting.py:402` |
  | extraction call = `claude -p --setting-sources "" --disallowedTools "*" --model sonnet --output-format json --max-turns 1` via subprocess; cost from wrapper `total_cost_usd` + `model_receipt` | `scripts/brain/extract_meeting.py:358-371`, `:401-403` |
  | `validate_extraction` single-line/control-char checks; `extraction.schema.json` | `extract_meeting.py:183`, `:178`, `:163`, `:20` |
  | History renderer + idempotency refusing existing `[source:` (wrong for D-02) | `scripts/brain/writeback_render.py:66-83`, `:133-137`, `home_path_for :310-321` |
  | Open Items reader `_open_rows` (no stable id; status filter) | `scripts/brain/brain_rollup.py:184`, `:244-245` |
  | `meeting_loop_watch.py` linear `main()`; FIREFLIES early return; `send_telegram` shells `cortextos bus send-telegram <chat> <text>` with `CTX_AGENT_DIR=orgs/clearworksai/agents/pa-codex`; flags `--dry-run --days` | `:105-157`, `:111-115`, `:89-102`, `:42`, `:107-108` |
  | commitment id = sha1(kind:source_id|text|ordinal) — never equal across sources | `scripts/brain/adapt_meeting.py:60-62` |
  | `add-interaction.py` `--type` choices, `--source-ref`, dedup source_ref+contact_id, store paths relative to `__file__` (`CRM_INTERACTIONS_PATH` override) | `orgs/clearworksai/agents/crm/crm/add-interaction.py:52`, `:56`, `:86`, `:23-28` |
  | contact create/lookup = `upsert-contact.py --name … --match-email …` (no add-contact.py) | `orgs/clearworksai/agents/crm/crm/upsert-contact.py:111`, `:180-200` |
  | `comms-backfill.py` gws shape (`gws gmail +triage --query <q> user_google_email='josh@clearworks.ai'`), 7-day window incl. SENT, `gmail:{msg_id}` refs | `orgs/clearworksai/agents/crm/crm/comms-backfill.py:94-97`, `:172`, `:207`, `:175`, `:211` |
  | crm-codex heartbeat piggyback line (FR-006 removal target — NOT touched in this goal) | `orgs/clearworksai/agents/crm/config.json:27` |
  | comms-check query (verbatim exclusions) | `orgs/clearworksai/skills/comms-check-worker/SKILL.md:26` |
  | `createTask` hardcodes `type: 'agent'`; `claimTask` checks pending only; human-exempt enforced at list/reclaim/health only | `src/bus/task.ts:786`, `:1163-1167`, `:257/:351/:560/:651` |
  | `create-task` flags; `claim-task`; `list-tasks` defaults (`--open` ⇒ class build + limit 50) | `src/cli/bus.ts:514-554`, `:668-690`, `:787-816` |
  | claim primitive: `meeting-brief-claim --claims-dir --ttl-min` → O_EXCL create, stale = mtime age > ttl, no touch command | `src/cli/bus.ts:2541-2555`, `src/bus/meeting-brief.ts:368-416` |
  | `comms-filter` (MUTATING shared gate — records lane never calls it) | `src/cli/bus.ts:4208-4242`, `src/utils/event-dedup.ts:18-22`, `:106` |
  | `bus send-telegram <chat-id> <message>`; 4096 split | `src/cli/bus.ts:1986-2000`, `src/telegram/api.ts:327` |
  | `bus add-cron <agent> <name> <interval> <prompt…> [--desc]` (activate goal only) | `src/cli/bus.ts:3911-3944` |
  | vitest: `tests/unit/bus/task.test.ts`, `tests/unit/cli/bus-*.test.ts`; pytest: `scripts/brain/tests/test_*.py` (self-insert sys.path, no conftest) | — |
  | secrets: `scripts/brain/paths.py:12` `orgs/clearworksai/secrets.env` (envparse — never `source`); `DEFAULT_VAULT = ~/code/knowledge-sync` `:10` | — |

STANDING RULES (apply to the whole release — state once):
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
- **Workspace.** Build in a dedicated worktree:
  `git -C /Users/joshweiss/code/cortextos worktree add -b feat/client-state-gmail-v1-build /Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1 feature/client-state-gmail-v1`
  then `npm ci` there (never symlink/share `node_modules` between worktrees). The shared
  checkout `/Users/joshweiss/code/cortextos` is the daemon cwd with a dirty tree and sits
  on `feature/client-state-gmail-v1` — **never** `checkout`/`reset`/`clean`/`stash` it;
  only `git -C <shared> fetch` and `git -C <shared> push origin feature/client-state-gmail-v1`
  (push by NAME; that branch is local-only until pushed — do it in step 1). Runtime inputs
  (`--repo-root`) point at the SHARED checkout (CRM data, `secrets.env` live there); code
  under test runs from the worktree. Push `feat/client-state-gmail-v1-build` by name.
- **G3 / G4 honest substitutes** (this repo has no deployed staging app; `origin/staging`
  is 238 commits behind main and dead). `/stage` = open + merge a PR
  `feat/client-state-gmail-v1-build` → `feature/client-state-gmail-v1` (this chain's
  integration branch: == `origin/main` + the spec commits; pre-authorized like staging).
  Plain `gh pr merge --merge`, never `--delete-branch`. **Never merge to `origin/main`**
  — that is Josh's `/promote` (PR `feature/client-state-gmail-v1` → `main`). After the
  merge do not `git pull` in the shared checkout; `fetch` only. `/test-on-staging` = the
  G4 checker over R1's evidence list. `diff-touches-ui.sh` is not run: backend only, no UI
  suite (resolved here so the loop does not re-derive it).
- **Spec is BINDING; do not fix the spec's decisions while building.** Locked decisions a
  reviewer may NOT reopen (disposition `rejected-contradicts-locked-decision`, cite the
  row): D-11 known-entities-only + verbatim comms-check exclusions; D-03 as amended
  (detection, not approval — no human gate on automated writes); D-02 append-only
  supersede semantics; FR-001 one identity scheme + per-resolution outcomes + cached
  extraction; FR-002 fixed window / no cursor / day-sweep / `bus add-cron`; FR-003
  comms-filter excluded from the records lane + escalate-once; FR-004 full-domain keys
  only; FR-005 no triviality gate + quote gate exempt `matches_open_item`; FR-006 v1
  writes no body-derived contact facts + SUBSUME gated on the 7-day coverage diff; FR-008
  human-routed tasks + tier-1 ratio > 0.75 (owned assumption); FR-009 `gmail:`-scoped
  invariants + committed baseline; FR-010 file allowlist. The §Accepted assumptions are
  owned by Josh — a reviewer restating one is out of scope. New scope → HALT (2).
  **Provenance:** `settled` = D-01..D-11 and every FR bullet; `directive` = none;
  `inferred` (name as assumptions, let review attack, one in-pipeline challenge each) =
  the six assumptions listed under ASSUMPTIONS below. A decision Josh makes mid-run is
  locked from that moment: spec §Decisions row first, then this file's list, then the
  ledger line naming who/when.
- **FR-010 file allowlist (mechanical).** Shared files this diff MAY modify:
  `scripts/brain/meeting_loop_watch.py`, `src/bus/task.ts`, `src/cli/bus.ts`, plus their
  tests, plus one additive `.gitignore` line for the runtime state dir. NEW files under
  `scripts/brain/`, `scripts/brain/tests/`, `docs/pipeline/**`, `state/client-state/`
  are free. Everything else in `scripts/brain/**`, `orgs/clearworksai/agents/crm/**`,
  `orgs/clearworksai/agents/pa*/**`, `src/**` is READ-ONLY here: the `resolve_meeting.py`
  pieces, `quote_gate`, `validate_extraction`, `_open_rows` are IMPORTED, never edited;
  CRM writes go through `add-interaction.py` / `upsert-contact.py` as subprocesses, never
  by editing them or their stores directly. The crm-codex piggyback line
  (`orgs/clearworksai/agents/crm/config.json:27`) is NOT removed in this goal (FR-006
  gate lives in the activate goal). G2 checks the allowlist mechanically:
  `git diff --name-only <kickoff>...HEAD` minus the allowlist must be empty or a Critical.
- **Codex-challenge trigger (mechanical, always fires here):** diff touches
  `scripts/brain/**` OR `src/bus/task.ts` OR `src/cli/bus.ts` OR
  `orgs/clearworksai/agents/crm/**` ⇒ G2b `codex challenge` required. Risk-upgrade
  packages listed in MODEL MAP run on opus.
- **External-write boundary (this goal).** The ONLY live external reads are
  `gws gmail +triage` and `gws gmail +read` (read-only; `gws-dwd` has no send path by
  design — never `+draft`). Production writes are FORBIDDEN in this goal: no write to
  `/Users/joshweiss/code/knowledge-sync` (porcelain must stay empty), no write to
  `orgs/clearworksai/agents/crm/crm/{contacts.json,interactions.jsonl}` (sha256 before ==
  after), no `cortextos bus create-task`, no `send-telegram`, no `add-cron`, no writes
  under `~/.cortextos`. The dry-run proves this by construction: `--vault` = an rsync COPY
  of the vault, `--crm-dir` = a COPY of `orgs/clearworksai/agents/crm/crm/` whose COPIED
  scripts are invoked (they resolve their stores relative to `__file__`), `--state-dir` =
  a scratch dir, and a PATH-trap shim named `cortextos` (logs argv, exits 1) sits first on
  PATH for every dry-run and every test so any bus WRITE is counted and fails. The shim
  passes through exactly three READ-ONLY / scratch-scoped bus verbs to the real CLI, each
  still logged: `bus meeting-brief-claim` and `bus meeting-brief-release` (they write only
  under the scratch `--claims-dir`) and `bus list-tasks` (a read; the orchestrator needs
  current open tasks for FR-008 dedup). `create-task`, `send-telegram`, `add-cron`,
  `comms-filter` and every other verb stay trapped. (Amended 2026-09-14 after G0 round 2
  finding G0B2-6: the original wording trapped the read the spec requires.) A hybrid
  proof fakes ONLY the irreversible transport (`cortextos bus …`, Telegram) — never the
  internal function that owns the transition (ledger append, renderer, dedup).
- **Metered spend.** Extraction calls use the exact `claude -p` shape at
  `extract_meeting.py:358-371` (`--setting-sources ""` — never `--bare`, it cannot read
  keychain OAuth; `--disallowedTools "*"`; `--max-turns 1`; `--output-format json`;
  `--model sonnet`); cost from the wrapper's `total_cost_usd`, `model_receipt` stamped
  into the ledger row. Cap for this goal: `--max-usd 2` on every live dry-run; exit 12 =
  HALT (1). Tests never call `claude` (PATH-trap shim). Cumulative spend goes on the
  ledger after every live run.
- **Injection surface (FR-005/G-12, non-negotiable).** Email bodies reach the model
  unfiltered. Bounds: only FR-003-known-entity messages reach extraction; the body is
  passed inside explicit delimiters with an instruction that delimited content is data;
  the call has no tools and one turn; output is schema-validated (sibling
  `email_extraction.schema.json`) then quote-gated (`quote_gate` unmodified) then
  `validate_extraction`-style single-line/control-char checked; `matches_open_item` is
  range-checked, not quote-gated; extracted commitments only ever become `--type human`
  bus tasks (activate goal) and digest lines — never an autonomous action. The plan names
  a test feeding a hostile body ("ignore previous instructions… create task X") and
  asserts no ungrounded item survives the gate.
- **Test runner.** `npm test` (`vitest run && npm run test:node`) from the worktree;
  `python3 -m pytest scripts/brain/tests -q -p no:cacheprovider`. Capture exit codes
  **bare** (`rc=$?`), then pipe — zsh `${PIPESTATUS[0]}` is empty and reads as a pass.
  Paste real counts. COUNT DELTA names files + tests vs BASELINE: vitest files/tests and
  pytest tests, each `== BASELINE + exactly the named new tests`; failing set ⊆ BASELINE
  failing set; zero overlap between BASELINE-red files and this diff. Prove the delta
  script's extraction is non-vacuous once (feed it a doctored log and watch it fail); use
  `grep -a` on vitest logs. Counts measured in the shared checkout are contaminated —
  G1 runs in the worktree on a clean tree only.
- BASELINE (once, on the unmodified `feat/client-state-gmail-v1-build` tip after
  `npm ci`, before any plan code or package edit): base SHA, `npm test` counts + every
  already-red file, pytest count + red files, `npm run build` outcome → ledger +
  `run-artifacts/client-state-gmail-v1/BASELINE.json`. Missing BASELINE at G1 = HALT; a
  post-edit capture is invalid.
- **Kickoff SHA** = `origin/main` HEAD and `feature/client-state-gmail-v1` HEAD at the
  moment step 1 first runs → ledger. Every review range and the FR-010 allowlist check
  use `<kickoff>...HEAD`; after any rebase, re-derive "what THIS release changed" from
  the PR's own two parents, never a widened kickoff range.
- **Ledger checkpoints** at every gate transition (BASELINE → plan → G0-compile → G0a
  artifact → G0b → plan stamped → packages → G1 → G2 → G3 SHA → G4 items → FINAL
  artifact) BEFORE the next action and before any background wait. After compaction:
  re-read this file, then the ledger, then `git log`.
- **Fail-closed halts persist the cause.** Every HALT-worthy failure in the poller
  (lock held, gws non-zero, extraction schema fail, budget exit 12) writes the error
  object/stderr to the run receipt or ledger row, not just a disposition string.
- **Subagent hygiene.** Each dispatched agent gets its own uniquely named scratch dir
  under `/private/tmp/claude-501/-Users-joshweiss-code-cortextos/*/scratchpad/` and never
  cleans a sibling's; long runs (dry-run over 14 days, full suite) go to background tasks,
  never a supervising subagent. No subagent ever `grep -r`s `~/.cortextos`.
- **Standing facts carried from brain R1–R4 + R7 ledgers:** Grok out of credits (every
  grok gate `skipped-by-Josh`, never `clean`); `codex exec` needs `< /dev/null` or it
  blocks on stdin; check `codex login status` before attributing a slow reviewer to
  workload (a 401 retry loop reads as a large diff); `git check-ignore` takes a concrete
  path, never a glob; call bonesify/goalify scripts by REALPATH under
  `/Users/joshweiss/code/bones-dev-skills/` (the `~/.claude` symlink no-ops
  `record-gate`); the vault auto-sync cron may commit vault writes first — irrelevant here
  (no vault writes) but the copy-vault must be OUTSIDE `~/code/knowledge-sync`; `gws-dwd`
  needs system python3 `cryptography` (`python3 -c 'import cryptography'` before blaming
  the poller); `claude -p` 529 → retry once; a `sed` mutation that did not apply reads as
  a pass — diff the file first; one red is a reproduction request, not "flaky".
- Binding learnings (verbatim from goalify `references/learnings.md` + brain runs):
  - **A reviewer finding that contradicts a locked §Decisions row is rejected at G2, not folded.** → cite the D-row checked in the review artifact.
  - **Record the COUNT DELTA check as the G1 gate, not the raw `npm test` exit.** Use `grep -a` on vitest logs and `[^ ]+\.test\.ts` for paths.
  - **A "preview == apply" guarantee needs one shared derivation function, not two lookalikes.** Every projection the dry-run shows (CRM row, History entry, task title, escalation text, digest line) must be produced by the function the live path calls; one parity test per projection asserts byte-identical output on the same ledger row.
  - **Mutation-check the artifact users actually hit, not its oracle.** For every guard (lock, idempotency skip, escalate-once, tier-1 dedup, revision marker, claim refusal) name the mutation target on the production call path, run the control arm GREEN first, then the mutated arm RED; register each guard with an ID and assert every registered guard has a mutation row.
  - **A completeness check must bind per unit, not per file** — the G4 checker asserts each evidence item from its own artifact.
  - **Verification evidence a release adds needs a named reader** — the run receipt and ledger are read by the FR-009 digest section; the dry-run digest must actually print from them.
  - **After a rebase, `base...HEAD` is not your release** — use the PR's two parents.
  - **A gate scoped by tool name matches the tool's own source** — the PATH-trap shim log is scoped to the dry-run's PID tree, not to every `cortextos` on the box.

ASSUMPTIONS (inferred — named so review can attack them; each earns one in-pipeline
challenge, then it is settled unless Josh rules otherwise):
- A1. The reused comms-check query is the EXCLUSION clause verbatim (from
  `-category:promotions` through `-subject:"auto-reply"`); its `is:unread newer_than:5h`
  prefix is the attention lane's window and is replaced by day-granular `after:` /
  `before:` operators (G-10). The records lane never depends on read state.
- A2. Single-flight lock = `cortextos bus meeting-brief-claim --claims-dir <state-dir>/claims --ttl-min 60`
  (exact arg shape verified against `src/cli/bus.ts:2541-2555` in the plan) with
  heartbeat-touch = `os.utime()` on the claim file every ≤10 min during a run (the stale
  check is mtime-based — `meeting-brief.ts:368-416`); release via the matching release
  command. If the CLI cannot be pointed at this claims dir/name, the plan substitutes a
  Python mirror in `scripts/brain/single_flight.py` with identical semantics and says so.
- A3. Runtime state lives at `<repo-root>/state/client-state/` in the SHARED checkout:
  `observations.jsonl` (FR-001 ledger), `run-receipt.json` (FR-002), `claims/`,
  `invariants-baseline.json` (FR-009, committed once by the activate goal). The first
  three get one additive `.gitignore` line. In this goal `--state-dir` always points at
  a scratch copy.
- A4. Escalate-once (FR-003) is derived from the FR-001 ledger itself (latest row's
  resolution outcome `escalated` for the same `content_digest` ⇒ silent); no shared
  dedup store is touched. If any shared key is ever written it carries the `clientstate:`
  prefix.
- A5. Bus task creation from Python = `cortextos bus create-task <title> --assignee human --type human …`
  where `--type human` is the new flag P-bus adds; `--force-claim` (name per plan) is the
  deliberate-promotion override on `claim-task`. In this goal the call is only ever
  logged by the shim (dry-run), never executed.
- A6. The vault COPY is `rsync -a --exclude .git /Users/joshweiss/code/knowledge-sync/ <scratch>/vault/`
  (`make_variant.py` is meeting-specific); the CRM COPY is
  `cp -R orgs/clearworksai/agents/crm/crm <scratch>/crm`.

RELEASES (do ONLY R1 — never the activate goal's work)
[R1] Build the whole Gmail thin slice and prove it on copies. Packages (parallel where
  independent; P-bus and P-digest are independent of P-core; P-writes depends on
  P-core's ledger + P-extract's schema):
  - P-core `scripts/brain/client_state_gmail.py` (+ `observation_ledger.py`,
    `resolve_email.py`): FR-002 poller (`--days N` default 3, `--query`, `--dry-run`,
    `--repo-root`, `--vault`, `--crm-dir`, `--state-dir`, `--max-usd`; lock + heartbeat;
    run receipt; 50-cap day-sweep with per-day truncation report; gap detection line);
    FR-001 ledger (append-only JSONL rows exactly as FR-001 names them; terminal skip
    predicate = every resolution `filed` for the same `content_digest`; no-change
    re-checks write nothing; digest counts per distinct `source_ref`; supersede = new
    row + revision flag); FR-003 relevance (exclusion query verbatim per A1; sender →
    CRM contact email OR page-declared FULL domain; `ignored/no-known-entity`; ambiguous
    → `escalated` once; multi-party clean → fan-out); FR-004 standalone email→entity seam
    built from the imported pieces (`load_closed_sets` full-domain key only;
    contacts.json email lookup; `""`/None/duplicate-suppressed ⇒ no match; never call
    `_norm_title(None)`).
  - P-extract `scripts/brain/extract_email.py` + `email_extraction.schema.json`:
    FR-005 one bounded call per `(source_ref, content_digest, bound-entity set)`, cached
    in the ledger row, re-run when the bound set widens; context = union of bound pages'
    Open Items (`_open_rows`, status=open) + open email-sourced task titles with
    invocation-local ids 1..N; `matches_open_item` range-validated and quote-exempt;
    `quote_gate` + single-line/control-char + schema validation; injection test.
  - P-writes: FR-006 CRM row per known contact via the (copied in dry-run)
    `add-interaction.py --type email --source-ref gmail:<id>`; minimal contact
    auto-create via `upsert-contact.py` from From-header `{name, email}` only; FR-007
    `scripts/brain/writeback_email.py` renderer (`- YYYY-MM-DD — <subject> (email) [source: gmail:<id>]`
    + sub-bullets; append-only; a new digest for a known source_ref appends a marked
    revision entry — NOT `writeback_render.render_page`); FR-008 task dedup (tier-1
    casefolded owner match AND `difflib.SequenceMatcher` ratio > 0.75 on normalized
    text; tier-2 `matches_open_item`; deliberate `list-tasks --class … --limit …`
    enumeration via the shim in dry-run) + creation call shape per A5; suppressed
    duplicates recorded as evidence on the ledger row.
  - P-bus `src/bus/task.ts` + `src/cli/bus.ts`: `create-task --type human` (createTask
    accepts a type param; default stays `agent`); `claimTask` refuses a human-exempt
    task (`isHumanExemptTask`) unless the override flag is passed; vitest tests for both
    + a mutation row each (revert guard → red; control arm green first).
  - P-digest `scripts/brain/meeting_loop_watch.py`: `main()` restructured into
    independently failing sections (Fireflies section, Gmail section, each reporting its
    own error line; missing `FIREFLIES_API_KEY` no longer returns before notification);
    Gmail section = every ledger write in the last day (page + one line + source_ref),
    ignored-sender counts (backfill cue), suppressed-duplicate lines, "evidence
    superseded — review" lines for open tasks under a superseded digest, poller-gap line
    + named repair (`--days N`), per-day truncation lines, NEW invariant violations vs
    `invariants-baseline.json` (org name ≤1 page; domain ≤1 page; every post-epoch
    `gmail:` History ref present in the ledger — `gmail:` refs ONLY), and the one-line
    OK when nothing changed; `--dry-run` prints instead of `send-telegram`; long text
    split at 4096 is the existing api.ts behavior.
  - P-tests `scripts/brain/tests/test_client_state_*.py` + vitest: recorded `gws` JSON
    fixtures (secrets scrubbed) driven through a PATH-trapped `gws` shim (tests never
    reach the network); lock/heartbeat/stale-reclaim; ledger idempotency + terminal
    predicate + revision; day-sweep full coverage + freak-day report; relevance
    (ignored / escalated-once / fan-out); full-domain vs bare-label collision; None/""
    guards; extraction cache identity + widen-and-rerun; tier-1 threshold boundary
    (0.75 exactly ⇒ not a duplicate); supersede propagation flags; digest independence;
    parity tests per projection (preview == live function); hostile-body test; every
    guard registered with a mutation row.
  - P-ops `docs/pipeline/run-artifacts/client-state-gmail-v1/`: `BASELINE.json`,
    `g1-count-delta.sh`, `g4-check.sh`, `shims/{cortextos,gws-trap}` (gws trap is used
    by TESTS only; live dry-runs use the real `gws`), `coverage-diff.py` (FR-006 7-day
    diff tool: enumerates interaction rows the old comms-backfill path wrote that the
    new path did not, grouped by exclusion class — sent mail, automated sender, unknown
    entity — for the activate goal to run; unit-tested here on fixtures, NOT run live),
    `cron-precheck.sh` (greps a given crons.json for range-with-step forms; run against
    the 2026-08-11 fixture here, against the live fleet in the activate goal).
  DONE when: G0 plan once — G0-compile clean (both languages, each proven to bite) AND
  Opus G0a artifact (`run-artifacts/client-state-gmail-v1/G0-review-opus.json`) shows
  zero unfixed Critical AND G0b codex review clean (verbatim stdout in the artifact) AND
  G0c recorded `skipped-by-Josh` — gated by `bonesify record-gate --gate G0-review --cmd "node /Users/joshweiss/code/bones-dev-skills/goalify/scripts/verify-review-artifact.mjs --file <G0 opus artifact> --sha <plan commit>"`
  exit 0 → plan stamped (`b record-plan-artifact`) → packages implemented via
  `implementify` → G1 `record-gate --gate G1-suite` exit 0 with COUNT DELTA = exactly
  the named new vitest + pytest tests, failing set ⊆ BASELINE, zero overlap with the
  diff → G2 `codex review --base <kickoff>` clean + `codex challenge` clean (verbatim
  stdout in artifacts; every Important fixed and re-run pre-stage; every locked-decision
  finding dispositioned `rejected-contradicts-locked-decision` with the row) + FR-010
  allowlist check empty + G2c recorded skipped → G3 PR merged into
  `feature/client-state-gmail-v1` (merge SHA on the ledger; `origin/feature/client-state-gmail-v1`
  contains it) → G4 `record-gate --gate G4-matrix --cmd "bash docs/pipeline/run-artifacts/client-state-gmail-v1/g4-check.sh <G3 merge SHA>"`
  exit 0, where `g4-check.sh` asserts, each from its own machine artifact under
  `run-artifacts/client-state-gmail-v1/g4/`:
    1. `suite.json`: pytest + vitest counts at the G3 merge SHA equal the G1 record
       (same SHA, worktree clean).
    2. `shim-tests.log`: zero real `cortextos`/`gws`/`claude` invocations reached from
       the test suites (trap counters = 0 — the traps were exercised at least once by a
       positive-control test so a zero is not vacuous).
    3. `dry-run-<window>.txt` + `dry-run-<window>.ledger.jsonl` + `run-receipt.json`:
       `python3 scripts/brain/client_state_gmail.py --dry-run --days 3 --repo-root /Users/joshweiss/code/cortextos --vault <scratch>/vault --crm-dir <scratch>/crm --state-dir <scratch>/state --max-usd 2`
       (real `gws`, real inbox, read-only) exits 0 and its stdout carries, per message:
       `source_ref`, sender, each resolution `{slug, kind, method, outcome, reason}`,
       cached extraction summary + itemized outputs with the quote each was grounded on,
       CRM row preview, unified diff of the COPY page History section, task list with
       tier-1/tier-2 dedup verdicts, escalation text (if any), and a cost line
       (`cost_usd`, `model_receipt`). At least ONE message must be `filed` for a known
       entity; if the 3-day window has none, widen `--days` (max 14, still ≤ $2) and say
       so on the ledger. Receipt carries `{last_success_at, window_days, message_count}`.
    4. `no-prod-writes.json`: vault `git -C /Users/joshweiss/code/knowledge-sync status --porcelain`
       empty; sha256 of the shared `crm/contacts.json` + `crm/interactions.jsonl` before
       == after; `cortextos` shim log for the dry-run PID tree shows zero `create-task`,
       `send-telegram`, `add-cron`, `comms-filter` invocations; real-`gws` argv log (the
       poller logs every gws argv) shows only `+triage` / `+read` verbs.
    5. `idempotency.json`: an immediately repeated identical dry-run appends zero ledger
       rows, makes zero `claude` calls (cost delta 0.00), prints zero write previews, and
       exits 0; a third run with the lock file held by a live PID exits 2 without
       processing, the run receipt (`run-receipt.json`) is byte-identical to before, and
       the refusal cause lands in a SEPARATE diagnostic file (`last-lock-refusal.json`)
       — fail-closed halts persist their cause without falsifying the success receipt;
       with a stale lock (mtime and stored timestamp > 60 min old) the next acquire
       reclaims and runs (meeting-brief semantics: stale-cleared then win). (Amended
       2026-09-14 after G0 round 2 finding G0B2-7.)
    6. `digest-dry-run.txt`: `meeting_loop_watch.py --dry-run` with `FIREFLIES_API_KEY`
       unset and `CLIENT_STATE_DIR=<scratch>/state` prints the Gmail section built from
       the dry-run ledger + receipt (changes list, ignored-sender counts, gap line absent
       because receipt is fresh, invariants section reading a freshly written
       `invariants-baseline.json` with zero NEW violations) and a Fireflies error line —
       the message is still produced (independence proven).
    7. `bus-guards.json`: vitest output proving `create-task --type human` persists
       `type: 'human'`, `claim-task` on it exits non-zero with the task still `pending`,
       the override flag claims it, and each guard's mutation row (control green,
       mutated red, diff shows the mutation applied).
    8. `floor.txt`: verification floor layers named with their evidence paths.
  AND the verification floor holds: **This release is DONE only when Layer 1
  (deterministic: pytest + vitest COUNT DELTA via `g1-count-delta.sh`, `g4-check.sh`
  exit 0, `verify-review-artifact.mjs` exit 0 for G0 and FINAL) and Layer 3 (second
  opinion in fresh contexts: Opus G0a artifact, codex review + challenge stdout
  artifacts, Fable FINAL artifact) are reached and named in the ledger with their
  evidence, with Layer 2's honest substitute = the live read-only Gmail dry-run on copies
  (items 3–6). Reaching a lower layer than stated is a HALT, not a downgrade. If the
  stated layer turns out to be unreachable, stop and say so — do not silently substitute
  a weaker one.**

EACH ITERATION
0. Ledger checkpoint discipline per STANDING RULES; subagents by default; gates whose
   exit code is the evidence stay in this thread.
1. Re-read THIS file, then the ledger, then `git log` (worktree + `origin/feature/client-state-gmail-v1`).
   First run only: create the worktree, `npm ci`, push `feature/client-state-gmail-v1`
   by name from the shared checkout, record kickoff SHAs, capture BASELINE on the
   unmodified tip. On conflict about state: `origin/feature/client-state-gmail-v1` merge
   history alone resolves STAGED; the ledger alone resolves every earlier state and every
   package status.
2. One plan for R1: `Skill(planify)` →
   `/Users/joshweiss/code/cortextos/docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
   (vertical slices: poller skeleton + ledger → relevance + resolution → extraction →
   writes → bus guards → digest → ops; seams named per package; every A1–A6 assumption
   verified against the anchor it cites and recorded settled/changed). Persist the path
   on the ledger.
3. G0 on that plan before any product code: (a) G0-compile both languages with the
   injected-error proof; (b) G0a `Agent(model: "opus")` empirical — apply blocks to a
   throwaway worktree, run the named commands, record output, revert, confirm clean;
   artifact per the review-artifact contract; (c) G0b `codex exec` review of the plan
   file `< /dev/null`; G0c recorded skipped-by-Josh. Critical/Important → revise, re-run
   only the flagging reviewer, never the pre-fix verdict. Then
   `b record-plan-artifact <chain> goal-client-state-gmail-v1-build --path docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
   and `record-gate --gate G0-review` exit 0 on the ledger.
4. Implement: `Skill(implementify)` over the packages using ONLY the consume list
   (spec, plan artifact, this file, ledger); `tddify` on every product file; opus on the
   risk-upgrade packages; focused tests continuous; `reviewify` before handoff. Every
   guard gets an ID + mutation row as it is written, not at the end.
5. Validate: G1 once in the worktree on a clean tree — `record-gate --gate G1-suite`
   wrapping `g1-count-delta.sh check BASELINE.json <+vitest files> <+vitest tests> <+pytest tests>`;
   HALT if BASELINE is missing.
6. G2 once on the combined diff: `codex review --base <kickoff>` and `codex challenge`
   (brief quotes the spec's own decision text; attacks: injection bounds, idempotency,
   lock/heartbeat, tier-1 threshold, full-domain keys, FR-010 allowlist, no-prod-write
   boundary); fix Critical/Important, re-run the flagging gate; adjudicate locked-decision
   findings by row; FR-010 allowlist check; grok skipped recorded.
7. G3: `git fetch`; if `origin/feature/client-state-gmail-v1` moved past this branch's
   base, rebase and re-run G2 on the rebased diff (PR two-parent range); open PR
   `feat/client-state-gmail-v1-build` → `feature/client-state-gmail-v1`, plain merge,
   merge SHA → ledger. Then G4: run items 1–8, write each artifact, `record-gate --gate G4-matrix`.
8. Ledger at every transition; then FINAL.

FINAL REVIEW (whole spec, once — after R1's DONE-when holds and is merged, before HALT
clause (3)): grok critique recorded `skipped-by-Josh` (not run), then `Agent(model: "fable")`
once on `<kickoff SHA>..<origin/feature/client-state-gmail-v1 HEAD>` against the ENTIRE
spec AND given the produced artifacts (`run-artifacts/client-state-gmail-v1/g4/`), written
to `run-artifacts/client-state-gmail-v1/final-review-fable.json` per the review-artifact
contract; `record-gate --gate FINAL-review --cmd "node /Users/joshweiss/code/bones-dev-skills/goalify/scripts/verify-review-artifact.mjs --file docs/pipeline/run-artifacts/client-state-gmail-v1/final-review-fable.json --sha <HEAD>"`
exit 0. Zero-file-overlap findings are out of scope (note as likely unrelated). Critical
in un-promoted code → fix, re-run G1/G2/G4, re-run Fable on the corrected diff. Nothing
in this goal has promoted, so the already-promoted branch of the disposition rules cannot
apply; Important → watch item in the HALT-3 report with its verifying trigger.

DONE: R1 DONE-when holds (G0/G1/G2/G3/G4 with their `gate_invocation` exit-0 records)
AND FINAL is clean per its deterministic check, verified from THIS session's own pasted
output — not assumed. Then `b mark-done <chain> goal-client-state-gmail-v1-build --evidence <evidence.json>`
with `matrix: GREEN` (the G4 checker IS the matrix), the G3 merge SHA, and every
`gate_invocation` (G0-review, G1-suite, G2 codex cmds, G4-matrix, FINAL-review, each with
`model_requested`/`model_receipt`); carried blockers: the activate goal's entry
requirements (Josh /promote to main; explicit go for live cron + first live run; daemon
checkout on main). Do not auto-promote. Do not start the activate goal.

ENVIRONMENT (for the post-compaction reader)
- Ledger: `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-build.md`
  (in the shared checkout, outside the worktree; append-only).
- Worktree `/Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1` on
  `feat/client-state-gmail-v1-build`; shared checkout `/Users/joshweiss/code/cortextos`
  on `feature/client-state-gmail-v1` (dirty; daemon cwd; fetch/push only).
- Secrets: `orgs/clearworksai/secrets.env` in the shared checkout, read via
  `scripts/brain/envparse.py` — never `source` it, never print values; tests use fixture
  env files. `TELEGRAM_CHAT_ID` / `FIREFLIES_API_KEY` / bus paths follow
  `meeting_loop_watch.py:30-45`. `claude -p` auth = keychain OAuth (needs
  `--setting-sources ""`; `--bare` cannot see it).
- `gws` = `~/.local/bin/gws` → `gws-dwd` for gmail (Josh's clearworks.ai mailbox,
  DWD identity; no send verb exists); `gws gmail +triage --query '<q>' --format json --max 50`
  and `gws gmail +read --id <id>` (full mode has `body`); `--max` caps at 50, no
  pagination; `resultSizeEstimate` is meaningless; list order has no contract.
- CRM scripts: `orgs/clearworksai/agents/crm/crm/{add-interaction.py,upsert-contact.py}`
  — invoked as subprocesses; in dry-run the COPIED scripts under `<scratch>/crm/` (they
  resolve stores relative to `__file__`; `CRM_INTERACTIONS_PATH` also honored).
- Bus CLI: `cortextos bus …` (shim-trapped in this goal). Never call `bus comms-filter`
  from this lane. Never grep `~/.cortextos`.
- Review tooling by realpath: `/Users/joshweiss/code/bones-dev-skills/bonesify/scripts/bonesify.mjs`,
  `/Users/joshweiss/code/bones-dev-skills/goalify/scripts/verify-review-artifact.mjs`.
  `codex exec … < /dev/null`; `codex login status` first. Fable = `Agent(model: "fable")`
  or `claude -p --model fable --setting-sources ""`; record the receipt.
- Scratch root: this session's scratchpad dir (see system prompt); copies of vault/CRM
  live there, never under `~/code/knowledge-sync` or `~/Downloads`.
- `docs/` is gitignored at the repo root (probed 2026-09-14): every new file under
  `docs/pipeline/**` (plans, run-artifacts, review artifacts, ledgers) needs
  `git add -f <path>` or it silently never lands in the PR. Tracked files update
  normally. `git check-ignore -v <concrete path>` before assuming a commit carried it.

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

OVERRIDE: `/stage` = PR `feat/client-state-gmail-v1-build` → `feature/client-state-gmail-v1`
(plain merge). `/test-on-staging` = G4 checker over items 1–8 above. Grok gates recorded
`skipped-by-Josh`. Metered spend authorized to `--max-usd 2` per live dry-run. Zero
production writes in this goal — every write lands on copies. No merge to `origin/main`;
no cron install; no `bus create-task`; no Telegram send. The activate goal is a separate
condition and a separate human gate.
```
