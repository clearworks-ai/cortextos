# Research: multica-list-issues-workspace-id

## Bug

`src/bus/multica/client.ts`, function `createMulticaClient(...)`, method
`listIssues(params)` (pre-fix, around line 135-138):

```ts
async listIssues(params) {
  const endpoint = new URL(`${normalizedConfig.baseUrl}/api/issues`);
  if (params?.limit !== undefined) endpoint.searchParams.set('limit', String(params.limit));
  if (params?.offset !== undefined) endpoint.searchParams.set('offset', String(params.offset));
  ...
}
```

`normalizedConfig.workspaceId` is resolved earlier in the same module (from
`MULTICA_WORKSPACE_ID`, see `normalizeRequiredValue(resolved.MULTICA_WORKSPACE_ID)`
around line 84, and included in `normalizedConfig` at line 102) but was never
attached to the `listIssues` request's query string. Multica's `/api/issues`
endpoint requires `workspace_id` on every GET — its absence causes a 400 on
every inbound poll cycle.

Every other client method that hits a workspace-scoped endpoint sets
`workspace_id`; `listIssues` was the one call site that omitted it.

## Fix (already committed, commit `8e0d452` on
`fix/multica-list-issues-workspace-id`)

```ts
async listIssues(params) {
  const endpoint = new URL(`${normalizedConfig.baseUrl}/api/issues`);
  endpoint.searchParams.set('workspace_id', normalizedConfig.workspaceId);
  if (params?.limit !== undefined) endpoint.searchParams.set('limit', String(params.limit));
  if (params?.offset !== undefined) endpoint.searchParams.set('offset', String(params.offset));
  ...
}
```

One line added, before the optional `limit`/`offset` params so `workspace_id`
is always present regardless of what the caller passes.

## Test coverage

`tests/unit/bus/multica/client.test.ts` was updated in the same commit to
assert the outgoing request's `workspace_id` query param matches the
configured workspace ID for `listIssues()`. Full suite: 11/11 passing.

## Verification run (this research pass)

```
$ npm run build     # clean, no errors
$ npx vitest run tests/unit/bus/multica/client.test.ts   # 11 passed (11)
```

## Non-goals

- No change to any other Multica client method.
- No change to webhook handling, auth, or retry logic.
- No schema/migration; no other repo touched.
