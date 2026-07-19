# REVIEW — add-kimi-k3-planner

## Verdict: PASS

Adversarial review of the implemented diff for slug `add-kimi-k3-planner` against
`03-specs/01-routing-policy-kimi-k3.md`. Build passes; routing-policy vitest suite
13/13 green (per handoff). No blocking defects found.

---

## Per-criterion findings

### 1. Scope match — PASS
- `git diff` against HEAD shows the two target files (`routing-policy.js`,
  `routing-policy.test.ts`) are already committed (`92087b8 feat(pipeline): add Kimi K3
  (OpenRouter) as third plan-engine option`); working tree has no drift on them.
- The only other working-tree changes are unrelated runtime state files
  (`state/current-mission.txt`, `state/pipeline-run.json`, alice crons, meeting-commitments)
  — NOT part of this build and correctly excluded from the diff packet.
- Exactly the 2 files. Nothing extra. Clean.

### 2. Spec fidelity — PASS
- `PLANNER_CHOICES` gains `'kimi-k3'` (line 5). `resolvePlannerChoice` validates against
  this list unchanged, so `PIPELINE_PLANNER=kimi-k3` (and ` KIMI-K3 ` trimmed/lowered) now
  resolves — confirmed by test.
- `engines` map mirrored into BOTH `CURRENT_BEHAVIOR_ROUTING.stages.plan` (lines 20–31) and
  `ROUTING_CONFIG_DEFAULTS.stages.plan` (lines 55–66), identical literals.
- **Byte-parity with `routing-config.json`:** verified directly. The committed
  `.claude/workflows/routing-config.json` `stages.plan.engines` INCLUDES a `note:` field on
  the kimi-k3 engine. The implementer carried that `note:` into both JS objects, so the JS
  defaults match the real config exactly. NOTE: the spec's abbreviated literal (Edit 2)
  omitted `note`, but the binding done-criterion is "matches routing-config.json" — the
  implementation satisfies the authoritative source, not the abbreviated spec snippet. This
  is correct, not a divergence.
- `resolveStageRoute` routes `plannerChoice='kimi-k3'` to the openrouter engine
  (lines 164–176) and returns BEFORE the fable/opus confirm logic. `buildAnthropicAgentOptions`
  is anthropic-only and is never reached for kimi-k3 (the branch returns first). Confirmed by
  reading the control flow: the kimi return sits above `route.lean = true` and the
  confirm/decline path.

### 3. Back-compat — PASS
- `route.lean = true` was moved to AFTER the kimi-k3 short-circuit, so fable still gets
  `lean: true` and kimi-k3 never carries a spurious `lean`. Fable/opus decline path
  unchanged (lines 178–197).
- `plannerChoice` computed once at top and reused — behavior for fable/opus identical.
- All pre-existing tests retained: lean-fable, explicit-fable, explicit-opus,
  default-opus-fallback, env-wiring, and both guard tests are intact in the test file.

### 4. Code quality — PASS
- `grep` for `\bany\b`, `console.log/error/warn` in `routing-policy.js`: NONE.
- Uses the existing `isRecord` helper (line 80) correctly:
  `route.engines && isRecord(route.engines['kimi-k3'])`. No new guard added.
- Inline `||` fallbacks (`kimi?.provider || 'openrouter'`, etc.) keep the route valid even
  when the engines map is absent. Optional-chaining used correctly.

### 5. Test coverage — PASS
- Parse: `resolvePlannerChoice` accepts `kimi-k3` and trims/lowercases ` KIMI-K3 `.
- Route: `routes plan to the kimi-k3 openrouter engine` asserts the full object shape and
  that model !== 'fable' and confirmationDeclined is falsy.
- No-confirm: `does not consult confirmFableUse when plannerChoice is kimi-k3` proves the
  callback is never invoked (short-circuit).
- Existing cases untouched.

---

## Adversarial edges checked

- **kimi-k3 when `route.engines` is absent:** The guard
  `route.engines && isRecord(route.engines['kimi-k3'])` short-circuits to `null` when
  `engines` is undefined; the inline `||` fallbacks then produce the correct openrouter
  route. No crash, no wrong route. HANDLED.
- **Does the `route.model === 'fable'` guard ever block kimi-k3?** The kimi-k3 branch is
  nested inside `if (stageName === 'plan' && route.model === 'fable')`. Plan's default
  `model` is `'fable'` in BOTH routing objects, so `plannerChoice=kimi-k3` always enters the
  block under defaults. If a user overlay sets plan.model away from `fable`, the ENTIRE
  planner-choice mechanism (fable/opus/kimi-k3 alike) is bypassed uniformly — kimi-k3
  inherits the exact same gate as the fable/opus paths it sits beside. This is
  consistent-by-design, not a kimi-k3-specific defect. NOT A BUG.
- **`isRecord` on the engines entry:** `route.engines['kimi-k3']` is a plain object literal,
  passes `isRecord` (non-null, object, non-array). Correct.
- **`mergeRoutingConfig` shallow-spread of `engines`:** Both base and overlay carry the full
  `engines` object, so a shallow overwrite replaces it wholesale — spec-acknowledged and
  correct. The "loads committed routing defaults from a real config file" test round-trips
  `ROUTING_CONFIG_DEFAULTS` through JSON and reload and still holds.
- **Ordering vs the two throw-guards:** the review-provider guard and the
  "fable only at plan" guard both execute before the plan block and are untouched; neither
  can intercept a plan-stage kimi-k3 route (review guard is review-only; fable guard only
  throws for non-plan stages).

---

## Conclusion

Implementation is faithful to spec, back-compatible, clean, and well-tested. The one
apparent spec/diff difference (the `note:` field) is the implementation correctly matching
the authoritative `routing-config.json` rather than the abbreviated spec snippet. No `any`,
no `console.log`, correct `isRecord` usage, kimi-k3 short-circuits before the anthropic-only
helper. Edges around absent `engines` and the fable-model guard are sound.

**PASS.**
