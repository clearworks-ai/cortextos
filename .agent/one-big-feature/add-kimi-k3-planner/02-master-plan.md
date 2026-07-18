# OBF Master Plan — Add Kimi K3 as a Third Pipeline Plan-Engine

- **Framework:** one-big-feature (single repo, single tracked source file + its test)
- **Repo:** `/Users/joshweiss/code/cortextos`
- **Slug:** `add-kimi-k3-planner`
- **Planner:** Opus (Josh-confirmed)
- **Author date:** 2026-07-18

---

## Objective

Add `kimi-k3` (Moonshot AI, via OpenRouter) as a THIRD selectable pipeline
plan-engine alongside `fable` and `opus`. When Josh confirms `PIPELINE_PLANNER=kimi-k3`,
the plan stage must resolve to an OpenRouter route (`moonshotai/kimi-k3`) that dispatches
via the Opencoder worker — NOT to a Claude subagent, and NOT falling through to the
existing opus/fable confirmation path.

This is the final code piece of a four-part change. The other three parts are already
done inline by Larry (they are Larry-writable config/gate/docs). The single remaining
item is the tracked JS library that consumes the config, which Larry cannot edit
(`.js` is hook-blocked), so **codexer** implements it.

---

## Context — 3 of 4 targets already DONE inline

| # | Target | Status | Owner |
|---|--------|--------|-------|
| a | `.claude/workflows/routing-config.json` — `stages.plan.engines` map now has `{fable, opus, kimi-k3}` | DONE (inline) | Larry |
| b | `orgs/clearworksai/agents/larry/.claude/hooks/gate-pipeline-stop.sh` — planner allow-list now accepts `kimi-k3` | DONE (inline) | Larry |
| c | `PIPELINE.md` — documents the 3 engines | DONE (inline) | Larry |
| d | **`.claude/workflows/lib/routing-policy.js` (+ test)** — the tracked source library that consumes the config | **THIS OBF** | **codexer** |

The `routing-config.json` `engines` map is the source of truth for the engine literals.
The JS must mirror those defaults so the standalone unit test (which writes
`ROUTING_CONFIG_DEFAULTS` to a temp file) stays consistent with the shipped config.

---

## Codexer target files (the ONLY files this OBF touches)

1. `/Users/joshweiss/code/cortextos/.claude/workflows/lib/routing-policy.js` (182 lines, tracked)
2. `/Users/joshweiss/code/cortextos/tests/unit/workflows/routing-policy.test.ts`

No other file may be modified. See `03-specs/01-routing-policy-kimi-k3.md` for the exact,
line-referenced change spec.

---

## Kimi K3 verified facts (2026-07-18)

- **Slug (PIN THIS):** `moonshotai/kimi-k3` — `moonshot/kimi-k3` is a 404. Never use `moonshotai/kimi-latest`.
- **Provider:** `openrouter`; OpenAI-compatible endpoint `https://openrouter.ai/api/v1/chat/completions`; auth `Bearer $OPENROUTER_API_KEY`.
- **Status:** GA, 1M context, $3 in / $15 out per 1M tokens.
- **Dispatch:** `opencode` — routes through the Opencoder worker (`bus send-message opencode`), NOT a Claude subagent.
- **Reliability warnings:**
  - Frequent 429s → must fall back to `opus` on 429 (`on429: 'opus'`, plus `fallback: 'opus'`).
  - Tool/function-calling is implied, not guaranteed → structured/tool output MUST be staging-verified before any real kimi-k3-planned build ships.

---

## Ordered implementation steps (codexer)

1. **`PLANNER_CHOICES`** (routing-policy.js line 5): add `'kimi-k3'` →
   `['fable', 'opus', 'kimi-k3']`.
2. **Mirror the `engines` map** into `stages.plan` in BOTH `CURRENT_BEHAVIOR_ROUTING`
   and `ROUTING_CONFIG_DEFAULTS`, matching `routing-config.json` exactly (fable/opus/kimi-k3
   engine literals). Keep the existing back-compat plan keys
   (`model:'fable'`, `requiresConfirmation:true`, `fallback:'opus'`, etc.).
3. **`resolveStageRoute` plan branch:** add an explicit `kimi-k3` path. When
   `options.plannerChoice === 'kimi-k3'`, return the kimi-k3 engine route and do NOT
   fall through to the opus/fable confirmation logic. Prefer reading it from
   `route.engines['kimi-k3']` when present; fall back to an inline literal if `engines`
   is absent (back-compat with configs that predate the engines map).
4. **`resolvePlannerChoice`:** no change beyond `PLANNER_CHOICES` gaining `'kimi-k3'`
   (it already validates against the list).
5. **`buildAnthropicAgentOptions`:** no change. Document (in a comment on the kimi-k3
   branch) that kimi-k3 is an OpenRouter route dispatched to Opencoder, so
   `buildAnthropicAgentOptions` must never be called for it (it is only invoked for
   anthropic routes by the caller).
6. **Tests** (`routing-policy.test.ts`): add the three new cases (see spec §5) and keep
   all existing fable/opus/default/guard cases green. Follow the existing vitest +
   `createRequire` style.

---

## Test / verify plan

1. **Unit:** `npm test` — the `routing-policy.test.ts` suite must be fully green, including
   the three new kimi-k3 cases AND every pre-existing fable/opus/default/guard case
   (nothing regressed).
2. **Build:** `npm run build` — TypeScript compiles cleanly (repo CLAUDE.md gate).
3. **Staging smoke (blocking gate on real use — NOT part of this OBF's merge):**
   Before ANY real kimi-k3-planned build ships, prove on staging that `moonshotai/kimi-k3`
   returns valid structured/tool-call output via the OpenRouter endpoint, and that a 429
   correctly falls back to opus. Tool-calling is implied-not-guaranteed; do not trust it
   in prod unverified. This OBF only wires the routing decision — it does not authorize
   an unverified kimi-k3 production plan run.

---

## Acceptance criteria

- `resolvePlannerChoice({PIPELINE_PLANNER:'kimi-k3'})` returns `'kimi-k3'`.
- `resolveStageRoute(ROUTING_CONFIG_DEFAULTS, 'plan', {plannerChoice:'kimi-k3'})` returns
  `{provider:'openrouter', model:'moonshotai/kimi-k3', dispatch:'opencode', fallback:'opus', on429:'opus', requiresConfirmation:false}` (and NOT `confirmationDeclined:true`).
- Existing fable path (`plannerChoice:'fable'` → lean fable), opus/default fallback
  (`confirmationDeclined:true`), review-provider guard, and "fable only at plan" guard are
  all unchanged and still pass.
- `routing-policy.js` `ROUTING_CONFIG_DEFAULTS.stages.plan.engines` matches
  `routing-config.json` `stages.plan.engines` (fable/opus/kimi-k3 literals).
- No `any`, no `console.log`. Diff limited to the two files above.

---

## Out of scope (explicit)

- **No new runtime wiring** of `routing-policy.js`. It remains test-consumed only; this OBF
  does not add a live daemon/dynamic-pipeline import.
- **No live daemon changes.**
- **Config / gate / docs** are already done inline (targets a, b, c) — do NOT re-touch
  `routing-config.json`, `gate-pipeline-stop.sh`, or `PIPELINE.md`.
- **No Opencoder-worker changes** — dispatch:'opencode' is a route field consumed by the
  caller elsewhere; this OBF only emits the route, it does not implement the dispatch.
- **No new packages.**
