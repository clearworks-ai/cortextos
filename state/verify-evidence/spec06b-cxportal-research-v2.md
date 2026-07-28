# Research: meeting-intelligence-spec06b-cxportal-dual-write-clean-v2

Repo: clearworks-ai/cxportal (working copy ~/code/lifecycle-killer)

## Context
cxportal has no existing endpoint for receiving meeting intelligence extracted by the Fireflies/extractor pipeline (spec06b, cortextos-side, PR #162). Meeting action items currently only exist on the extractor side; there is no path for them to land in cxportal against a client engagement, and no path for the CRM to see them as commitments.

## Findings
- `clientPeople.email` is the existing join key used elsewhere in cxportal to resolve a person to their engagement — reusable for attendee-to-engagement resolution on ingest, no new resolution mechanism needed.
- Session-based auth middleware (`isAuthenticated`) is applied globally across `/api/*` routes; a machine-to-machine ingest route needs an explicit carve-out rather than session auth, since the caller is the extractor pipeline, not a logged-in user.
- No existing `meeting_action_items` table/dual-write path existed prior to this work; this is net-new schema + route surface.
- CRM side needs a poll-based sync worker (`sync_commitments_from_cxportal.py`) since cxportal does not push to CRM directly; psycopg2 direct DB read against cxportal's Postgres is the existing pattern used by other CRM-side sync scripts in this codebase.

## Prior art
Commit 5be83a0 on this branch already implements the ingest endpoint, dual-write, sync worker, and an auth-middleware fix (session auth was initially intercepting the ingest route before the shared-secret check ran — found and fixed in the same commit). This research artifact documents the problem space this implementation solves; the implementation itself is captured in the `implement` ledger stage.
