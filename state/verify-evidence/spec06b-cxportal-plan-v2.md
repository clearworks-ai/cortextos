# Plan: meeting-intelligence-spec06b-cxportal-dual-write-clean-v2

Repo: clearworks-ai/cxportal (working copy ~/code/lifecycle-killer)
Branch: feat/meeting-intelligence-spec06b-cxportal-dual-write-clean-v2

## Goal
Add a meeting-ingest surface to cxportal and a companion CRM-side commitment sync worker so meeting action items captured by the extractor land in cxportal against the correct client engagement, and are visible to the CRM as commitments.

## Contract
1. `POST /api/meetings/ingest` — accepts an inbound meeting payload (attendees, transcript summary, extracted action items) from the extractor pipeline. Auth is a shared secret header (`requireMeetingIngestSecret`), not session auth, since the caller is a machine, not a logged-in user.
2. Org/engagement resolution — match attendee emails against `clientPeople.email` to find the owning engagement; reject or park unmatched payloads rather than guessing.
3. Dual-write on ingest — one `meetings` row plus one `meeting_action_items` row per extracted action item, in a single transaction.
4. `sync_commitments_from_cxportal.py` — a CRM-side worker that polls cxportal for new/changed `meeting_action_items` (joined to `meetings`) via a real psycopg2 query, and syncs them into the CRM as commitments.
5. Auth-middleware ordering — the global session-auth middleware must not intercept the shared-secret ingest route; the ingest path needs an explicit exclusion so the shared-secret check is the only gate on it.

## Out of scope
No UI changes. No changes to existing meeting-viewing endpoints. No retry/backoff logic beyond what already exists in the worker's failure isolation.
