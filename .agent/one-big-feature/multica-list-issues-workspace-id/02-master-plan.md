# Master Plan: multica-list-issues-workspace-id

## Summary

`listIssues()` in `src/bus/multica/client.ts` omitted `workspace_id` on
`GET /api/issues`, causing Multica's API to 400 on every inbound poll. Add the
missing query param. One file, one line of production code, plus a matching
test assertion. No schema change, no other repo, no new endpoint.

## Non-goals

- Do not touch any other `MulticaClient` method.
- Do not change webhook/auth/retry behavior.
- No new tests beyond asserting the missing param is now sent.

## Architecture approach

`normalizedConfig.workspaceId` is already resolved at client-construction time
(from `MULTICA_WORKSPACE_ID`) and is already used by every other
workspace-scoped call. `listIssues()` is the one outlier that built its
`URL` without it. Fix: set `workspace_id` on the `endpoint.searchParams`
inside `listIssues()`, ahead of the optional `limit`/`offset` params, so it is
always present.

## Shard list

Single shard — one spec, one file pair:

1. `03-specs/01-workspace-id-fix-spec.md` — owns
   `src/bus/multica/client.ts` (`listIssues()`) and
   `tests/unit/bus/multica/client.test.ts` (the `listIssues` test case).

## Dependency order

None — single shard, no cross-spec contracts.

## File ownership

- `src/bus/multica/client.ts` — production source, codexer-owned per
  CLAUDE-reference §codex-handoff (Larry does not edit `.ts` in `src/`).
- `tests/unit/bus/multica/client.test.ts` — same ownership rule.

## Implementation status

Already implemented and committed: commit `8e0d452` on branch
`fix/multica-list-issues-workspace-id` (based on `origin/main` @ `dbdc98e`).
This plan documents the existing diff for provenance purposes; codexer is
asked to confirm the diff matches this spec rather than re-implement from
scratch (see dispatch note in `03-specs/01-workspace-id-fix-spec.md`).

## Test strategy

`tests/unit/bus/multica/client.test.ts` asserts the outgoing request URL for
`listIssues()` includes `workspace_id=<configured id>`. Full file: 11/11
passing. Repo-wide `npm run build` clean.

## Rollout / approval gates

- No staging-verify required — cortextos is not a listed prod repo
  (`clearpath|cxportal|nonprofit-hub|auditos|gws-security`); this repo is the
  cortextOS framework itself.
- true-verify required before `gh pr create` (build + full test evidence).
- PR opened for Josh's review/merge — no direct push to main.
