# Discovery: multica-list-issues-workspace-id

## Request

Multica's inbound poll (`listIssues()` in `src/bus/multica/client.ts`) 400s on
every call. Root cause: `GET /api/issues` never included `workspace_id`, which
Multica's API requires on every request.

## Scope classification

Single one-line fix in one existing function, one existing repo (cortextos),
no schema/migration, no multi-repo. Framework = **one-big-feature (OBF)**, not
full M2C1.

## Current state (already implemented on branch)

Branch `fix/multica-list-issues-workspace-id` (based on `origin/main` at
`dbdc98e`) already carries the fix at commit `8e0d452`:

- `src/bus/multica/client.ts` — `listIssues()` now sets
  `endpoint.searchParams.set('workspace_id', normalizedConfig.workspaceId)`
  before other query params.
- `tests/unit/bus/multica/client.test.ts` — updated to assert the
  `workspace_id` param is present on the request.

Verified locally: `npm run build` clean; `npx vitest run
tests/unit/bus/multica/client.test.ts` — 11/11 passing.

## Why this OBF exists

The implementation predates this OBF folder (built directly by Josh). This
folder exists to give the fix a legitimate, signed provenance chain so it can
pass `gate-pr-push.sh`'s true-verify requirement before `gh pr create`. See
`01-research.md` for the technical detail, `02-master-plan.md` for the plan,
and `03-specs/01-workspace-id-fix-spec.md` for the spec that the existing diff
is being verified against.
