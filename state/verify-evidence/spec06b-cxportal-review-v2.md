# Review: meeting-intelligence-spec06b-cxportal-dual-write-clean-v2

Repo: clearworks-ai/cxportal (working copy ~/code/lifecycle-killer)
Branch: feat/meeting-intelligence-spec06b-cxportal-dual-write-clean-v2
Commit: 5be83a0
Companion PR: extractor-side dual-write, clearworks-ai/cortextos#162

## Diff scope
- `git diff origin/main...feat/meeting-intelligence-spec06b-cxportal-dual-write-clean-v2` verified against a clean merge-base — no unrelated files pulled in, no stray formatting-only churn outside the touched modules.
- Diff limited to the expected surface: the new ingest route, the auth-middleware exclusion, and the new sync worker script (plus their direct supporting wiring). No unrelated route/table/config changes rode along.

## POST /api/meetings/ingest
- New endpoint accepts inbound meeting payloads guarded by a shared-secret check (`requireMeetingIngestSecret`), not session auth — this is a machine-to-machine ingest path from the extractor side, not a user-facing route.
- Resolves the calling org/engagement via `clientPeople.email` lookup against attendee emails on the payload, so ingested meetings land against the correct client engagement rather than a hardcoded org.
- Dual-writes: a `meetings` row plus one `meeting_action_items` row per extracted action item, in the same transaction — verified by reading the handler, not assumed.

## Auth-middleware bug (caught + fixed this session, present in 5be83a0)
- The global session-auth middleware was intercepting `/api/meetings/ingest` before the shared-secret check ever ran, returning 401 for the legitimate machine caller.
- Fixed by excluding the ingest route from the session-auth chain so the shared-secret guard is the sole gate on that path. Confirmed via the live staging call below — before the fix this returned 401, after the fix it returns 201.

## sync_commitments_from_cxportal.py
- `query_cxportal_commitment_changes()` is a real psycopg2 query, not a stub: it joins `meeting_action_items` to `meetings` and filters on updated-since, returning genuine commitment rows for the CRM-side dual-write sync worker to consume. Read the query text directly — confirmed it is not a placeholder/mock/hardcoded list.

## Live staging verification (this session, already proven, not re-run here)
- POST to the staging ingest endpoint (`https://lifecycle-killer-staging.up.railway.app`) with a real payload returned HTTP 201.
- Confirmed real rows landed: one `meetings` row and matching `meeting_action_items` row(s), under org `staging-verify-test-org`.
- This satisfies the staging-first protocol for this change before any prod-facing merge.

## Verdict
Approve to proceed to staging-verify / true-verify ledger stages and PR. No blocking issues found in this pass; auth-middleware bug from the original implement pass is already fixed in commit 5be83a0.
