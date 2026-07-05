# Master Plan — Pipeline Model-Routing Control Surface

**Framework:** one-big-feature · **Repo:** ~/code/cortextos · **Slug:** pipeline-model-routing
**Planned:** 2026-07-05 · **Owner:** Larry → codexer

## Goal
Make `.claude/workflows/dynamic-pipeline.js` route each stage to a model chosen from an
editable config, support non-Anthropic providers (OpenRouter GLM/Deepseek/Gemini + Codex),
and give Fable stages a lean context. Josh controls it all from one JSON file.

## Architecture (3 workstreams, file-disjoint where possible; sequence WS1 → WS2 → WS3)

### WS1 — Routing config control surface  (spec 03-specs/01-routing-config.md)
- New file `.claude/workflows/routing-config.json`: per-stage `{ provider, model, effort?, lean? }`.
- `dynamic-pipeline.js` loads it once at top; each `agent()` call reads its stage entry instead of
  hardcoded `model:'...'` literals. Fallback to current Anthropic defaults if a stage/key is missing
  (zero-regression). This is the "code from cortext" surface — Josh edits JSON, no code change.
- Provider values: `anthropic` (native agent() tiers) | `openrouter` | `codex`.

### WS2 — Lean Fable agent-type  (spec 03-specs/02-lean-fable.md)
- Define a lean workflow agent-type used for `provider:anthropic` stages flagged `lean:true`
  (Plan stage, and Implement if it stays Fable). It must NOT inherit repo CLAUDE.md or the full
  coding-agent scaffolding — only the stage prompt (task + explore reports + instructions).
- codexer investigates how workflow subagent system prompts are assembled and pins the minimal one.

### WS3 — Non-Anthropic runtime bridge  (spec 03-specs/03-nonanthropic-bridge.md)
- For `provider:openrouter` (Gemini/Deepseek/GLM) and `provider:codex` (gpt-5-codex), bridge the
  stage to the daemon's existing runtimes (OpencodePTY / CodexAppServerPTY or their CLIs), passing
  the stage prompt and returning the stage's structured result back into the pipeline.
- Reuse existing runtime infra in src/daemon/agent-process.ts + src/pty/*; do NOT reinvent.
- Must preserve the schema-validated hand-off between stages (explore→plan→implement→merge→review→pr).

### WS4 — Framework integration (M2C1/OBF fan-out DNA)  [FOLLOW-ON, sequence LAST]
Josh's directive: M2C1 + OBF must LEVERAGE the handoff seam so builds fan out to the right worker
per task-type instead of funneling through one agent (Larry/Frank plan → single codexer).
- The WS3 seam (`sendWork`) MUST be a standalone, framework-agnostic, importable primitive (its own
  module) — dynamic-pipeline is just its FIRST caller. Build it that way from the start (WS3).
- WS4 = wire M2C1/OBF EXECUTION phase to decompose a plan into workstreams and route each through
  the seam by kind: research→Gemini, mechanical→GLM, impl→Codex, lean-plan→Fable, review→Opus.
  Planning stays with Larry/Frank; BUILDING fans out automatically.
- SEQUENCE: do NOT start WS4 until the seam (WS3) is proven + trustworthy. "Do it right" = foundation first.

## Sequencing & why
1. WS1 first — it's the seam everything else plugs into (config-driven stage models).
2. WS2 + WS3 layer onto the seam. WS2 (lean Fable) is independent of WS3 and can run parallel.
3. Review gate (Opus) stays Anthropic — never route the merge-approval reviewer off-Anthropic
   (mirrors the "larry never degrades" rule: don't let a downgraded model gate a merge).

## Guardrails
- Zero regression: with the default config removed/empty, pipeline behaves exactly as today.
- No `any`, no console.log, TS strict where applicable, atomic writes for config reads/writes.
- Fable is Anthropic → leaning it saves tokens, NOT credits. Off-Anthropic pins are the credit lever.
- Larry adversarial-reviews codexer's diff (scope match, no scope compression vs the table) before PR.

## Out of scope (explicit)
- No dashboard UI for routing (JSON edit is the MVP control surface; UI is a later item).
- No change to the daemon degrade/failover path (already landed in WS8/#57).
- Daemon rebuild+restart to deploy merged code = separate Josh-gated op, not part of this build.

## Definition of done
- routing-config.json exists, documented, defaults = the table.
- dynamic-pipeline.js is fully config-driven; Anthropic-only fallback proven.
- A test run (or dry-run harness) shows a non-Anthropic stage executing and returning a valid schema.
- Lean Fable stage verified to NOT carry repo CLAUDE.md.
- PR opened; Larry review PASS; Josh approves merge.
