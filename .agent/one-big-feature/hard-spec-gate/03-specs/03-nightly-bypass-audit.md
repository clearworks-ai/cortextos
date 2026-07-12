# Spec 03 — Nightly `pipeline-bypass-audit` cron + skill-optimizer transcript backstop

> Source design: `../01-research.md` §Skill-optimizer backstop + `../04-verify-round1-hardening.md`
> (rounds 1+2) + HOLE 3 (authorship provenance backstop). Depends on Spec 01 (`verifyChain` / `--verify`).
> Skill-optimizer reference clone: `/tmp/skill-optimizer/SKILL.md` (adapted, not imported wholesale).
> Regenerated 2026-07-12Z by the pipeline PLAN stage-runner.

## Why

The deterministic gates (Spec 02) block the **known** code-write paths at dispatch. Residual gap classes remain: a novel dispatch path, a future regex miss (2026-07-09 `REQ_RE` precedent), programmatic bus writes that predate the sink patch, AND — new with HOLE 3 — **provenance forgery**: an agent fabricating a synthetic subagent transcript so a hand-authored spec passes the emitter's authorship check. Per verify round 2, no OS privilege boundary exists to make that impossible; the audit is the designated backstop that makes it DETECTED within 24h and converted into a new gate, so each bypass happens at most once. `LARRY/scripts/enforcement-scan.sh` audits the memory corpus, not runtime bypasses — the audit feeds INTO it, does not replace it.

## Component A — nightly cron `pipeline-bypass-audit`

**Registration:** cortextOS cron on larry, nightly (e.g. 02:30), SILENT-OK semantics (no finding → log + `OK`, no Telegram).

**Implementation:** `LARRY/scripts/pipeline-bypass-audit.sh` (orchestration; shells to a small node helper in `dist/` for JSONL parsing — no new runtime deps).

**Inputs (trailing 24h):**
1. **Parent transcript:** `~/.cortextos/cortextos1/state/larry/conversation-buffer.jsonl` + archives. Parse the Claude JSONL shape (skill-optimizer §Step 1): `type:"assistant"` → `message.content[]` blocks of `type:"tool_use"`. Collect: every `Bash` tool_use matching `bus send-message (codexer|opencoder|opencode)` (extract `slug=`), every `gh pr create`, every `git push`, every **Task/Agent-tool spawn** (subagent launches — needed for the HOLE-3 check), and every `Write`/`Edit` tool_use targeting `**/.agent/one-big-feature/*/02-master-plan.md` or `*/03-specs/*` (needed for the HOLE-3 hand-authoring check).
2. **Git:** `git log --since=24h --all`, `git branch -r --sort=-committerdate`, `gh pr list --repo clearworks-ai/cortextos --state all --search "created:>24h-ago"` where available.
3. **Ledger:** `state/pipeline-ledger.jsonl`; `pipeline-stage-emit --verify` per discovered slug.
4. **Bus store (path #9 coverage):** messages enqueued to codexer/opencoder/opencode in the window directly from the bus store, diffed against the transcript-derived dispatch list — a bus message with no matching transcript `Bash` tool_use is itself a bypass signal (programmatic enqueue; the sink should have gated it, so its presence without a valid chain means sink bypass or pre-sink code).
5. **Subagent session files:** for every authored-stage ledger row in the window, the `transcript_path` it names (under `~/.claude/projects/`).

**Bypass signals (any of):**
- A codexer/opencoder/opencode dispatch, branch push, or PR in the window with **no valid signed ledger chain** covering its slug (missing rows, `BAD_SIG`, `CHAIN_BREAK`) — or no derivable slug at all.
- A chain violating the ordering invariant (`OUT_OF_ORDER`, or artifact mtimes out of forward order vs signed rows).
- A bus-store dispatch absent from the transcript (path #9).
- **HOLE-3 signals — see next section.**
- Advisory (logged, not paged alone): mtime change on `LARRY/.claude/hooks/*.sh`, `settings.json`, `bin/pipeline-stage-emit`, or `src/pipeline/` / `src/bus/message.ts` sources in the window (Spec 02 §3.6 belt for the theoretical self-edit hole).
- Exemption tally (Spec 02 §7): signed `exempt` rows over trailing 7 days > ~10 → one alert line in the page. Threshold, not a cap.

## HOLE-3 detection — did a real planning subagent produce this, or was it hand-authored in the Larry context?

This is the audit's designated backstop for the residual the dispatch gate cannot close airtight on a single local machine (no OS boundary, by decision). For **every authored-stage row** (`synthesize|plan|specs|review`) emitted in the window, run four cross-checks; any failure = a HOLE-3 bypass finding:

1. **Spawn-record match (the core check).** A real subagent run leaves a Task/Agent-tool spawn record in the PARENT transcript (Larry's conversation buffer): the tool_use that launched the stage-runner and its tool_result carrying the subagent's completion. Require: a spawn record exists in the window whose subject matches the row's slug (prompt text mentions the slug / OBF dir) and whose timing brackets the row's `ts` (spawn before emit, completion at-or-before emit). **A provenance row with no matching spawn record is a fabricated-transcript finding** — a synthetic session file can be written cheaply, but a coherent spawn record inside the parent buffer's append stream cannot be added without rewriting Larry's own live conversation history, which is strictly more work than running the real stage (the settled lazy-agent bar).
2. **Deep authorship re-check.** Re-run the emitter's reconstruction (Spec 01 §Authorship step 4b–c) independently: parse the row's `transcript_path`, reconstruct the artifact from its Write/Edit blocks, require sha == the row's `artifact_sha256`, and require the transcript still hashes to the frozen `transcript_sha256`. Catches post-emit tampering the dispatch-time freeze-check may not have run on (e.g. no dispatch happened yet).
3. **Structural plausibility of the session file.** The named transcript must live under `~/.claude/projects/`, have interleaved user/assistant turns with paired tool_use/tool_result blocks, a model/agent identity consistent with the row's `runner`, and timestamps consistent with the row's `ts`. A minimal fake (a bare JSONL of Write blocks) fails this cheaply.
4. **Hand-authoring cross-check (catches tonight's exact failure directly).** From input 1, any `Write`/`Edit` in LARRY'S OWN buffer targeting `02-master-plan.md` / `03-specs/*` for a slug that ALSO has an authored-stage ledger row claiming subagent provenance in the window = the smoking gun: the gated agent wrote the planning artifact itself and then laundered it. Flag even if checks 1–3 pass (belt over the emitter check). Larry writing planning drafts WITHOUT a corresponding provenance row is fine (drafts are untrusted, not forbidden) — the finding is the COMBINATION of Larry-authored bytes + a subagent-provenance claim.

**Stated residual after this backstop:** an agent that fabricates a synthetic session file AND injects a matching fake spawn record by rewriting its own conversation buffer would evade checks 1–4. That is deliberate, effortful forgery — the MALICIOUS-agent case Josh explicitly ruled out of scope (verify round 2); it is not reachable by the lazy-shortcut path this system defends against, and buffer rewriting itself trips the advisory mtime scan when it touches archived segments. No cheaper closure exists without the rejected OS boundary; this residual is hereby ROUTED here, named, with the detection method above — not left silent.

**On a hit (exactly the research's 3 actions):**
1. Write `feedback_pipeline_bypass_<date>_<slug-or-unknown>.md` into larry's memory dir: the bypass, the exact gap (which check missed and why), evidence (transcript line refs, git SHAs, ledger verify output, spawn-record search result).
2. File a bus task (`cortextos bus create-task`) to add the missing enforcement, tagged for `enforcement-scan.sh` pickup — the finding cannot decay to prose-only.
3. Page Josh **once** (single Telegram, all findings of the night batched).

**Output artifact:** `LARRY/state/bypass-audit/<YYYY-MM-DD>.json` — `{window, dispatches_found, prs_found, chains_verified, provenance_rows_checked, bypasses:[…], advisories:[…], exempt_count_7d}`. Empty-bypass runs still write it (the audit must not be self-attesting silence).

## Component B — skill-optimizer adaptation (analysis layer)

Adapt the cloned skill-optimizer to audit **pipeline-following**. Install as `~/.claude/skills/pipeline-audit/SKILL.md` (invoked by Component A on a finding; available manually).

**Kept:** the JSONL parsing pattern (§Step 1) verbatim; the scored-dimensions report + `history.json` trend tracking (§Steps 4–6); the "exact diff" output discipline (findings end in a concrete patch proposal).

**Changed:**
- **Reference document:** `LARRY/PIPELINE.md`'s stage contract (each stage emitting a provenance-carrying ledger row), not a SKILL.md.
- **Dimensions (6, rescoped):** 1) Stage coverage per slug; 2) Forward order (transcript timestamps AND ledger `ts`); 3) Emission fidelity (each stage emitted; row sha matches artifact); 4) **Provenance fidelity (HOLE 3)** — authored-stage rows pass checks 1–4 above; 5) Scope fidelity (dispatched scope-sha == signed spec); 6) Gate integrity (blocked-then-retried-around patterns, hook edits, denied-path probes).
- **Output:** `skill-improvement/pipeline-audit/<date>-analysis.md` + `<date>-diff.patch` targeting the gate scripts / audit script (a proposed new enforcement). Diffs are proposals only — routed into the Component-A bus task, landed via normal PR flow (the audit must not self-modify gates).

## Acceptance tests

1. **Seeded bypass:** fixture window (fixture buffer JSONL + fixture ledger) with one codexer dispatch, no chain → one `feedback_*.md`, one bus task, one page payload, run record `bypasses:[1]`.
2. **Clean window:** valid provenance-carrying chains for all dispatches, spawn records present → no page, no task, run record with `bypasses:[]`.
3. **Ordering violation:** plan-before-research mtimes → flagged.
4. **Path #9:** bus-store message with no transcript tool_use → flagged.
5. **HOLE-3 / no spawn:** authored-stage row with a structurally-valid fixture transcript but NO Task spawn record in the fixture parent buffer → flagged as provenance forgery (check 1).
6. **HOLE-3 / tampered transcript:** row valid at emit, transcript modified in fixture → flagged (check 2).
7. **HOLE-3 / hand-authoring combo:** fixture parent buffer contains Larry `Write` to `02-master-plan.md` for a slug that also has a provenance-claiming `plan` row → flagged (check 4) even though checks 1–3 pass.
8. **Batching:** 3 findings in one window → exactly one Josh page containing all 3.
9. Parser unit test against a real (sanitized) buffer excerpt — nested tool_use extraction (incl. Task spawns) matches expected list.
10. **Exemption threshold:** fixture with 11 signed exempt rows in 7 days → alert line present; 9 rows → absent.
