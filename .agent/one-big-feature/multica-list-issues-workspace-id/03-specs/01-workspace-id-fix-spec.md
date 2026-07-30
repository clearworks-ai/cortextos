# Spec 01: workspace_id on listIssues

## Objective

`listIssues()` in `src/bus/multica/client.ts` must send `workspace_id` on
`GET /api/issues`, matching every other workspace-scoped call in this client.

## Owned files

- `src/bus/multica/client.ts`
- `tests/unit/bus/multica/client.test.ts`

## Files read but not edited

- none (single self-contained fix)

## Provided / consumed contracts

None — no other spec depends on this one; no cross-spec surface.

## Implementation steps

1. In `listIssues(params)`, immediately after constructing
   `endpoint = new URL(\`${normalizedConfig.baseUrl}/api/issues\`)`, add:

   ```ts
   endpoint.searchParams.set('workspace_id', normalizedConfig.workspaceId);
   ```

   before the existing optional `limit`/`offset` param handling.

2. Update `tests/unit/bus/multica/client.test.ts` to assert the request made
   by `listIssues()` includes `workspace_id=<configured workspace id>` in its
   query string (matching the assertion style already used for other
   workspace-scoped methods in the same file).

## Validation requirements

- `npm run build` — clean.
- `npx vitest run tests/unit/bus/multica/client.test.ts` — all tests pass.
- No `any`, no `console.log` introduced.

## Handoff requirements

Codexer note: this exact change is **already implemented and committed** as
commit `8e0d452` on branch `fix/multica-list-issues-workspace-id` (based on
`origin/main` @ `dbdc98e`). Do not re-implement from scratch — inspect the
existing diff (`git show 8e0d452 -- src/bus/multica/client.ts
tests/unit/bus/multica/client.test.ts`), confirm it matches this spec exactly
(one-line addition in `listIssues()`, matching test update), and reply
confirming the match so Larry can emit the `implement` stage row against the
existing commit. If the diff does not match this spec, say so and describe
the delta instead.

## Adjacent specs

None (single-shard fix).
