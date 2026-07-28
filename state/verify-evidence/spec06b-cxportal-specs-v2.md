# Specs: meeting-intelligence-spec06b-cxportal-dual-write-clean-v2

## POST /api/meetings/ingest
- Method/path: `POST /api/meetings/ingest`
- Auth: shared-secret header, enforced by `requireMeetingIngestSecret` middleware, mounted so it runs instead of (not after) the global session-auth middleware for this route.
- Body: attendees (list of emails), meeting metadata, extracted action items (text, owner email, due date if present).
- Behavior: resolve engagement via `clientPeople.email` match against attendee emails; on match, insert one `meetings` row and one `meeting_action_items` row per action item in one transaction; on no match, return an error rather than writing to a default/guessed org.
- Response: 201 with the created meeting id on success.

## sync_commitments_from_cxportal.py
- Real psycopg2 connection against the cxportal database (read-only for this worker).
- `query_cxportal_commitment_changes()` — joins `meeting_action_items` to `meetings`, filters on an updated-since watermark, returns rows with engagement id, action item text, owner, due date, meeting date.
- Each returned row is synced into the CRM as a commitment; failures on one row do not block the rest (failure-isolated per row).

## Acceptance
- A POST to `/api/meetings/ingest` with a valid shared secret and a payload whose attendee email matches an existing `clientPeople` row returns 201 and creates real `meetings` + `meeting_action_items` rows.
- A POST without the correct shared secret is rejected before reaching the handler.
- `query_cxportal_commitment_changes()` returns real joined rows, not a stub/mock/hardcoded list.
