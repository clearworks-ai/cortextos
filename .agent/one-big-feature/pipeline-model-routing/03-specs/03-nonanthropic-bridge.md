# Spec 03 — Non-Anthropic runtime bridge (WS3)

**Goal:** Let a pipeline stage execute on OpenRouter (Gemini/Deepseek/GLM) or Codex (gpt-5-codex)
and return its schema-validated result back into the pipeline, so the routing-config `provider`
values `openrouter` and `codex` actually work.

**Target files:**
- `.claude/workflows/dynamic-pipeline.js` (call the bridge from `stageOpts` when provider != anthropic)
- Reuse: `src/daemon/agent-process.ts`, `src/pty/opencode-pty.ts`, `src/pty/codex-app-server-pty.ts`
- Possibly a NEW small module `.claude/workflows/lib/runtime-bridge.js` (or `src/…`) — codexer chooses,
  keep it minimal and dependency-free.

## Context (verified)
- The daemon already runs non-Anthropic models via runtimes: `runtime ∈ {claude, opencode, codex-app-server}`
  (src/daemon/agent-process.ts:74-98, 226-245). OpencodePTY → OpenRouter slugs; CodexAppServerPTY → gpt-5-codex.
- The Workflow `agent()` model param is Anthropic-tier only — it CANNOT natively take an OpenRouter slug.
  Hence the bridge.

## Investigation (codexer, gpt-5-codex)
1. Decide the leanest bridge mechanism:
   - Option A (preferred if a headless entrypoint exists): invoke the `opencode` CLI / `codex exec`
     directly with the stage prompt + a "return ONLY JSON matching this schema" instruction, capture
     stdout, parse+validate against the stage schema, retry once on invalid JSON.
   - Option B: reuse OpencodePTY/CodexAppServerPTY programmatically for a one-shot prompt.
   Pick the one that is one-shot, non-interactive, and does not spawn a persistent agent session.
2. Confirm OPENROUTER_API_KEY availability to the workflow process (env). If absent, the bridge must
   fail loud with a clear message (not silently fall back to Anthropic and hide the misroute).

## Build
1. `runtimeBridge({ provider, model, prompt, schema, effort })` → returns the parsed, schema-valid object.
   - provider `openrouter`: run opencode one-shot with `--model <slug>`.
   - provider `codex`: run codex one-shot on gpt-5-codex.
   - Enforce JSON-only output; validate against the passed schema; one retry on parse/validation failure;
     then throw a descriptive error (the pipeline stage drops to null + logs, per existing pipeline semantics).
2. Wire `stageOpts`/the stage `agent()` sites so non-anthropic providers call `runtimeBridge` instead of `agent()`.
3. Preserve worktree isolation for the Implement stage when routed to Codex (Codex edits files) — the bridge
   must run in / target the correct worktree branch, same as the current Fable implement path.

## Guardrails
- NEVER route the Review stage off-Anthropic (merge-approval gate stays Opus).
- Fail loud on missing keys / wrong provider — no silent Anthropic fallback that hides a misroute.
- No new runtime deps; reuse existing PTY/CLI infra.

## Acceptance
- With provider:openrouter on Explore, a real run shows a Gemini-produced EXPLORE_SCHEMA object entering Plan.
- With provider:codex on Implement, a real run shows Codex committing to the worktree branch and returning IMPL_SCHEMA.
- Missing OPENROUTER_API_KEY → clear fail-loud error, not a silent Anthropic run.
- End-to-end: a full pipeline run with the default (mixed-provider) config completes explore→plan→implement→merge→review→pr.
