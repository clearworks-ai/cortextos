# PRD — Pipeline Model-Routing Control Surface + Lean Fable + Multi-Vendor Stages

**Owner:** Larry (plan/spec) → codexer (impl) → Josh (PR approval)
**Repo:** ~/code/cortextos
**Framework:** one-big-feature
**Created:** 2026-07-05
**Origin:** Josh directive (Telegram 2026-07-05). New Anthropic account w/ credits; wants to
"program like this from cortext, being very mindful with fable and happily leveraging our
opencode/claude/codex world and bringing in glm, deepseek, gemini too. implement the table.
so i can code from here."

## Josh's exact request (verbatim scope — SCOPE_LOCK)
1. Implement the per-stage routing TABLE in the dynamic pipeline (the off-Anthropic pins that
   were designed but never wired).
2. Build a way for Josh to CONTROL the routing from cortext (a control surface — pick which
   model runs each stage without editing code).
3. THE BIGGEST THING: when Fable runs, do NOT fill it with "normal coding agent harness crap"
   — Fable gets a lean context, not the full coding-agent bootstrap.
4. Leverage opencode/claude/codex AND bring in GLM, Deepseek, Gemini as routable options.

## The target routing table (planned vs current)
| Stage     | Planned model            | Current (hardcoded) | Action |
|-----------|--------------------------|---------------------|--------|
| Explore   | OpenRouter Gemini (cheap)| sonnet              | change |
| Plan      | Fable, high (LEAN)       | fable, high         | keep + make lean |
| Implement | Codex gpt-5-codex        | fable, medium       | change |
| Merge     | Haiku                    | sonnet              | change |
| Review    | Opus, high, loops        | opus, high          | keep |
| PR        | Sonnet                   | sonnet              | keep |

## Verified state (2026-07-05, read from real code)
- Runtime/degrade routing LANDED: PR #57 WS8 (src/daemon/agent-process.ts), opencode default = glm-4.7-flash.
- Per-stage pipeline routing NOT landed: .claude/workflows/dynamic-pipeline.js is Anthropic-tier only.
- Daemon ALREADY has runtime abstraction: runtime ∈ {claude, opencode, codex-app-server}; OpencodePTY
  routes OpenRouter models (GLM/Deepseek/Gemini), CodexAppServerPTY routes gpt-5-codex.
- Verified OpenRouter slugs (reference_model_routing_table_2026-07-04.md):
  Gemini grounded = openrouter/google/gemini-3.5-flash; Deepseek cheap = openrouter/deepseek/deepseek-v4-flash;
  GLM mechanical = openrouter/z-ai/glm-4.7-flash; GLM reasoning = openrouter/z-ai/glm-5.2.

## Key constraint / honest nuance
The Workflow engine's `agent()` model param is natively Anthropic-tier only (sonnet/opus/haiku/fable).
Routing a pipeline STAGE to Gemini/Deepseek/GLM/Codex requires a BRIDGE to the daemon runtimes
(opencode CLI / codex exec) — this is the core net-new piece.

## Success criteria
- Josh can change any stage's model by editing ONE config file (routing-config.json) — no code edits.
- The default config encodes the table above (Gemini explore, Codex implement, Haiku merge).
- Fable stages run with a lean context (no repo CLAUDE.md / full bootstrap bleed-in).
- Non-Anthropic stages actually execute on their runtime and return structured results into the pipeline.
- Nothing regresses: same pipeline still runs Anthropic-only if config says so.
