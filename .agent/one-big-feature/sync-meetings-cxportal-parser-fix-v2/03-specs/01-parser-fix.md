# Spec 01 — parser fix for sync_meetings_to_cxportal.py

File: `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py`

## Change 1 — inline attendees
Add module-level regex:
```python
INLINE_ATTENDEES_RE = re.compile(r"\*\*Attendees:\*\*\s*(.+?)\s*$")
```
In `load_meeting_records`, before the main per-line loop (or as an early check per
line in `lines[1:]`), test each line against `INLINE_ATTENDEES_RE`. On match, split
group(1) on `,`, `.strip()` each piece, drop empties, extend `meeting["attendees"]`.
This must not interfere with the existing `## Attendees` section loop — if both are
present, dedupe by exact string match before finalizing (unlikely in practice, but
don't produce duplicates).

## Change 2 — prose-style commitments
Add second regex:
```python
PROSE_COMMITMENT_RE = re.compile(r"^- \*\*([^*:]+):\*\*\s+(.+)$")
```
In the `elif current_section in ("commitments", "action items", "follow-up")` branch,
try `COMMITMENT_RE` first (existing checkbox behavior unchanged). If it doesn't
match, try `PROSE_COMMITMENT_RE`. On match: owner = group(1).strip(), description =
group(2).strip(), status = "open", dueDate = None. Append to `current_commitments`
with the same dict shape as the existing branch (`description`, `status`,
`ownerName`, `dueDate`, `origin: "crm"`).

## Test
New file `orgs/clearworksai/agents/frank2/scripts/tests/test_sync_meetings_to_cxportal.py`
(check first whether one already exists — if so, extend it instead of creating a
duplicate). One test: load
`orgs/clearworksai/agents/crm/crm/meetings/2026-06-24-alloi-it-services-discussion.md`
via `load_meeting_records`, assert `len(attendees) == 4` and
`len(commitments) == 2` with owners `"Marcos"` and `"Nathan"` (case-insensitive
containment check is fine, e.g. `"Marcos" in commitments[0]["ownerName"]`).

## Constraints
- Single file diff (plus one new/extended test file). No refactor of
  `post_to_cxportal`, `main`, CLI args, or the AGENT_DIR/CRM_DIR path constants.
- Do not touch ff-extractor.py.
- Exact replacement only — no unrelated cleanup.
