# meetings/ — filing convention

- **Filename:** `YYYY-MM-DD-<client>-<topic>.md` — date first so directory listing sorts
  chronologically, client slug matches `knowledge/clients/<client>.md`, topic short and lowercase.
- **Header contract:** every file opens with frontmatter carrying at minimum a join key back to the
  source transcript (see frontmatter schema below) plus `client:` and `date:`.
- **`dnr-` flag:** a meeting marked do-not-record by the client gets `dnr-` prepended to the filename
  and is excluded from any external-facing digest or summary — content stays internal-only.
- **No orphan transcripts:** every transcript landed in `transcripts/` gets its outcomes written back
  to the matching `clients/<client>.md` file within a day. A transcript with no client outcome after
  24h is a bug, not a backlog item.

## Frontmatter schema — frozen as-is, divergence documented (not migrated)

Four lanes write meetings/CRM notes with different join keys. All four work today (dedup + kb-query
proven) — unifying them is churn-only. This table is the map; do not migrate.

| Lane | Source | Join key |
|---|---|---|
| 01 — Fireflies transcript persist | `ff-transcript-persist.py` | `meeting_id:` + `source: fireflies` |
| 02 — knowledge-capture | `knowledge-capture.py` | `source: fireflies:<id>` |
| 03 — Clearpath meeting dump | `dump-meetings.mjs` | bare `fireflies:<id>` in the `Source` field |
| 04-B — CRM interactions → index | `interactions-to-notes.py` | `contact_id` / `source_ref` |
