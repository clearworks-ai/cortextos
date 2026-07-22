# Adversarial Review — meetings-workspace-detail-fix (commit e84e7f6)

## VERDICT: PASS

## Findings

No blocking findings. One informational note below.

- `server/storage.ts:1883`: INFO: the `contacts` query is scoped by `meetingId` only, not `orgId` — but this is pre-existing (unchanged by this diff) and safe because line 1881 (`getMeeting(orgId, id)`) already org-gates the meeting and returns `undefined` (→ route 404) before any child rows are fetched. `meetingContacts` has no `orgId` column, so meetingId scoping is the only available discriminator; the org boundary is correctly enforced at the parent. Not a regression, no action required.

## What was verified

**ORG ISOLATION — PASS.** The two new queries both go through org-scoped helpers:
- `server/storage.ts:1884` → `getCommentsByMeeting` (`:2292-2296`) filters `and(eq(meetingComments.orgId, orgId), eq(meetingComments.meetingId, meetingId))`.
- `server/storage.ts:1885` → `getApprovalsByMeeting` (`:2252-2256`) filters `and(eq(meetingApprovals.orgId, orgId), eq(meetingApprovals.meetingId, meetingId))`.
- The parent meeting is org-gated first at `:1881` via `getMeeting` (`:1875-1877`, `and(eq(meetings.id, id), eq(meetings.orgId, orgId))`); missing → `undefined` → route returns 404 (`server/routes.ts:3371`), not 403. Cross-org access to a foreign meeting therefore yields 404 with zero child rows fetched. No new raw `db.select` was introduced; both helpers are the exact ones the portal detail route already uses (`server/routes.ts:7646-7648`), so this is proven-org-safe parity, no new JOIN, no cross-org leak.

**SCOPE — PASS.** `git show --stat` for e84e7f6 touches exactly 5 files: 3 OBF planning docs (research/master-plan/spec), `server/storage.ts` (+8/-3 = interface signature `:493` + impl `:1880-1886`), and the new `tests/meeting-detail-shape.test.ts`. No client change (client type was already correct), no schema/migration, no unrelated edits.

**CODE RULES — PASS.** No `any` introduced — return type uses concrete `MeetingComment[]` / `MeetingApproval[]` (both already imported at `server/storage.ts:87,89`). No `console.log`. Endpoint is read-only (GET), so Zod-on-mutation is n/a. Interface signature (`:493`) and impl (`:1880`) return types kept in sync.

**TESTS — PASS (not hollow).** `tests/meeting-detail-shape.test.ts` hits the real `GET /api/meetings/:id` via supertest against a seeded meeting. Test 1 seeds a comment + approval and asserts `res.body` has `comments`/`approvals` keys, that they are arrays, and that the seeded rows appear (`comments[0].body`, `approvals[0].role`). Test 2 asserts empty arrays when none exist. The original crash was `approvals.length` on `undefined`; before this fix the endpoint returned no `approvals` key, so `toHaveProperty('approvals')` + `Array.isArray` would have failed — the regression test genuinely reproduces and guards the bug.

**CORRECTNESS — PASS.** Client contract at `client/src/pages/meeting-workspace.tsx:91-96` declares `MeetingDetailResponse = { meeting, contacts, comments, approvals }` with `comments`/`approvals` as non-optional arrays (`:94-95`). It destructures all four at `:1407` and consumes `approvals.length` (`:846`), `comments.length` (`:898`), `comments.map` (`:908`) with no optional chaining. The returned object (`:1886`) now supplies both as guaranteed arrays (helpers always return an array, never null/undefined). Shape matches exactly; no nullability mismatch. Fix is at the correct layer (server delivers the data the client already asks for) rather than papering over with client-side defaults.
