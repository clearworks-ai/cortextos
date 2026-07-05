# Spec 01 — Routing config control surface (WS1)

**Target files:**
- NEW: `.claude/workflows/routing-config.json`
- EDIT: `.claude/workflows/dynamic-pipeline.js`

## What exists now (dynamic-pipeline.js — verified line refs)
Hardcoded per-stage model literals inside `agent()` opts:
- Explore: line ~149 `{ label:`explore-${i+1}`, phase:'Explore', model:'sonnet', schema:EXPLORE_SCHEMA }`
- Plan:    line ~169 `{ phase:'Plan', model:'fable', effort:'high', schema:PLAN_SCHEMA }`
- Implement: line ~205 `{ label:`impl-${ws.id}`, phase:'Implement', model:'fable', effort:'medium', isolation:'worktree', schema:IMPL_SCHEMA }`
- Merge:   line ~224 `{ label:'merge', phase:'Merge', model:'sonnet', schema:MERGE_SCHEMA }`
- Review:  line ~237 `{ label:'review', phase:'Review', model:'opus', effort:'high', schema:REVIEW_SCHEMA }`
- PR:      line ~275 `{ label:'open-pr', phase:'PR', model:'sonnet', schema:PR_SCHEMA }`
- Lessons: line ~289 `model:'sonnet'`
Also the `meta.phases` array (lines 6-11) carries stale `model:` hints — update to match.

## Build
1. Create `routing-config.json` with a `stages` map. Default = Josh's table:
```json
{
  "$comment": "Per-stage model routing for dynamic-pipeline. provider ∈ anthropic|openrouter|codex. Edit to re-route; missing keys fall back to anthropic defaults.",
  "stages": {
    "explore":   { "provider": "openrouter", "model": "openrouter/google/gemini-3.5-flash" },
    "plan":      { "provider": "anthropic",  "model": "fable", "effort": "high", "lean": true },
    "implement": { "provider": "codex",      "model": "gpt-5.4" },
    "merge":     { "provider": "anthropic",  "model": "haiku" },
    "review":    { "provider": "anthropic",  "model": "opus", "effort": "high" },
    "pr":        { "provider": "anthropic",  "model": "sonnet" },
    "lessons":   { "provider": "anthropic",  "model": "sonnet" }
  }
}
```
2. In `dynamic-pipeline.js`: near the top (after `const A = args || {}`), load the config with a
   safe read (try/catch; if file missing or unparseable, use a hardcoded DEFAULTS object equal to
   the CURRENT behavior — Anthropic-only). Resolve a helper:
   `stageOpts(stageName, base)` that merges the config entry into the `agent()` opts, mapping
   `provider:anthropic` → pass `model`/`effort` straight to agent(); `provider:openrouter|codex`
   → delegate to the WS3 bridge (spec 03). Keep `schema`, `label`, `phase`, `isolation` from `base`.
3. Replace each hardcoded `model:'...'`(+effort) with `...stageOpts('<stage>', { ...existing base opts })`.
4. Allow an override path via args: `A.routingConfigPath` (default `.claude/workflows/routing-config.json`)
   so a caller can point at an alternate routing file.

## Model-availability facts (verified live on this host 2026-07-05)
- `implement` codex model: `gpt-5-codex` is HARD-REJECTED under this host's ChatGPT-account Codex
  auth ("model not supported when using Codex with a ChatGPT account"). The working default is
  `gpt-5.4` (per `~/.codex/config.toml`), which honors `--output-schema`. Config value set to
  `gpt-5.4`; the WS3 codex path should prefer OMITting `--model` (inherit codex config default) and
  only pass a model when routing-config specifies one. Aspirational `gpt-5.5` when host supports.
- `explore` openrouter path PROVEN: `opencode run --model openrouter/z-ai/glm-4.7-flash` returns
  strict JSON. OPENROUTER_API_KEY now in larry/.env (workflow shell env). Gemini slug per table.

## Reel-validated refinements (source: agentic.james "multi-harness multi-model routing", 2026-07-05)
The cortext creator's own recommended chain matches this table; two additive refinements — sequence
as FOLLOW-ON after the WS3 seam + WS1 config land (do NOT expand the seam build to include them):
- **R1 — Synthesize sub-stage:** insert an Opus 4.8 "synthesize research docs" step between Explore
  and Plan (Explore→Synthesize→Plan). Add as a `synthesize` stage entry
  (`{ "provider":"anthropic", "model":"opus", "effort":"high" }`) once the pipeline supports it.
- **R2 — Review = loop-until-clean:** Review should loop (Opus) until all findings clear, not a single
  pass. Track as a Review-stage behavior change in WS4, not a routing-config value.

## Acceptance
- Deleting/emptying routing-config.json → pipeline runs byte-identically to today (Anthropic-only). PROVE it.
- Editing a stage's `model` in the JSON changes which model that stage uses, no code edit.
- `provider:anthropic` stages still pass `effort` through correctly (Plan=high, Review=high).
- No `any`, no console.log. Config read is atomic/synchronous at startup; parse errors log-and-fallback,
  never throw the whole workflow.
