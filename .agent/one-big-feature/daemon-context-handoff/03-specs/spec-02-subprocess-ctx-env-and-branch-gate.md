# SPEC — buildSubprocessCtxEnv + ci-alert-gate branchExists

**Status:** TDD — tests already committed on `feat/comms-meeting-dedup`, failing on `main` build. Implement ONLY the two functions below to make the existing tests pass. Do not touch test files.

## 1. `buildSubprocessCtxEnv` — `src/utils/env.ts`

Net-new export, no existing callers yet (wiring callers is a follow-up, out of scope here).

```ts
export interface SubprocessCtxEnvOptions {
  root: string;
  instanceId?: string;
  ctxRoot?: string;
  org?: string;
}

export function buildSubprocessCtxEnv(
  inherited: Record<string, string | undefined>,
  opts: SubprocessCtxEnvOptions,
): Record<string, string>
```

Behavior (see `tests/unit/utils/env.test.ts` describe block `buildSubprocessCtxEnv`, ~line 321):
- Copy every defined key from `inherited` into the result.
- Delete `CTX_AGENT_DIR` from the result unconditionally (forces `resolveEnv()` to re-derive `agentDir` under the new root from `org`/`projectRoot`/`agentName`).
- Always set `CTX_FRAMEWORK_ROOT` and `CTX_PROJECT_ROOT` to `opts.root`.
- Only when provided, override: `opts.instanceId` -> `CTX_INSTANCE_ID`, `opts.ctxRoot` -> `CTX_ROOT`, `opts.org` -> `CTX_ORG`. If not provided, leave the inherited value untouched.

Run `npx vitest run tests/unit/utils/env.test.ts` to verify (3 new tests currently fail with `buildSubprocessCtxEnv is not a function`).

## 2. `branchExists` — `src/utils/ci-alert-gate.ts`

Test file: `tests/unit/utils/ci-alert-gate.test.ts`.

### `CiAlertInput`
Add optional field: `branchExists?: boolean`.

### `evaluateCiAlert`
Add an early check (after the existing `ghError` check, before `prState === 'MERGED'`):
```ts
if (input.branchExists === false) {
  return decision(false, 'skip: branch deleted');
}
```

### `gatherCiAlertContext(repo, branch, opts)`
Before the existing `pr list` / `run list` / `compare` calls, do ONE `gh api` branch-existence check:
```ts
runGh(['api', `repos/${repo}/branches/${branch}`, '--jq', '.name']);
```
- If it throws, return immediately (no other `gh` calls):
```ts
{ prState: 'NOTFOUND', runs: [], headSha: opts.headSha, branchExists: false }
```
  (NOT the generic `ghError` fallback — no `ghError` field on this path.)
- If it succeeds, proceed with the existing pr-list/run-list/compare flow unchanged (existing `fallback()` with `ghError: true` still applies if THAT block throws).

Verify: `npx vitest run tests/unit/utils/ci-alert-gate.test.ts` — currently 2 failures (`evaluateCiAlert > deleted branch skips before failed run can surface`, `gatherCiAlertContext > returns branchExists false early and skips later gh calls when branch lookup throws`).

## Done =
`npx vitest run tests/unit/utils/env.test.ts tests/unit/utils/ci-alert-gate.test.ts` fully green, `npm run build` clean, no other files touched.
