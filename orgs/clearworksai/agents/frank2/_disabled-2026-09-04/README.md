Disabled 2026-09-04 by Josh (Brain recovery audit, report 02 §3 / 06 §4).

- client-context-sync-worker + sync_client_context.py: rebuilt org-brain client pages
  from CRM and unlinked every canonical page before rewrite (sync_client_context.py:353-355,377).
  Conflicts with meeting_writeback.py as the single writer. Do not re-enable.
- daily-wiki-prep cron removed from config.json: wiki-synthesis is write-once
  (needs_review never cleared) and has zero readers.
