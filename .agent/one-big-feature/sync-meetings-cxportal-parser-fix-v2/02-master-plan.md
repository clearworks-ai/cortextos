# Master Plan — sync_meetings_to_cxportal.py parser fix

## Problem
Josh asked to test backfill on real meetings. Dry-run against 5 real CRM meeting
.md files (orgs/clearworksai/agents/crm/crm/meetings/) returned 0 attendees and
0 commitments for every meeting. Root cause: the parser in
`orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py` assumes a
markdown shape the real CRM notes don't use.

## Evidence (real file: crm/crm/meetings/2026-06-24-alloi-it-services-discussion.md)
- Attendees are inline on the second line: `**Duration:** 15min · **Attendees:** Josh Weiss (Clearworks), Marcos Santa Ana (Alloi), ...`
  Parser only looks for a `## Attendees` section header (SECTION_RE) — never matches, list stays empty.
- Action items are `- **Name:** description` bullets under `## Action items`.
  Parser's COMMITMENT_RE requires checkbox syntax `- [ ] text by: X due: Y` — never matches, commitments stay empty.

## Fix scope (single file, no new files, no refactor)
File: `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py`

1. In `load_meeting_records`, after reading `lines[0]` (title), scan the next few
   lines for a `**Attendees:**` inline marker (regex `\*\*Attendees:\*\*\s*(.+?)(?:\n|$)`
   applied per-line since lines are already split). Split the captured text on `,`,
   strip each entry, populate `meeting["attendees"]`. Keep the existing `## Attendees`
   section-based parsing as a fallback (some files may use either shape).
2. In the action-items branch, add a second commitment pattern for
   `- **Owner:** description` (regex `^- \*\*([^*:]+):\*\*\s+(.+)$`) — capture owner
   as group 1, description as group 2, status "open", dueDate None (no due-date
   syntax in this format — leave null, do not invent a due date). Try the existing
   checkbox pattern first; if it doesn't match, try this one.
3. No changes to `post_to_cxportal`, `main`, CLI args, or the (separately known,
   already-flagged, NOT in scope here) `AGENT_DIR` path bug — that's a deploy/env
   concern, not a parsing bug, and Josh didn't ask for it. Do not touch it.

## Out of scope
- Do not fix the AGENT_DIR/CRM_DIR default path (frank2/crm/crm vs real crm/crm/meetings).
- Do not add due-date extraction/inference from free text.
- Do not touch ff-extractor.py or any other file.

## Verification
- Add/extend `orgs/clearworksai/agents/frank2/scripts/tests/test_ff_extractor.py`
  sibling test file `test_sync_meetings_to_cxportal.py` (new, minimal) OR add cases
  inline if a test file for this script already exists — check first.
- Must assert: running `load_meeting_records` against
  `orgs/clearworksai/agents/crm/crm/meetings/2026-06-24-alloi-it-services-discussion.md`
  yields non-empty attendees list (4 names) and non-empty commitments list (2 items,
  owners "Marcos" and "Nathan").
- Re-run manually after: `python3 sync_meetings_to_cxportal.py --dry-run --meetings-dir <real dir>`
  and confirm attendees/commitments are populated for all 5 files.
