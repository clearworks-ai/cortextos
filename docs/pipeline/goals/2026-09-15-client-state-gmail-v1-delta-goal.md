# Client State v1 — Gmail thin slice — R2 DELTA: event trigger + real-person relevance (`goal-client-state-gmail-v1-delta`)

```text
WORKFLOW PACK: fast-release
  Split reason: patch-1 spec (event trigger + real-person filter, Josh's directive
  2026-09-15) lands as its OWN release on top of R1 BUILD: same zero-production-write
  boundary as R1, proven on copies; Tier B infrastructure (FR-011, bucket D, Josh
  provisions Pub/Sub) is the sibling `2026-09-15-client-state-gmail-v1-tierb-goal.md`
  (human-gated); production activation (listener under launchd, retry cron, first live
  writes) stays in `2026-09-14-client-state-gmail-v1-activate-goal.md` (amended: ENTRY
  GATE E4 = this node done). Do NOT do the activate goal's or the tierb goal's work here.
  bonesify: chain `/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`,
  node `goal-client-state-gmail-v1-delta`, depends on `goal-client-state-gmail-v1-build`
  (its G3 merge into `feature/client-state-gmail-v1` is this release's base), staging
  mutex `cortextos-staging`.

MODEL MAP (defaults — rewrite before /goal if needed)
- plan draft: sonnet (`planify`)
- G0-compile: `python3 -m py_compile` over every plan Python block materialised at its
  declared path in a scratch tree, plus `npx tsc --noEmit -p tsconfig.json` if any TS
  block exists (none expected; if the plan has no TS block, record "no TS blocks" — a
  check matching zero files is not a pass). Inject one deliberate error per language ONCE.
- G0a empirical: `Agent(model: "opus")` applying the plan's code blocks verbatim to a
  throwaway worktree, running the exact commands the plan names, recording real output,
  reverting, confirming a clean tree. A prediction is not a finding.
- G0b: `codex exec … < /dev/null` review of the plan file (working-tree scope).
- G0c: grok-build:review — **NOT RUN: Grok out of credits (Josh 2026-09-05); record
  `grok: skipped-by-Josh`, never `clean`.** FINAL and G2 carry the same marker.
- implement packages: sonnet subagents under `implementify`; **opus** on the
  risk-upgrade packages P-classify (new model call + evidence gate + page creation),
  P-entry (queue/cursor/receipt semantics), P-listener (production listener hook).
- G1 full suite: `bonesify record-gate --gate G1-suite` wrapping
  `docs/pipeline/run-artifacts/client-state-gmail-v1/g1-count-delta.sh check BASELINE-r2.json …`
  vs a NEW BASELINE captured on this release's base — never the raw `npm test` exit.
- G2a: `codex review --base <kickoff SHA>`; G2b `codex challenge` — **REQUIRED, always**
  (diff touches `scripts/brain/**` and a production listener); briefs quote spec text
  VERBATIM. G2c grok — skipped-by-Josh (record).
- G4: `bonesify record-gate --gate G4-matrix` wrapping the EXTENDED
  `g4-check.sh <G3 merge SHA> --release r2` over items 1–9 below (per item, from its own
  artifact).
- FINAL: grok critique skipped-by-Josh (recorded), then `Agent(model: "fable")` ONCE on
  `<kickoff SHA>..<feature/client-state-gmail-v1 HEAD>` against the ENTIRE patch spec +
  base spec AND the produced artifacts (copy-vault diffs incl. the created page, the
  queue/receipt JSON, the listener regression log, the ledger JSONL);
  `record-gate --gate FINAL-review --cmd "node /Users/joshweiss/code/bones-dev-skills/goalify/scripts/verify-review-artifact.mjs --file <fable artifact> --sha <HEAD>"`.
- Every reviewer command's effective flags are echoed into its artifact
  (`gate_invocation`: cmd, flags, `model_requested`, `model_receipt`).

SOURCE OF TRUTH
- Patch spec (BINDING for every delta bullet; supersedes the base where it says so):
  `/Users/joshweiss/code/cortextos/state/specs/2026-09-15-client-state-gmail-v1-patch1-spec.md`
  → FR-002 (tiered trigger: durable queue `<state-dir>/inbox-queue.jsonl`, detached
  drain, `--drain-queue` / `--message-ids`, history cursor semantics, receipt split,
  gap-covering chained sweep), FR-003 (shared INBOX+labels predicate, parity fixture,
  fail-closed divergence, two-stage extraction, bind/create rules, free-mail contact
  binding via the FR-006 amendment, `created:`/`contact:` effects, `personal` ignored),
  FR-005 amendment, FR-009 trigger-health lines, FR-001 `created:` effect, FR-010
  allowlist extension, D-11 (corrected) / D-12, ledger G-18..G-38, assumptions A-06..A-10
  (owned by Josh — not findings). FR-011 is NOT built here (tierb goal).
- Base spec (BINDING for everything the patch does not change — FR-001, FR-004..FR-010
  as amended): `/Users/joshweiss/code/cortextos/state/specs/2026-09-14-client-state-gmail-v1-spec.md`.
- Mockup: N/A — backend only; mockup gate N/A.
- Chain: `/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`
- Release ledger (bonesify creates it at handoff; append, never rewrite):
  `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-delta.md`
- R1's ledger (read for adjudications that bind here — G2r3 rulings on stale-clear,
  `clientstate:` send-side key, merge-from-latest-non-simulated row, page-level History
  idempotency, gws error envelope, Cc carried, extraction attempt marker + one retry,
  no contact auto-create without display name, `multica/poll.ts` passes force):
  `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-build.md`
- Plan (written by EACH ITERATION step 2; stamped on the chain node):
  `/Users/joshweiss/code/cortextos/docs/pipeline/plans/2026-09-15-client-state-gmail-v1-delta.md`
- Run artifacts: `/Users/joshweiss/code/cortextos/docs/pipeline/run-artifacts/client-state-gmail-v1/`
  (R1's dir, extended: `BASELINE-r2.json`, `g4/r2-*`, G0/G2/FINAL artifacts suffixed
  `-r2`); patch-spec evidence in `run-artifacts/client-state-gmail-v1-patch1/`.
- Anchors verified 2026-09-15 by read-only probes (re-verify each before it decides a
  gate; a line number is a pointer, not a fact):
  | piece | anchor |
  |---|---|
  | listener: DWD token mint, 60 s `history.list` loop, 120 s debounce, spawn argv, hard-exclusion prefilter (NOT the comms-check clause) | `orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py:44`, `:147-151`, `:52-53`, `:286-291`, `:63-91` |
  | listener ONE synchronous loop (filter → pending_since → attention spawn → save_state → sleep 60) | `gmail_push_listener.py:478-512` |
  | listener stale-cursor 404 handling + profile bootstrap (attention lane only — the records lane's cursor rules are FR-002's) | `gmail_push_listener.py:255-268`, `:443-454` |
  | `history.list` called without `maxResults`/`pageToken` (one page) | `gmail_push_listener.py:209-218`, `:467-474` |
  | launchd plist (not loaded; state file absent) | `orgs/clearworksai/agents/pa-codex/scripts/com.clearworks.gmail-push-listener.plist:16` |
  | `FREE_MAIL` set; `domain_to_slug` binds every sender at a declared domain | `scripts/brain/resolve_meeting.py:18-31`, `:312-313` |
  | `normalize_quote` / `quote_grounded` (import read-only for the email-local evidence gate) | `scripts/brain/resolve_meeting.py:402-442` |
  | meeting classifier enum (client\|prospect\|vendor\|partner\|colleague\|personal\|internal) | `scripts/brain/extraction.schema.json:37-39` |
  | resolver page creation is inline in `resolve()` (meeting-shaped, SystemExit(5) without participants/text_units) — NOT reusable | `resolve_meeting.py:643-651`, `:691-695`, `:1093-1106` |
  | `writeback_render.planned_files` is meeting-shaped (mints a meeting note; never writes `domains:`) — NOT reusable | `scripts/brain/writeback_render.py:229-256`, `:324-350` |
  | client page template (Contacts / Current state / What we're delivering / Financials / History / Open Items) | `/Users/joshweiss/code/knowledge-sync/clients/_template.md` |
  | R1 entry argparse (`--repo-root --vault --crm-dir --state-dir --days --query --dry-run --max-usd --today`; no `--apply`) | worktree `scripts/brain/client_state_gmail.py:793-804` (re-locate after R1 merge) |
  | R1 `email_extraction.schema.json` (no `classification` field yet) | worktree `scripts/brain/email_extraction.schema.json` |
  | comms-check exclusion clause (verbatim) | `orgs/clearworksai/skills/comms-check-worker/SKILL.md:26` |
  | `gws gmail +read --id` full mode carries `labelIds` + `body`; `+triage --query` day-granular `after:`/`before:` | base G-09, G-10 |
  | bridge Gmail lane (`/relay/gmail-pubsub`, shadow default, cursor advanced before spawn) — READ-ONLY here, tierb goal | `src/daemon/provider-shadow-ingress.ts:144-168`, `:200-233`; `src/daemon/provider-lane-config.ts:37-43` |
  | `add-interaction.py` / `upsert-contact.py` invocation shapes; `--company` | `orgs/clearworksai/agents/crm/crm/upsert-contact.py:111`, `:180-200` |
  | pytest: `scripts/brain/tests/test_client_state_*.py` (R1); vitest untouched by this release | — |

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
- **Workspace.** R1 merged into `feature/client-state-gmail-v1` (G3 merge SHA on R1's
  ledger). Cut this release from THAT tip:
  `git -C /Users/joshweiss/code/cortextos fetch origin && git -C /Users/joshweiss/code/cortextos worktree add -b feat/client-state-gmail-v1-delta /Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1-delta origin/feature/client-state-gmail-v1`
  then `npm ci` there. The shared checkout `/Users/joshweiss/code/cortextos` is the
  daemon cwd with a dirty tree — **never** `checkout`/`reset`/`clean`/`stash`/`pull` it;
  `fetch` and `push origin feature/client-state-gmail-v1` (by name) only. Runtime inputs
  (`--repo-root`) point at the SHARED checkout; code under test runs from the worktree.
  If R1 is not yet merged when this goal starts, HALT (2): the dependency edge is the
  gate, not a suggestion.
- **G3 / G4 honest substitutes** (unchanged from R1): `/stage` = PR
  `feat/client-state-gmail-v1-delta` → `feature/client-state-gmail-v1`, plain
  `gh pr merge --merge`, never `--delete-branch`, never `origin/main` (Josh's /promote).
  `/test-on-staging` = the extended G4 checker. `diff-touches-ui.sh` not run: backend only.
- **Spec is BINDING; do not fix the spec's decisions while building.** Locked decisions a
  reviewer may NOT reopen (disposition `rejected-contradicts-locked-decision`, cite the
  row): D-12 event-driven tiered trigger (Tier A listener hook ≤120 s; window sweep =
  retry/backfill only); D-11 as CORRECTED (real-person filter + INBOX, create-home for
  unknown real senders, `personal` recorded and ignored); FR-002 durable queue + detached
  drain + never-blocking listener + receipt split + `users.watch` initial cursor +
  page-level checkpoints + uncapped chained gap sweep; FR-003 shared predicate +
  fail-closed one-directional runtime divergence + two-stage extraction + OURS_DOMAINS-only
  internal + free-mail never declares a domain + slug-collision rule + FR-006 amendment;
  FR-005 amendment (predicate-admitted senders reach extraction); FR-009 trigger-health
  lines; FR-010 allowlist extension; everything the base spec locks that the patch does
  not touch (D-01..D-10, FR-001 identity, FR-004 full-domain keys, FR-008 tier-1 > 0.75,
  FR-009 invariants + committed baseline). §Accepted assumptions A-06..A-10 are Josh's.
  **Provenance:** `directive` = D-11 (corrected), D-12 — each has HAD its one in-pipeline
  challenge (three Codex rounds on the patch spec, 2026-09-15) and is now settled;
  `settled` = every patch FR bullet; `inferred` = the assumptions under ASSUMPTIONS below.
  New scope → HALT (2). A decision Josh makes mid-run is locked from that moment: spec
  §Decisions row first, then this file, then the ledger line naming who/when.
- **FR-010 file allowlist (mechanical, extended per the patch).** Shared files this diff
  MAY modify: `scripts/brain/meeting_loop_watch.py`,
  `orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py` (queue append + detached
  drain ONLY; observables pinned), plus their tests, plus R1's own modules under
  `scripts/brain/` (`client_state_gmail.py`, `resolve_email.py`, `extract_email.py`,
  `email_extraction.schema.json`, `writeback_email.py`, `client_state_writes.py`,
  `client_state_projections.py`, `client_state_digest.py`, `observation_ledger.py`,
  `single_flight.py`, `gmail_source.py`, `runner.py`) and their tests. NEW files under
  `scripts/brain/`, `scripts/brain/tests/`, `docs/pipeline/**`, `state/client-state/` are
  free. `src/**` is READ-ONLY in this release (the bridge lane belongs to the tierb goal;
  `src/bus/task.ts` / `src/cli/bus.ts` / `src/bus/multica/poll.ts` were R1's and are
  closed). `resolve_meeting.py`, `writeback_render.py`, `extract_meeting.py`, the CRM
  scripts, `orgs/clearworksai/agents/crm/**`, `orgs/clearworksai/agents/pa-codex/**`
  (incl. the plist — loading it is the activate goal) are READ-ONLY: pieces are IMPORTED
  (`FREE_MAIL`, `OURS_DOMAINS`, `normalize_quote`, `quote_grounded`, `registrable_label`,
  `load_closed_sets`), never edited. G2 checks the allowlist mechanically:
  `git diff --name-only <kickoff>...HEAD` minus the allowlist must be empty or a Critical.
- **Listener observables regression (non-negotiable, FR-002/FR-010).** The hook in
  `gmail_push_listener.py` is `append_queue(ids, history_id) + Popen(drain argv, start_new_session=True)`
  and nothing else. A fake-clock test drives the same recorded history sequence through
  the loop before and after the hook and asserts byte-identical: prefilter decisions,
  `pending_since` transitions, attention spawn argv, spawn tick numbers, `save_state`
  contents. The drain is never `wait()`ed, never `communicate()`d, and the test proves a
  drain that sleeps 30 s does not shift a single attention tick. This test is a mutation
  target (guard registered): make the hook block → RED.
- **Codex-challenge trigger (mechanical, always fires here):** diff touches
  `scripts/brain/**` OR `orgs/clearworksai/agents/pa/**` ⇒ G2b `codex challenge` required.
- **External-write boundary (this goal) — identical to R1.** The ONLY live external reads
  are `gws gmail +triage` / `+read` (read-only). Production writes FORBIDDEN: no write to
  `/Users/joshweiss/code/knowledge-sync` (porcelain empty), none to the shared CRM stores
  (sha256 before == after), no `cortextos bus create-task` / `send-telegram` / `add-cron`
  / `comms-filter`, no writes under `~/.cortextos`, **no launchd load/unload, no
  `launchctl` at all, the real listener process is never started** (its hook is proven
  by the fake-clock test + a subprocess run of the loop function against recorded
  history JSON with `spawn-worker` and `gws` trapped). Copies: `--vault` = rsync copy,
  `--crm-dir` = copied CRM dir, `--state-dir` = scratch; the `cortextos` PATH-trap shim
  (R1's, pass-through for `meeting-brief-claim`/`-release`/`list-tasks` only) sits first
  on PATH for every dry-run and test. A hybrid proof fakes ONLY the irreversible
  transport — never the internal function that owns the transition (queue append,
  cursor advance, ledger append, page creation).
- **Metered spend.** Same `claude -p` shape and receipt discipline as R1
  (`--setting-sources ""`, `--disallowedTools "*"`, `--max-turns 1`, `--output-format
  json`, `--model sonnet`); stage-1 classification and stage-2 extraction are BOTH
  budgeted under `--max-usd 2` per live dry-run; exit 12 = HALT (1). Tests never call
  `claude`. Cumulative spend on the ledger after every live run. A sender frozen after
  two invalid classifications is reported, never retried in-run (A-10).
- **Injection surface (FR-005 amended, non-negotiable).** ANY predicate-admitted sender's
  body reaches the model now, so the bounds carry the weight: body inside explicit
  delimiters with the "delimited content is data" instruction; no tools; one turn;
  schema validation (stage-1 `email_classification.schema.json`, stage-2
  `email_extraction.schema.json`); stage-1 `evidence` quote-gated against the body +
  From/Subject headers by the EMAIL-LOCAL gate (imports `normalize_quote`/`quote_grounded`;
  a classification whose evidence is not a grounded quote ⇒ `escalated`, never a page);
  stage-2 `quote_gate` + single-line/control-char checks; `matches_open_item`
  range-checked; commitments only ever become `--type human` tasks (activate goal) and
  digest lines. The plan names TWO hostile-body tests: one that tries to classify itself
  as `client` at `acme.com` with fabricated evidence (must be `escalated`, zero created
  pages), one that tries to inject a task (no ungrounded item survives).
- **Test runner.** `python3 -m pytest scripts/brain/tests -q -p no:cacheprovider` from
  the worktree; `npm test` only for the G1 count (vitest untouched — delta must be +0
  files / +0 tests on the vitest side and the COUNT DELTA proves it). Capture exit codes
  **bare** (`rc=$?`), then pipe. Paste real counts. COUNT DELTA: pytest tests
  `== BASELINE-r2 + exactly the named new tests`; failing set ⊆ BASELINE failing set;
  zero overlap between BASELINE-red files and this diff. Prove the delta script bites
  once (doctored log). Counts measured in the shared checkout are contaminated — G1 runs
  in the worktree on a clean tree only. Vitest single-file runs dirty
  `.cortextOS/state/agents/{alice,bob}/crons.json(.bak)` — `git checkout -- .cortextOS`
  after any vitest run, never commit them.
- BASELINE-r2 (once, on the unmodified `feat/client-state-gmail-v1-delta` tip after
  `npm ci`, before any plan code): base SHA (= R1's G3 merge SHA), `npm test` counts +
  every already-red file (`tests/unit/daemon/lifecycle-store-lock.test.ts` is red on
  main since R1 kickoff — attribute, do not fix), pytest count + red files, `npm run
  build` outcome → ledger + `run-artifacts/client-state-gmail-v1/BASELINE-r2.json`.
  Missing BASELINE-r2 at G1 = HALT.
- **Kickoff SHA** = `origin/feature/client-state-gmail-v1` HEAD (R1 merged) at the moment
  step 1 first runs → ledger. Every review range and the allowlist check use
  `<kickoff>...HEAD`; after any rebase, use the PR's own two parents.
- **Ledger checkpoints** at every gate transition BEFORE the next action and before any
  background wait. After compaction: re-read this file, then the ledger, then `git log`.
- **Fail-closed halts persist the cause.** Queue entries are removed only after their
  ids are terminal or on a ledger row; a drain that dies mid-way leaves the queue intact
  and writes `last_event_error`; the lock-held exit 2 leaves `run-receipt.json`
  byte-identical and writes `last-lock-refusal.json` (R1 ruling).
- **Watchdog on every long-running agent (learned in R1 — a 7-hour silent integrator
  stall).** Every dispatched implementer/fixer/reviewer gets a background stall monitor
  (output-file idle > 25 min OR expected commit count reached ⇒ notify); never wait on a
  completion notification alone. Small residuals (< 30 min of work) are done in-thread,
  not re-dispatched.
- **Subagent hygiene.** Own scratch dir per agent under this session's scratchpad; long
  runs to background tasks, never a supervising subagent; no `grep -r ~/.cortextos`.
- **Standing facts carried from R1 + brain runs:** Grok out of credits (every grok gate
  `skipped-by-Josh`); `codex exec` needs `< /dev/null`; `codex exec -m gpt-5-codex` is
  refused on the ChatGPT account — use the default model; `codex login status` before
  attributing a slow reviewer to workload; `git check-ignore` takes a concrete path;
  bonesify/goalify scripts by REALPATH under `/Users/joshweiss/code/bones-dev-skills/`;
  `docs/` is gitignored — `git add -f`; `claude -p` 529 → retry once; "Credit balance is
  too low" from a nested `claude -p` = Max-plan window exhausted, NOT a missing key —
  wait for the window, never mint a key (Josh 2026-09-14); a `sed` mutation that did not
  apply reads as a pass — diff first; one red is a reproduction request, not "flaky";
  macOS bash 3.2 fails heredoc-in-`$()` — run plan Step 5 blocks with zsh; zsh
  `${PIPESTATUS[0]}` is empty.
- Binding learnings (verbatim from goalify `references/learnings.md` + R1):
  - **A reviewer finding that contradicts a locked §Decisions row is rejected at G2, not folded.** → cite the D-row in the review artifact.
  - **Record the COUNT DELTA check as the G1 gate, not the raw `npm test` exit.**
  - **A "preview == apply" guarantee needs one shared derivation function, not two lookalikes.** The created-page body, the `created:`/`contact:` effects, the trigger-health line and the divergence count the dry-run shows must be produced by the function the live path calls; one parity test per new projection.
  - **Mutation-check the artifact users actually hit, not its oracle.** Every new guard (queue-entry-removal-after-terminal, cursor-advance-after-terminal, page-level checkpoint, no-cursor ⇒ sweep, 404 ⇒ chained gap sweep, evidence gate ⇒ escalated, internal-only-for-OURS_DOMAINS, free-mail-never-declares-domain, slug-collision, personal-no-write, listener-never-blocks, predicate-divergence-fail-closed, frozen-after-two-invalid) gets an ID + a mutation row on the production call path: control GREEN first, mutated RED.
  - **A completeness check must bind per unit, not per file** — G4 asserts each item from its own artifact.
  - **Verification evidence a release adds needs a named reader** — the event receipt fields and `queue_depth` are read by the FR-009 digest; the dry-run digest must print from them.
  - **After a rebase, `base...HEAD` is not your release** — use the PR's two parents.
  - **A gate scoped by tool name matches the tool's own source** — shim logs are scoped to the dry-run's PID tree.
  - **A first-event cursor bootstrapped after the event loses the event** (patch round 2, P2-3) — the initial Tier B cursor is the persisted `users.watch` historyId; a push with no cursor is a sweep trigger. The plan's history-drain tests include the no-cursor case.

ASSUMPTIONS (inferred — named so review can attack them; one in-pipeline challenge each):
- B1. The listener hook imports nothing from `scripts/brain/` at module load (the listener
  runs under the pa agent's Python with no repo sys.path guarantee): the queue append is
  a 10-line local function writing `<state-dir>/inbox-queue.jsonl` with `O_APPEND` +
  one `json.dumps` line, and the drain argv resolves `client_state_gmail.py` by an
  absolute path from the listener's own config (`CLIENT_STATE_DRAIN_ARGV` env or a
  constant next to the existing spawn constants). `<state-dir>` for the records lane =
  `<repo-root>/state/client-state/` (R1 A3), not the listener's own state file.
- B2. `OURS_DOMAINS` exists in `resolve_meeting.py` (or the equivalent owned-domain set
  the resolver uses for rule 11 / `clearworks-internal`); if the name differs, the plan
  imports the actual symbol and says so. Never a new hardcoded list.
- B3. The parity fixture's oracle = a recorded `gws gmail +triage --query "<clause> in:inbox"`
  result over a scrubbed corpus vs the same corpus's `+read` records driven through the
  local predicate; recorded once in this goal from the real inbox (read-only), secrets
  scrubbed, committed under `scripts/brain/tests/fixtures/`.
- B4. Stage-1 classification prompt = the meeting classifier's relationship definitions
  (extract_meeting.py PROMPT section for `classification`) reused verbatim with an
  email framing; schema = `{org_name, domain, relationship(enum), confidence(0-1),
  evidence(string)}`; `domain` is REQUIRED to equal the sender's registrable domain or
  be empty (a model-invented domain ⇒ invalid ⇒ escalated).
- B5. The history drain is built and tested against RECORDED `history.list` JSON
  fixtures (page sequences, 404, empty) with a fake client; the live Tier B path is
  never exercised here (no subscription exists — G-29). `--history-id <id>` is the
  manual entry that the tierb goal will wire to the bridge.
- B6. The 2-hour retry sweep cron and the launchd load are activate-goal work; this goal
  only ships `cron-precheck.sh`-compatible cron text in `docs/pipeline/run-artifacts/client-state-gmail-v1/activation-r2.md`.

RELEASES (do ONLY R2 — never the activate or tierb goal's work)
[R2] Event trigger + real-person relevance, proven on copies. Packages (parallel where
  independent; P-predicate and P-classify are independent; P-entry depends on
  P-predicate; P-listener depends on P-entry's argv; P-digest depends on P-entry's
  receipt fields):
  - P-predicate `scripts/brain/gmail_predicate.py`: the ONE shared predicate (INBOX label
    AND no exclusion term matches; `-from:` / `-subject:` case-insensitive substrings;
    `-category:` → `CATEGORY_*` label ids) parsed FROM the verbatim comms-check clause
    (never a second hand-written list); `gmail_source.Message` retains `label_ids`, raw
    From, raw Subject; sweep query = clause + `in:inbox`; parity fixture (B3) + runtime
    one-directional divergence counter (`excluded`, reason `predicate-divergence`).
  - P-entry `scripts/brain/inbox_queue.py` (atomic append; entries `{ids, history_id,
    observed_at}`; removal only after terminal/ledgered) + `scripts/brain/gmail_history.py`
    (cursor file `{last_processed_history_id, last_processed_at}`; page-level enqueue
    before next page; receipt counters `history_pages/history_records/unique_ids/remaining`;
    404 ⇒ chained 7-day gap sweeps from `last_processed_at`, uncapped; no cursor ⇒ sweep
    trigger; watermark set only after the last chunk) + `client_state_gmail.py` entries
    `--drain-queue`, `--message-ids`, `--history-id` sharing the R1 processing path
    (lock, ledger identity, extraction cache, writes) and the receipt split
    (`last_success_at`/`window_days`/`message_count` ONLY from a completed full-window
    sweep; `last_event_run_at`, `event_ids_requested`, `event_ids_processed`,
    `queue_depth`, `last_processed_history_id`, `last_event_error` from event runs).
  - P-listener `gmail_push_listener.py`: `append_queue` + detached `Popen` hook at the
    point new INBOX ids are observed; fake-clock observables regression (see STANDING
    RULES); recorded-history subprocess run with traps.
  - P-classify `extract_email.py` stage 1 (`email_classification.schema.json`, email-local
    evidence gate, identity `(source_ref, content_digest, "classify")` cached on the
    row, one automatic retry then frozen) + `resolve_email.py` bind/create (`internal`/
    `colleague` ⇒ `orgs/clearworks-internal.md` iff sender domain ∈ OURS_DOMAINS else
    `escalated`; `personal` ⇒ `ignored/personal`, no page, no CRM; client/prospect ⇒
    `clients/<slug>.md`, vendor/partner ⇒ `orgs/<slug>.md`; slug = `registrable_label`
    or normalised org name; reuse only on identity match, else `<slug>-<label>`; FREE_MAIL
    senders never declare a domain — bind via CRM contact with `--company <org_name>`
    per the FR-006 amendment) + `writeback_email.create_page(kind, slug, org_name,
    domains, contacts)` seeding `clients/_template.md` sections with explicit `domains:`
    and `- CRM org name:` lines + `created:<path>` / `contact:<id>` ledger effects +
    classification-drift digest line + stage-2 under the final bound slug.
  - P-digest `client_state_digest.py` / `meeting_loop_watch.py` Gmail section:
    `trigger: DOWN/STALE (<reason>)` when the listener is not loaded (`launchctl list`
    READ via a trapped shim in tests; real read-only `launchctl list` in the dry-run is
    permitted — it is a read) or its `last_pull` > 10 min or `queue_depth` non-zero for
    > one drain interval; separate `last_success_at` / `last_event_run_at` lines;
    `created` lines; `predicate divergence` count; `classification drift` lines.
  - P-tests: recorded fixtures (queue, history pages, 404, empty, no-cursor, hostile
    bodies ×2, free-mail sender, owned-domain sender, external sender claiming internal,
    slug collision, personal); parity per new projection; every guard registered with a
    mutation row; listener regression.
  - P-ops: `g4-check.sh --release r2` items below; `g1-count-delta.sh` reused with
    `BASELINE-r2.json`; `activation-r2.md` (cron text for the retry sweep, launchd load
    command, watch-renewal note — for the activate/tierb goals; NOT executed here).
  DONE when: G0 plan once — G0-compile clean AND Opus G0a artifact
  (`run-artifacts/client-state-gmail-v1/G0-review-opus-r2.json`) zero unfixed Critical
  AND G0b codex clean AND G0c `skipped-by-Josh` — gated by `record-gate --gate G0-review`
  exit 0 → plan stamped (`b record-plan-artifact <chain> goal-client-state-gmail-v1-delta --path docs/pipeline/plans/2026-09-15-client-state-gmail-v1-delta.md`)
  → packages via `implementify` → G1 `record-gate --gate G1-suite` exit 0 (pytest delta =
  exactly the named new tests; vitest +0/+0) → G2 codex review + challenge clean
  (verbatim stdout artifacts `-r2`; every Important fixed and re-run; locked-decision
  findings `rejected-contradicts-locked-decision` with the row) + allowlist check empty +
  G2c skipped → G3 PR merged into `feature/client-state-gmail-v1` (merge SHA on the
  ledger) → G4 `record-gate --gate G4-matrix --cmd "bash docs/pipeline/run-artifacts/client-state-gmail-v1/g4-check.sh <G3 merge SHA> --release r2"`
  exit 0, where the checker asserts, each from its own artifact under `g4/r2-*`:
    1. `suite.json`: pytest + vitest counts at the merge SHA equal the G1 record.
    2. `shim-tests.log`: zero real `cortextos`/`gws`/`claude`/`launchctl` invocations
       from the test suites (positive-control exercised; zero is not vacuous).
    3. `dry-run-ids.txt` + `.ledger.jsonl` + `run-receipt.json`:
       `python3 scripts/brain/client_state_gmail.py --message-ids <3 real INBOX ids from a read-only +triage of the last 3 days> --dry-run --repo-root /Users/joshweiss/code/cortextos --vault <scratch>/vault --crm-dir <scratch>/crm --state-dir <scratch>/state --max-usd 2`
       exits 0; per message the R1 fields plus `predicate` verdict and (for an unknown
       real-person sender) the stage-1 classification with its grounded evidence quote,
       the bind/create decision, the unified diff of the CREATED page in the copy vault
       (template sections present, `domains:` empty for a free-mail sender, `- CRM org
       name:` set) and the `created:`/`contact:` effects on the row. At least ONE of the
       three ids must be an unknown real-person sender that ends `filed` with a created
       page; if the window has none, widen the id search (max 14 days, still ≤ $2) and
       say so on the ledger. Receipt shows `last_event_run_at` set and `last_success_at`
       UNCHANGED from a prior sweep run in the same state dir (the split proven).
    4. `dry-run-queue.txt`: a fabricated `inbox-queue.jsonl` holding those ids (two
       entries, one duplicate id) drained by `--drain-queue --dry-run …`: appends zero new
       ledger rows for the already-terminal ids, zero `claude` calls (cost 0.00), removes
       both entries, receipt `queue_depth: 0`, `event_ids_requested: 4`,
       `event_ids_processed: 3`.
    5. `history-fixtures.json`: the recorded-fixture history drain — 3 pages enqueued
       page-by-page (checkpoint proven by killing the fake client after page 2 and
       showing 2 queue entries + cursor unchanged), the 404 case producing chained gap
       sweeps sized from `last_processed_at` (fixture: 19 days ⇒ 3 chunks), the no-cursor
       case producing a sweep trigger, the empty case advancing the cursor with
       `event: empty`.
    6. `listener-regression.log`: the fake-clock observables test GREEN (before/after
       byte-identical) and its mutation row (blocking hook ⇒ RED); the recorded-history
       subprocess run of the loop function with `spawn-worker`/`gws` trapped shows exactly
       one queue append per new-id tick and one detached drain spawn (argv logged), and
       the trap log shows zero real spawns.
    7. `no-prod-writes.json`: vault porcelain empty; shared CRM sha256 before == after;
       `cortextos` shim log zero `create-task`/`send-telegram`/`add-cron`/`comms-filter`;
       gws argv log only `+triage`/`+read`; zero `launchctl load|unload|bootstrap`
       invocations anywhere in the run (read-only `launchctl list` permitted and logged).
    8. `digest-dry-run.txt`: `meeting_loop_watch.py --dry-run` with
       `CLIENT_STATE_DIR=<scratch>/state` prints `trigger: DOWN (listener not loaded)`
       (true on this host — G-21), the separate coverage/event lines, the `created` line
       for item 3's page, and the Fireflies error line; the message is still produced.
    9. `floor.txt`: verification floor layers named with their evidence paths.
  AND the verification floor holds: **DONE only when Layer 1 (deterministic: pytest
  COUNT DELTA, `g4-check.sh` exit 0, `verify-review-artifact.mjs` exit 0 for G0 and
  FINAL) and Layer 3 (fresh-context second opinions: Opus G0a artifact, codex review +
  challenge artifacts, Fable FINAL artifact) are reached and named in the ledger, with
  Layer 2's honest substitute = the live read-only dry-runs on copies (items 3–8).
  Reaching a lower layer than stated is a HALT, not a downgrade.**

EACH ITERATION
0. Ledger checkpoint discipline; subagents by default with stall watchdogs; gates whose
   exit code is the evidence stay in this thread.
1. Re-read THIS file, then the ledger, then `git log` (worktree + `origin/feature/client-state-gmail-v1`).
   First run only: confirm R1's node is `done` and its G3 merge is in
   `origin/feature/client-state-gmail-v1` (else HALT 2); create the worktree; `npm ci`;
   record kickoff SHA; capture BASELINE-r2 on the unmodified tip.
2. One plan for R2: `Skill(planify)` →
   `/Users/joshweiss/code/cortextos/docs/pipeline/plans/2026-09-15-client-state-gmail-v1-delta.md`
   (vertical slices: predicate + parity → queue + entries + receipts → history drain →
   listener hook + regression → classification + bind/create + page creator → digest →
   ops; seams per package; every B1–B6 assumption verified against its anchor and
   recorded settled/changed; every code block `# file:`-labelled). Persist the path.
3. G0 on that plan before any product code: compile (+ injected-error proof), Opus G0a
   empirical, codex G0b, grok skipped; Critical/Important → revise, re-run only the
   flagging reviewer. Then `b record-plan-artifact` and `record-gate --gate G0-review`.
4. Implement: `Skill(implementify)` over the packages using ONLY the consume list;
   `tddify` on every product file; opus on P-classify/P-entry/P-listener; focused tests
   continuous; guard IDs + mutation rows as written; `reviewify` before handoff.
5. Validate: G1 once in the worktree on a clean tree via `record-gate --gate G1-suite`.
6. G2 once on the combined diff: `codex review --base <kickoff>` and `codex challenge`
   (attacks: listener blocking / observables drift, queue loss on crash, cursor advanced
   before terminal, first-event loss, gap sweep coverage, predicate parity, evidence-gate
   bypass, free-mail domain declaration, internal-from-external, slug collision, personal
   write leak, injection); fix Critical/Important; re-run the flagging gate; allowlist
   check; grok skipped recorded.
7. G3: `git fetch`; if `origin/feature/client-state-gmail-v1` moved, rebase and re-run G2
   on the PR two-parent range; PR → plain merge; merge SHA → ledger. Then G4 items 1–9,
   `record-gate --gate G4-matrix`.
8. Ledger at every transition; then FINAL.

FINAL REVIEW (whole patch + base spec, once — after R2 is merged, before HALT clause (3)):
grok critique `skipped-by-Josh` (not run), then `Agent(model: "fable")` once on
`<kickoff SHA>..<origin/feature/client-state-gmail-v1 HEAD>` against BOTH specs AND the
`g4/r2-*` artifacts, written to `run-artifacts/client-state-gmail-v1/final-review-fable-r2.json`;
`record-gate --gate FINAL-review` exit 0. Critical in un-promoted code → fix, re-run
G1/G2/G4, re-run Fable on the corrected diff; Important → watch item with its trigger.

DONE: R2 DONE-when holds (G0/G1/G2/G3/G4 `gate_invocation` exit-0 records) AND FINAL is
clean per its deterministic check, verified from THIS session's own pasted output. Then
`b mark-done <chain> goal-client-state-gmail-v1-delta --evidence <evidence.json>` with
`matrix: GREEN`, the G3 merge SHA, every `gate_invocation`; carried blockers: activate
goal entry (Josh /promote to main; explicit go; daemon checkout on main; listener launchd
load; retry cron) and the tierb goal's Josh-owned provisioning. Do not auto-promote. Do
not start the activate or tierb goals.

ENVIRONMENT (for the post-compaction reader)
- Ledger: `/Users/joshweiss/code/cortextos/docs/pipeline/ledgers/2026-09-14-client-state-gmail-v1-goal-client-state-gmail-v1-delta.md`
- Worktree `/Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1-delta` on
  `feat/client-state-gmail-v1-delta`; shared checkout `/Users/joshweiss/code/cortextos`
  on `feature/client-state-gmail-v1` (dirty; daemon cwd; fetch/push only).
- Secrets: `orgs/clearworksai/secrets.env` via `scripts/brain/envparse.py` — never
  `source`, never print. `claude -p` auth = keychain OAuth (`--setting-sources ""`).
- `gws` = `~/.local/bin/gws` → `gws-dwd` for gmail; `+triage --query '<q>' --format json
  --max 50`; `+read --id <id>` full mode carries `labelIds`/`body`; 50 cap, no
  pagination; the listener mints its own DWD token from `~/.config/gws/service-account-key.json`
  (never read the key material; never print it).
- Listener: `orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py`; plist under
  `pa-codex/scripts/` (NOT loaded; do not load). Its state file does not exist on this
  host. `launchctl list | grep -i gmail` is empty (G-21) — the digest's DOWN line is the
  expected dry-run result.
- Review tooling by realpath under `/Users/joshweiss/code/bones-dev-skills/`; `codex exec
  … < /dev/null` with the default model; Fable = `Agent(model: "fable")`; record receipts.
- Scratch root: this session's scratchpad; copies of vault/CRM there only.
- `docs/` is gitignored — `git add -f` every new file under `docs/pipeline/**`.

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

OVERRIDE: `/stage` = PR `feat/client-state-gmail-v1-delta` → `feature/client-state-gmail-v1`
(plain merge). `/test-on-staging` = G4 checker `--release r2` over items 1–9. Grok gates
recorded `skipped-by-Josh`. Metered spend authorized to `--max-usd 2` per live dry-run
(stage 1 + stage 2 combined). Zero production writes; no launchd load; no listener
process started; no cron install; no `bus create-task`; no Telegram send; no merge to
`origin/main`. The activate and tierb goals are separate conditions and separate human
gates.
```
