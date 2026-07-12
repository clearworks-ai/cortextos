# Spec 02 — Gate Rewrites (dispatch gate, PR gate, write-block, settings, bus SINK)

> Source design: `../01-research.md` §Proposed real fix (files 1, 2, 4, 5) + §Code-write paths gaps
> (b)(c)(d) + `../04-verify-round1-hardening.md` HOLE 2 (sink enforcement, rounds 1+2) + HOLE 3
> (authorship provenance). All paths under `orgs/clearworksai/agents/larry/` (`LARRY/`) except §6
> (`src/bus/message.ts`, repo-root). Depends on Spec 01 (`verifyChain` / `pipeline-stage-emit --verify`).
> Regenerated 2026-07-12Z by the pipeline PLAN stage-runner.
>
> **Enforcement layering (verify rounds 1+2):** §6 — the dispatch SINK — is the AUTHORITATIVE
> gate: it fires at DISPATCH, before any code exists, and every path (CLI, node, MCP, direct
> enqueue) funnels through it. The shell hooks in §1–§5 are EARLY, friendly, defense-in-depth. A
> shell hook alone was HOLE 2. There is NO runtime privilege boundary (rejected, round 2); the
> gate-machinery files themselves are review-protected per Spec 04 + audited nightly per Spec 03.

## 1. `LARRY/.claude/hooks/gate-codexer-planning.sh`

Current: PreToolUse `Bash` hook (`settings.json:88`), self-filters to `bus send-message (codexer|opencoder)` (`:35`); passes on `GATE: build` + existence/freshness of `02-master-plan.md` + `03-specs/` within 14 days + literal `## Lessons Consulted` (`:81-97`).

Rewrite:

1. **Worker regex** (`:35`): `(codexer|opencoder)` → `(codexer|opencoder|opencode)` — closes research gap #2.
2. **Keep** the `GATE:` directive requirement and `GATE: comms` free-pass (`:43-52`) unchanged.
3. **Replace the file-proxy block (`:81-97`)** for `GATE: build` with hard-fail checks (`decision:block` / exit non-zero, reason on stderr):
   - **(a) Signed chain + provenance:** `bin/pipeline-stage-emit --verify --slug "$SLUG" --through specs --max-age 86400 --scope-sha "$SCOPE_SHA"` must exit 0. This proves in one call: every row `research→plan→specs` has a valid HMAC and chains correctly; the terminal `specs` row is ≤24h old (verify round 1 — freshness is not the security, the chain is; 24h kills "ancient spec authorizes forever" without false-blocking long days); **every authored-stage row (`plan`, `specs`, and `synthesize`/`review` if present) carries valid subagent-authorship provenance** (HOLE 3 — `NO_PROVENANCE`/`TRANSCRIPT_MISSING`/`TRANSCRIPT_TAMPERED` all block); and the dispatched `scope-sha` equals the terminal row's `artifact_sha256`. The 14-day `find -mtime -14` check is deleted.
   - **(b) Ordering invariant:** reject if `REPO/.agent/one-big-feature/SLUG/02-master-plan.md` mtime **precedes** `01-research.md` mtime, and reject if any required artifact (`01-research.md`, `02-master-plan.md`, `03-specs/`) lacks a matching signed ledger row (compare on-disk sha vs the row's `artifact_sha256`). Deterministically catches the comms-dedup-pipe back-fill signature. Live-recompute of `03-specs/` sha also catches "dir edited after signing".
   - **(c) Content-binding:** the dispatch command must carry `scope-sha=<64-hex>` in its `GATE: build` directive; extracted and passed to `--scope-sha` above. A plan pasted or hand-edited after the fact fails twice over: its sha was never signed (SCOPE_SHA_MISMATCH) AND it has no authoring transcript (Spec 01 §Authorship — no row could exist for it at all).
4. **m2c1 arm** (`:90-94`): same replacement — signed chain through `specs` for the slug; `PHASES.md` mtime-freshness deleted.
5. **Exempt path:** `GATE: build … exempt=true` passes ONLY if `pipeline-stage-emit --verify --slug "$SLUG" --through exempt --max-age 86400` succeeds. Hand-written exempt markers no longer exist in the trust set.
6. Block messages must name the exact failed check (`NO_ROWS` / `BAD_SIG` / `CHAIN_BREAK` / `OUT_OF_ORDER` / `STALE` / `SCOPE_SHA_MISMATCH` / `NO_PROVENANCE` / `TRANSCRIPT_MISSING` / `TRANSCRIPT_TAMPERED` / `ORDERING`) so a legitimate run self-corrects by running the missing STAGE — never by touching a file. In particular a `NO_PROVENANCE` block message states plainly: "the plan/specs for this slug were not produced by a pipeline stage-runner — run the plan stage, do not hand-author."

## 2. `LARRY/.claude/hooks/gate-pr-push.sh`

Current: PreToolUse `Bash` (`settings.json:83`); blocks `git push … main` (`:32-36`, KEEP unchanged); passes `gh pr create` on two self-written markers (`:39-51`).

Rewrite the `gh pr create` arm (`:41-47`):

1. **Drop both marker files from the trust set entirely.** They are no longer read.
2. **Slug↔branch binding:** derive `SLUG` from the current branch (`git rev-parse --abbrev-ref HEAD`), convention `*/<slug>` or `*-<slug>`; block with a clear message if underivable.
3. **Signed chain to true-verify:** `bin/pipeline-stage-emit --verify --slug "$SLUG" --through true-verify --max-age 86400` must exit 0 — which also enforces provenance on the chain's authored rows including `review` (a hand-written "review passed" cannot exist as a signed row without an Opus-review subagent transcript that authored the review artifact).
4. **Evidence non-empty:** terminal `true-verify` row's `evidence_path` exists and is non-empty (`[ -s "$EVIDENCE" ]`) — emitter enforces at emit (Spec 01 exit 4); the gate re-checks at PR time so deleted/truncated evidence blocks.
5. Hard block on any failure, naming the failed check.

## 3. `LARRY/.claude/hooks/block-direct-coding.sh`

Current: real block on Larry Edit/Write of source extensions (`:42-45`), but the free-pass list (`:26-30`) exempts `*/.agent/*`, `*.md/.txt/.csv`, `*/state/*`, `*pipeline-run*`, and `.claude/hooks/*.sh` + `settings*.json`.

Changes:

1. **Remove `*pipeline-run*` from the free-pass** (`:30`). The file is no longer trusted by any gate AND the write is denied — belt and suspenders.
2. **Narrow `*/state/*`:** explicit allowlist of Larry-owned basenames (`current-mission.txt`, `current-scope.txt`, …); deny everything else under `state/`, in particular `pipeline-review-pass.json`, `pipeline-run.json`, `pipeline-ledger.jsonl`, `pending-pipeline.json`.
3. **Explicit deny (Read AND Write/Edit AND Bash-mediated) on:**
   - `~/.pipeline-secret` (any path ending `/.pipeline-secret`).
   - `pipeline-ledger.jsonl` write/append (Read of the ledger stays allowed — rows are useless to a forger without the secret). Match quote-stripped command text for `tee|>>|>|cp|mv|sed -i|dd` targeting the path, per the existing gate pattern.
4. **NEW (HOLE 3 belt) — deny agent writes under `~/.claude/projects/`** (Write/Edit and Bash-mediated). Session transcripts are the authorship evidence the emitter and audit trust; agents have no legitimate reason to write session files. This is defense-in-depth only (a hook is self-administered — acknowledged); the authoritative HOLE-3 detection is the nightly audit's spawn-record cross-check (Spec 03 §HOLE-3).
5. Keep `*/.agent/*` and `*.md` writes allowed — planning docs remain agent-writable BY DESIGN (Larry must be able to draft notes/research); they are simply **untrusted until a provenance-valid ledger row signs their sha**. The gates, not the write-block, enforce that — and after HOLE 3, an authored-stage row can only exist if a stage-runner's transcript wrote the exact bytes, so a Larry-drafted plan file can never become a trusted plan.
6. **Hook/settings self-edit (framing settled in verify round 2):** the free-pass of `.claude/hooks/*.sh` + `settings*.json` stays — Larry must be able to PROPOSE hook changes via PR. The "agent edits its own hook source" hole is theoretical (never hit) and its belt is cheap: (a) any change to those files must merge through Josh's CODEOWNERS review (Spec 04); (b) the nightly audit flags any hook/settings/emitter mtime change in the trailing 24h as an advisory (Spec 03). No runtime privilege boundary — explicitly rejected.

## 4. `LARRY/.claude/settings.json`

1. **Remove the `validate-active-spec.sh` hook entry (`:93`).** One stale shared `specs/active/` spec rubber-stamps every dispatch (research path #8). Delete the wiring; prefer deleting the script too.
2. **`gate-directive-detect.sh` (research path #7, dead-wired):** partner script doesn't exist. **Delete** it. Directive-miss coverage moves to the nightly audit (content-based, not another regex allowlist).
3. No other wiring changes. `gate-pipeline-route.sh` (inject-only) and `gate-pipeline-stop.sh` stay as in-turn reminders; their marker-based pass-conditions are moot (markers write-denied + untrusted). Follow-up (out of scope): re-point `gate-pipeline-stop.sh` at `pipeline-stage-emit --verify` so its block message stops referencing a dead file.

## 5. `LARRY/PIPELINE.md` (doc change)

Add a "Stage emission contract" section: every stage (research/synthesize/plan/specs/review/true-verify) MUST be emitted at completion via `bin/pipeline-stage-emit`; **for authored stages the pipeline runner invokes the emitter at subagent completion, passing `--runner`, `--session <task/session id>`, `--transcript <subagent session .jsonl>`** (Spec 01 §Authorship). A stage that does not emit did not happen; a planning artifact without subagent-authorship provenance is untrusted by definition and will block at dispatch. Exemptions are `--stage exempt --reason "…"` signed rows only.

## 6. `src/bus/message.ts` — SINK enforcement (HOLE 2 + HOLE 3 verification point, AUTHORITATIVE)

> Every dispatch path — CLI `bus send-message`, programmatic callers, MCP, direct enqueue — funnels
> through the single sink `sendMessage(paths, from, to, priority, text, replyTo)` (`message.ts:51`),
> which writes the inbox file. Gate the ACTION there: the block fires at dispatch, before any code
> is written (verify round 2 — gating at merge would leave all programming ungated).

Add a build-dispatch guard inside `sendMessage`, evaluated **after** validation (`:61`) and **before** the inbox write (`:82-85`):

1. **Trigger condition:** `to ∈ {codexer, opencoder, opencode}` AND `text` contains a `GATE: build` directive (same detection as the §1 shell hook; `GATE: comms` / acks / non-build traffic untouched — the sink must not break normal fleet comms).
2. **Extract** `slug` and `scope-sha` from the directive (shared parser with the shell hook so the two never diverge).
3. **Verify** by importing `verifyChain` from `src/pipeline/ledger.ts`: `verifyChain({ledgerPath, secretPath, slug, throughStage:'specs', maxAgeSeconds:86400, scopeSha})`. This is the ONE verify implementation — emitter binary, bash gates (via `--verify` CLI), and this sink all funnel to it; no second crypto. It checks, per Spec 01: sig chain, order, freshness, content-binding, **and HOLE-3 provenance — every authored-stage row must carry valid, frozen subagent-authorship provenance** (`NO_PROVENANCE` / `TRANSCRIPT_MISSING` / `TRANSCRIPT_TAMPERED` block). A build whose plan/specs were hand-authored in the Larry context is therefore blocked AT DISPATCH even if it arrived via a path no shell hook ever saw. The daemon process reads the secret to recompute sigs — permitted: the sink is compiled daemon code, not an agent tool call.
4. **On failure:** throw a `BuildGateError` (new, exported) carrying the failed-check code (`NO_ROWS` / `BAD_SIG` / `CHAIN_BREAK` / `OUT_OF_ORDER` / `STALE` / `SCOPE_SHA_MISMATCH` / `NO_PROVENANCE` / `TRANSCRIPT_MISSING` / `TRANSCRIPT_TAMPERED`). The dispatch is NOT written — the message never reaches the worker's inbox. CLI callers surface the message; programmatic callers get the thrown error.
5. **Fail-closed + loud (verify round 1 Q4):** ledger or secret missing/unreadable → throw naming the missing artifact AND the single restore command, e.g. `PIPELINE_GATE_BROKEN: signing secret unreadable at ~/.pipeline-secret — restore with 'bin/pipeline-provision-secret' (Josh-run); build dispatch blocked (only Josh overrides)`. Never silently pass, never silently stall. `GATE: comms` traffic still flows in this state.
6. **Non-duplication:** sink and §1 hook enforce the SAME invariant via the SAME function. The hook is early friendly feedback in the agent turn; the sink is the one non-shell paths cannot skip.

## 7. Exemption alerting (verify round 1 Q3) — no hard cap

Exemptions remain unlimited (a cap would block legitimate trivial work) but counted: the nightly audit (Spec 03) tallies signed `exempt` rows over the trailing 7 days and, when >~10/week, adds one line to its existing Josh page. Alert threshold, not an enforcement cap; sink/hook never block on count.

## Tests

Shell-level tests (bats or plain-bash harness in `tests/`) for §1–§4, TS unit tests for §6, each asserting exit code / thrown error + block-reason string:

1. Dispatch with hand-authored plan files, no ledger → block (`NO_ROWS`).
2. Dispatch with full valid provenance-carrying chain + matching `scope-sha` → pass.
3. Valid chain but `02-master-plan.md` mtime < `01-research.md` mtime → block (`ORDERING`).
4. Valid chain but `03-specs/` edited after signing → block (`SCOPE_SHA_MISMATCH`).
5. Chain terminal row 25h old → block (`STALE`); 23h old → pass.
6. `send-message opencode 'GATE: build …'` with no chain → block (regex coverage).
7. `gh pr create` with hand-written markers, no chain → block.
8. `gh pr create` with chain through `true-verify` + non-empty evidence + slug-bearing branch → pass.
9. Larry `Write` to `state/pipeline-run.json` → denied. `Bash: echo … >> state/pipeline-ledger.jsonl` → denied. `Read ~/.pipeline-secret` → denied. **`Write` to `~/.claude/projects/**/*.jsonl` → denied (HOLE-3 belt).**
10. `GATE: build … exempt=true` with no signed exempt row → block; with signed row → pass.
11. **Sink (§6):** `sendMessage(paths,'larry','codexer','normal','GATE: build slug=x scope-sha=…')` called directly (no shell) with no valid chain → throws `BuildGateError`, inbox NOT written. With a valid chain → written normally.
12. **Sink fail-closed (§6.5):** ledger/secret removed → build dispatch throws `PIPELINE_GATE_BROKEN` naming path + restore command; `GATE: comms` to codexer in the same state still delivers.
13. **HOLE 3 at the hook:** chain whose `plan` row was emitted from a fixture WITHOUT provenance fields (crafted legacy-shape row, re-signed with the test secret) → `--verify` fails `NO_PROVENANCE`; dispatch blocked with the "run the plan stage, do not hand-author" message.
14. **HOLE 3 at the sink:** same fixture via direct `sendMessage` → `BuildGateError('NO_PROVENANCE')`, inbox not written. Fixture with provenance but transcript deleted → `TRANSCRIPT_MISSING`; transcript modified post-emit → `TRANSCRIPT_TAMPERED`.
15. **HOLE 3 end-to-end honest path:** fixture subagent transcript whose writes produced `02-master-plan.md` + `03-specs/` → emit succeeds with provenance → hook AND sink both pass → message delivered.
