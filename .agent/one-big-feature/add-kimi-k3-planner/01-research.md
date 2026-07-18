# Add Kimi K3 (OpenRouter) as 3rd pipeline planner engine

Task: task_1784398439244_84995807 (frank2 relaying Josh). Planner for THIS build = **Opus** (frank2-confirmed 18:14Z; Fable off, Kimi not yet wired). ONE PR, all 4 targets — half-wiring breaks the plan stage.

## Verified facts (knox, OpenRouter, 2026-07-18)
- SLUG = `moonshotai/kimi-k3` (NOT `moonshot/...` → 404). EXISTS, GA as of 2026-07-16.
- Context 1,048,576 (1M). Price $3 in / $15 out per 1M.
- Tool/function-calling: IMPLIED strong, NOT an explicit OpenRouter capability flag → **TEST function-call compat in staging before prod dispatch** (a planner must emit structured/tool output).
- Endpoint `https://openrouter.ai/api/v1/chat/completions` (OpenAI-compatible). Auth `Authorization: Bearer $OPENROUTER_API_KEY`.
- WARNING: "may return frequent 429 errors" (upstream capacity) — planner needs a fallback (opus) on 429.
- Avoid `moonshotai/kimi-latest` (auto-redirects) — pin `moonshotai/kimi-k3`.

## Current architecture (grounded this session)
- `routing-config.json` (.claude/workflows/) = **git-TRACKED** JSON. plan stage: `{provider:anthropic, model:fable, effort:high, lean:true, requiresConfirmation:true, fallback:opus}`. `fableGate.fallback:opus`.
- `gate-pipeline-stop.sh` = **git-IGNORED**, per-agent (ALL 5 copies). Line 88 validation: `[ "$RUN_PLANNER" = "fable" ] || [ "$RUN_PLANNER" = "opus" ]` + plannerConfirmed=true.
- `PIPELINE.md` (larry) = **git-IGNORED** docs. Plan-engine choice section ~line 52.
- Plan stage runs as **Larry's Claude subagent** (fable/opus = anthropic provider via Agent/Task tool — Anthropic-only). OpenRouter models route via the **Opencoder/opencode worker** ("ANY OpenRouter slug per task" — PIPELINE.md:73; `bus send-message opencode`). No live src/ consumer of routing-config found (dynamic-pipeline dead; only degrade path at agent-process.ts:81 maps to opencode runtime+model).

## 4 targets + approach
1. **gate-pipeline-stop.sh:88** (all 5 agent copies) — accept `kimi-k3`: `{ [ "$RUN_PLANNER" = "fable" ] || [ "$RUN_PLANNER" = "opus" ] || [ "$RUN_PLANNER" = "kimi-k3" ]; }`. Also update the REASON strings that say "Fable-vs-Opus" → "Fable / Opus / Kimi K3". Larry-writable.
2. **routing-config.json** (TRACKED) — add a plan-engine option for kimi-k3: extend plan stage to document the 3 engines, e.g. an `engines` map `{fable:{provider:anthropic,model:fable}, opus:{provider:anthropic,model:opus}, kimi-k3:{provider:openrouter,model:moonshotai/kimi-k3, fallback:opus}}`, keep `requiresConfirmation:true`, `fallback:opus`. JSON config — Larry can edit; keep schema back-compatible with any consumer.
3. **PIPELINE.md** (IGNORED) — document kimi-k3 as 3rd plan engine: when picked, plan stage dispatches to Opencoder with slug `moonshotai/kimi-k3` (not a Claude subagent); note 429→opus fallback + staging tool-call caveat. Update the "Plan-engine choice is MANDATORY" section (~52) to list 3 engines.
4. **OpenRouter API wiring for the plan-stage call** — OPEN SCOPE QUESTION (settle before codexer): is there real src/ code, or is it the documented dispatch pattern (plan stage → `bus send-message opencode '<plan prompt + schema + MODEL=moonshotai/kimi-k3>'`)? Evidence points to CONFIG+DISPATCH-PATTERN, not new src/ code — opencode already accepts any OpenRouter slug. If a codepath must map planner=kimi-k3 → opencode dispatch automatically, that's the only codexer/src piece. **Verify by reading how a plan-stage engine is actually invoked today (Larry Agent tool vs any script) before deciding codexer scope.**

## Test/verify
- gate hook: `bash -n` all 5; planner=kimi-k3 + confirmed=true ⇒ gate PASSES; planner=kimi-k3 + confirmed=false ⇒ BLOCKS.
- routing-config: JSON valid; any existing consumer/test still green (`npm test` docs-config.test.ts, bypass-audit.test.ts exist).
- Live plan-stage smoke on kimi-k3 in STAGING: confirm it returns a structured plan + tool/schema output; confirm 429→opus fallback fires. Do NOT ship without the staging tool-call proof (knox flagged tools not guaranteed).

## Dispatch plan (post-handoff)
- If target 4 is config/dispatch-only: Larry does gate-hooks + PIPELINE.md + routing-config inline (config/docs), then a small codexer piece ONLY if an auto-dispatch codepath is needed. Write OBF master-plan + specs, GATE build framework=one-big-feature slug=add-kimi-k3-planner repo=~/code/cortextos, planner=opus confirmed.
- THEN: re-ask Josh which engine (fable/opus/kimi-k3) for the restart-noise/unify-lifecycle-ping-gate run (that task still parked on planner pick).
