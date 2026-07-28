# Research — sync_meetings_to_cxportal.py backfill dry-run finding

Josh live-requested a backfill test on real meetings. Ran:
`python3 sync_meetings_to_cxportal.py --dry-run --meetings-dir <real crm/crm/meetings>`
against 5 real CRM meeting .md files. Result: attendees=[] and commitments=0 for
every meeting.

Traced the parser (`load_meeting_records`) against a real file
(`2026-06-24-alloi-it-services-discussion.md`): attendees are inline
(`**Duration:** ... **Attendees:** Name (Org), ...`), not a `## Attendees` section;
action items are `- **Owner:** description` prose bullets, not checkbox syntax. The
parser only recognizes the section-header/checkbox shapes, so it silently
extracts nothing from the real format. See 02-master-plan.md for the fix scope.
