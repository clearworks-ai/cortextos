# Spec 01 — routing-policy.js: add kimi-k3 plan engine

**Target files (ONLY these two):**
- `/Users/joshweiss/code/cortextos/.claude/workflows/lib/routing-policy.js`
- `/Users/joshweiss/code/cortextos/tests/unit/workflows/routing-policy.test.ts`

Line numbers below reference the CURRENT state of `routing-policy.js` (182 lines) as read
2026-07-18. Apply edits verbatim. No `any`, no `console.log`, minimal diff.

---

## Edit 1 — `PLANNER_CHOICES` (line 5)

**Before:**
```js
const PLANNER_CHOICES = ['fable', 'opus'];
```

**After:**
```js
const PLANNER_CHOICES = ['fable', 'opus', 'kimi-k3'];
```

Intent: `resolvePlannerChoice` validates `PIPELINE_PLANNER` against this list, so adding
`'kimi-k3'` makes it a recognized choice with zero further change to that function.

---

## Edit 2 — mirror the `engines` map into the `plan` stage of BOTH routing objects

The `engines` literal must match `routing-config.json` `stages.plan.engines` exactly.
Add an `engines` key to the existing `plan` object (keep every existing key for
back-compat). Do this in `CURRENT_BEHAVIOR_ROUTING.stages.plan` (lines 13–20) AND
`ROUTING_CONFIG_DEFAULTS.stages.plan` (lines 36–43).

**The engines literal to insert (identical in both objects):**
```js
      engines: {
        fable: { provider: 'anthropic', model: 'fable', effort: 'high', lean: true, dispatch: 'claude-subagent' },
        opus: { provider: 'anthropic', model: 'opus', effort: 'high', dispatch: 'claude-subagent' },
        'kimi-k3': {
          provider: 'openrouter',
          model: 'moonshotai/kimi-k3',
          dispatch: 'opencode',
          fallback: 'opus',
          on429: 'opus',
        },
      },
```

**`CURRENT_BEHAVIOR_ROUTING.stages.plan` — Before (lines 13–20):**
```js
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
    },
```
**After:**
```js
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
      engines: {
        fable: { provider: 'anthropic', model: 'fable', effort: 'high', lean: true, dispatch: 'claude-subagent' },
        opus: { provider: 'anthropic', model: 'opus', effort: 'high', dispatch: 'claude-subagent' },
        'kimi-k3': {
          provider: 'openrouter',
          model: 'moonshotai/kimi-k3',
          dispatch: 'opencode',
          fallback: 'opus',
          on429: 'opus',
        },
      },
    },
```

**`ROUTING_CONFIG_DEFAULTS.stages.plan` — Before (lines 36–43):**
```js
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
    },
```
**After:** identical shape to the `CURRENT_BEHAVIOR_ROUTING` `plan` block above (same
`engines` map appended after `fallback: 'opus'`).

Intent: keeps the JS defaults byte-compatible with `routing-config.json`, so the test
that writes `ROUTING_CONFIG_DEFAULTS` to a temp file and reloads it still holds, and the
`kimi-k3` engine literal is available to `resolveStageRoute` via `route.engines['kimi-k3']`.

**Note on `mergeRoutingConfig` (lines 72–81):** the stage merge is a shallow spread per
stage (`{...merged.stages[stageName], ...overlay.stages[stageName]}`). Because both base
and overlay now carry the full `engines` object, a shallow overwrite is correct — the
overlay's `engines` replaces the base's wholesale. No change needed to `mergeRoutingConfig`.

---

## Edit 3 — `resolveStageRoute` plan branch: explicit kimi-k3 path (lines 132–156)

Insert the kimi-k3 short-circuit at the TOP of the `stageName === 'plan' && route.model === 'fable'`
block, BEFORE the existing fable/opus confirmation logic, so kimi-k3 never falls through.

**Before (lines 132–156):**
```js
  if (stageName === 'plan' && route.model === 'fable') {
    route.lean = true;
    const plannerChoice = PLANNER_CHOICES.includes(options.plannerChoice)
      ? options.plannerChoice
      : null;
    const confirmFableUse = typeof options.confirmFableUse === 'function'
      ? options.confirmFableUse
      : null;
    const approved = plannerChoice === 'fable'
      ? true
      : plannerChoice === 'opus'
        ? false
        : confirmFableUse ? Boolean(confirmFableUse({ stageName, route, config })) : false;
    if (!approved && (plannerChoice === 'opus' || route.requiresConfirmation !== false)) {
      return {
        provider: 'anthropic',
        model: route.fallback || config?.fableGate?.fallback || 'opus',
        effort: route.effort,
        lean: false,
        requiresConfirmation: false,
        fallback: route.fallback || config?.fableGate?.fallback || 'opus',
        confirmationDeclined: true,
      };
    }
  }
```

**After:**
```js
  if (stageName === 'plan' && route.model === 'fable') {
    const plannerChoice = PLANNER_CHOICES.includes(options.plannerChoice)
      ? options.plannerChoice
      : null;

    // kimi-k3 is an OpenRouter route dispatched via the Opencoder worker, NOT a Claude
    // subagent. It short-circuits the fable/opus confirmation path entirely, so
    // buildAnthropicAgentOptions is never called for it (that helper is anthropic-only).
    if (plannerChoice === 'kimi-k3') {
      const kimi = route.engines && isRecord(route.engines['kimi-k3'])
        ? route.engines['kimi-k3']
        : null;
      return {
        provider: kimi?.provider || 'openrouter',
        model: kimi?.model || 'moonshotai/kimi-k3',
        dispatch: kimi?.dispatch || 'opencode',
        fallback: kimi?.fallback || 'opus',
        on429: kimi?.on429 || 'opus',
        requiresConfirmation: false,
      };
    }

    route.lean = true;
    const confirmFableUse = typeof options.confirmFableUse === 'function'
      ? options.confirmFableUse
      : null;
    const approved = plannerChoice === 'fable'
      ? true
      : plannerChoice === 'opus'
        ? false
        : confirmFableUse ? Boolean(confirmFableUse({ stageName, route, config })) : false;
    if (!approved && (plannerChoice === 'opus' || route.requiresConfirmation !== false)) {
      return {
        provider: 'anthropic',
        model: route.fallback || config?.fableGate?.fallback || 'opus',
        effort: route.effort,
        lean: false,
        requiresConfirmation: false,
        fallback: route.fallback || config?.fableGate?.fallback || 'opus',
        confirmationDeclined: true,
      };
    }
  }
```

Behavior contract:
- `plannerChoice` is now computed ONCE at the top of the block (moved up from its old
  position) and reused by both the kimi-k3 branch and the existing fable/opus logic.
- `route.lean = true` is moved to AFTER the kimi-k3 short-circuit so the kimi-k3 route
  object never carries a `lean` field. Fable behavior is otherwise identical to before.
- kimi-k3 returns `{provider:'openrouter', model:'moonshotai/kimi-k3', dispatch:'opencode', fallback:'opus', on429:'opus', requiresConfirmation:false}` — no `confirmationDeclined`.
- Prefers `route.engines['kimi-k3']` when present; inline literal fallback keeps
  back-compat with configs lacking the `engines` map. Uses the existing `isRecord` helper
  (defined line 56) — do not add a new guard.
- The review-stage provider guard (lines 124–126) and the "fable only at plan" guard
  (lines 128–130) are UNTOUCHED and still execute before this block.

---

## Edit 4 — `resolvePlannerChoice` (lines 108–113)

**No change.** It already validates against `PLANNER_CHOICES`; Edit 1 makes `'kimi-k3'`
pass. Do not modify.

---

## Edit 5 — `buildAnthropicAgentOptions` (lines 161–173)

**No change.** It is only invoked by the caller for anthropic routes. The kimi-k3 route is
provider=openrouter/dispatch=opencode, so the caller dispatches it to the Opencoder worker
and never calls this helper. The contract is documented inline in the Edit 3 comment.

---

## Test additions — `tests/unit/workflows/routing-policy.test.ts`

Follow the existing vitest + `createRequire` style (top of file). Add THREE new `it`
blocks inside the existing `describe('routing-policy', ...)`. Keep ALL existing tests.

**Test A — `resolvePlannerChoice` accepts kimi-k3.** Extend the existing
`'parses PIPELINE_PLANNER into a planner choice'` test (lines 161–166) by adding one
assertion, OR add a dedicated `it`. Preferred: add to the existing block:
```ts
    expect(routingPolicy.resolvePlannerChoice({ PIPELINE_PLANNER: 'kimi-k3' })).toBe('kimi-k3');
    expect(routingPolicy.resolvePlannerChoice({ PIPELINE_PLANNER: ' KIMI-K3 ' })).toBe('kimi-k3');
```

**Test B — plan routes to kimi-k3 openrouter engine when plannerChoice is kimi-k3:**
```ts
  it('routes plan to the kimi-k3 openrouter engine when plannerChoice is kimi-k3', () => {
    const route = routingPolicy.resolveStageRoute(
      routingPolicy.ROUTING_CONFIG_DEFAULTS,
      'plan',
      { plannerChoice: 'kimi-k3' },
    );

    expect(route).toMatchObject({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      dispatch: 'opencode',
      fallback: 'opus',
      on429: 'opus',
      requiresConfirmation: false,
    });
    expect(route.confirmationDeclined).not.toBeTruthy();
    expect(route.model).not.toBe('fable');
  });
```

**Test C — kimi-k3 short-circuit does not disturb the callback / does not decline:**
```ts
  it('does not consult confirmFableUse when plannerChoice is kimi-k3', () => {
    let called = false;
    const route = routingPolicy.resolveStageRoute(
      routingPolicy.ROUTING_CONFIG_DEFAULTS,
      'plan',
      {
        plannerChoice: 'kimi-k3',
        confirmFableUse: () => {
          called = true;
          return true;
        },
      },
    );

    expect(called).toBe(false);
    expect(route).toMatchObject({ provider: 'openrouter', model: 'moonshotai/kimi-k3' });
  });
```

**Regression (no new code — MUST stay green):** every existing test, especially
`routes plan to lean fable when plannerChoice is explicitly fable` (101–121),
`forces plan to opus when plannerChoice is explicitly opus` (123–145),
`preserves the default opus fallback when plannerChoice is unset` (147–159),
`wires env choice end to end` (168–186), and both guard tests (188–214).

---

## Done criteria

- `npm test` green (new + all existing routing-policy cases).
- `npm run build` clean.
- Diff limited to `routing-policy.js` + `routing-policy.test.ts`. No `any`, no `console.log`.
- `ROUTING_CONFIG_DEFAULTS.stages.plan.engines` matches `routing-config.json` `stages.plan.engines`.
