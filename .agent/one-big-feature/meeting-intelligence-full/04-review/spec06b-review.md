# Review — meeting-intelligence-spec06b-cxportal-dual-write-clean

**Branch:** `feat/meeting-intelligence-spec06b-cxportal-dual-write-clean` (repo: clearworks-ai/cxportal, local checkout `~/code/lifecycle-killer`)
**Commit under review:** `5be83a0` — `fix: add /meetings/ingest to middleware exclusion allowlist`
**Merge-base check:** diff generated as `git diff origin/main...feat/meeting-intelligence-spec06b-cxportal-dual-write-clean`, i.e. against the current `origin/main` merge-base. No conflicts, no unrelated commits pulled in.

## Files touched (matches expected scope, no drive-by changes)
- `scripts/sync_commitments_from_cxportal.py` — new worker, dual-write sync job
- `server/auth.ts` — shared-secret auth handling for the ingest route
- `server/routes.ts` — new `POST /api/meetings/ingest` route + engagement mapping via `clientPeople.email`
- `server/storage.ts` — `meeting_action_items` dual-write storage methods

## Correctness checks performed
1. **Real DB query, not a stub.** `query_cxportal_commitment_changes()` in `scripts/sync_commitments_from_cxportal.py` connects via real `psycopg2.connect(database_url)` and issues a live SQL query against `meeting_action_items` (RealDictCursor). A stub fallback exists only for local dev when `psycopg2` isn't installed (`import` guarded with a WARNING print) — production path is the real query.
2. **Auth bug found + fixed in this same commit.** The original build had the global auth middleware blocking the shared-secret `/api/meetings/ingest` route (opencode caught this). `server/auth.ts` now excludes that route from the session-auth gate so the shared-secret check in `routes.ts` can run instead. Confirmed via the middleware exclusion allowlist diff.
3. **Engagement mapping.** `POST /api/meetings/ingest` maps the inbound meeting payload to a cxportal engagement via `clientPeople.email` lookup before writing meeting + action-item rows.
4. **Dual-write scope.** Action items are written to `meeting_action_items`; only `status` is portal-writable per the resolved sync contract (spec 07) — CRM stays authoritative for meeting content, cxportal is additive at ingest.

## Live staging verification (already performed, not re-run here)
- **Staging URL:** `https://lifecycle-killer-staging.up.railway.app/api/meetings/ingest`
- **Result:** HTTP 201, real `meeting` + `action_item` rows created in the staging DB.
- **Commit verified against:** `5be83a0` (same commit as this review).

## Verdict
Approved to proceed to staging-verify / PR. Scope is contained to the ingest endpoint + sync worker + the auth-middleware fix required to make the endpoint reachable. No unrelated files touched.
