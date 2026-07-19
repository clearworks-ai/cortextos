# 01 — Research: Kimi K3 → provenance bridge

## Problem

PR #119 added `kimi-k3` as a third pipeline plan-engine (`routing-config.json` → `plan.engines`,
`routing-policy.js`). Its resolution returns `{provider:'openrouter', model:'moonshotai/kimi-k3',
dispatch:'opencode', fallback:'opus', on429:'opus'}` — i.e. the plan stage is dispatched to the
**Opencoder bus worker**, NOT run as a Claude Agent-tool subagent.

But the pipeline's **provenance gate** blocks the codexer/opencoder build dispatch unless the
`plan` and `specs` stages carry provenance-signed ledger rows. Those are **authored stages**
(`src/pipeline/ledger.ts` → `AUTHORED_STAGES = {synthesize, plan, specs, review}`). For an authored
stage, `emitLedgerRow` requires `--runner --session --transcript` and calls
`verifyTranscriptAuthorship`, which:
- resolves the transcript path with `ensureInsideRoot(transcriptPath, defaultTranscriptRoot())`
  where `defaultTranscriptRoot()` = `~/.claude/projects` (or `PIPELINE_TRANSCRIPT_ROOT_OVERRIDE`);
- replays the transcript's **Claude jsonl** Write/Edit tool ops (`parseTranscriptOps`) and
  reconstructs bytes to compare against the on-disk artifact.

The Opencoder worker writes its session transcript to
`~/.cortextos/cortextos1/state/opencode/conversation-buffer.jsonl` — **outside** the projects root
and in a **different format** than Claude jsonl. So a kimi-k3-authored plan/specs artifact can
never satisfy `verifyTranscriptAuthorship` today.

**Net:** PR #119 wired the routing CHOICE but never built the provenance bridge. Its own
`add-kimi-k3-planner/01-research.md:23` flagged this as an OPEN scope question ("CONFIG+DISPATCH-
PATTERN, not new src/ code"). Result: a K3-planned build is impossible to dispatch through the gate.

## Why this matters (not just cosmetic)

Josh explicitly picks the plan engine per run (gate-enforced: `planner` + `plannerConfirmed` in
`pipeline-run.json`, Stop-gate teeth). Offering K3 as a choice that then cannot actually produce a
dispatchable build is a broken promise. The routing config already treats K3 as first-class
(`fallback:opus`, `on429:opus`), so the only missing piece is provenance.

## Hard constraint — do NOT weaken the gate

The provenance gate exists (hard-spec-gate OBF, `src/bus/message.ts` SINK) to guarantee the specs
handed to a build worker are the exact bytes a **tracked runner** produced in-session — NOT
hand-authored drafts Larry slipped onto disk. Any bridge MUST preserve that guarantee:
- An opencode-authored plan must be bound to a real, replayable opencode work product — not a
  larry-written file relabeled as opencode's.
- The nightly bypass-audit (`src/pipeline/bypass-audit.ts`) must still flag an opencode `GATE:
  build` dispatch that lacks a valid signed chain. Fail-closed, loud.
- No new path that lets ANY actor emit an authored-stage row without a verifiable transcript.

## Design directions (for the plan stage to evaluate — not prescriptive)

1. **Worker-transcript mode in the emitter.** Teach `verifyTranscriptAuthorship` /
   `parseTranscriptOps` an opencode branch: accept a configurable worker-transcript root
   (`~/.cortextos/.../state/opencode/`), parse opencode's `conversation-buffer.jsonl` format,
   replay its file-write ops, reconstruct bytes vs disk exactly like the Claude path. Bind the row
   to the opencode **dispatch bus-message id** (already logged) so it's traceable to a real
   dispatch. Requires: (a) a stable opencode transcript format for file writes; (b) confirming
   opencode records full post-write file contents (needed for byte reconstruction).
2. **Worker self-signed emit.** Opencode writes the plan/specs, then emits its own signed stage
   row using a worker-scoped secret; larry verifies the chain + that the dispatch id matches. Moves
   trust to the worker secret + dispatch binding rather than transcript replay.
3. **Hybrid: K3 plans, provenance binds the dispatch.** The dispatch prompt (larry→opencode, in the
   bus store) + opencode's returned artifact hash are bound together and signed; the "transcript"
   becomes the dispatch record + a content hash rather than a keystroke replay.

The plan stage must pick ONE, justify it against the "do not weaken the gate" constraint, and
enumerate the exact files touched (`src/pipeline/ledger.ts`, `stage-emit.ts`, possibly
`gate-codexer-planning.sh`, `bypass-audit.ts`, `routing-config.json` doc) + tests.

## Verification reality (must be in acceptance)

Per the kimi-k3 route note: "Tool-calling implied not guaranteed — staging-verify structured/tool
output before prod." The bridge's true-verify stage must actually round-trip a real (or fixture)
opencode-authored plan artifact through `pipeline-stage-emit --stage plan` and
`--verify --through specs` and show it PASSES, plus show that a **tampered / larry-authored**
artifact still FAILS (the anti-drafting guarantee holds). Both directions proven, not just the
happy path.

## Out of scope (v1)

- Actually re-planning industry-resource-map with K3 (that ships opus-planned in parallel; K3 use
  is a future run once this lands).
- Multi-worker generalization beyond opencode.
- 429/rate-limit fallback behavior (already handled by routing-policy `on429:opus`).

## Acceptance shape (feeds plan/specs)

- An opencode/kimi-k3-authored `plan` + `specs` artifact can be provenance-signed and pass
  `pipeline-stage-emit --verify --through specs ... --framework one-big-feature`.
- A hand-authored / tampered artifact for the same slug still FAILS provenance (NO_PROVENANCE /
  PROVENANCE_MISMATCH / TRANSCRIPT_TAMPERED).
- `bypass-audit` still flags an opencode build dispatch with no valid chain.
- Tests cover both the pass and the fail direction. No `any`, no `console.log`, strict TS.
