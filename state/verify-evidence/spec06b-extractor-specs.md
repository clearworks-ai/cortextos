# spec06b — extractor dual-write specs

## File 1: `ff-extractor.py` (modified)
- Existing extraction flow unchanged.
- After the existing local-sink write, call a new dual-write helper that serializes the
  extracted meeting payload and POSTs it to cxportal's ingest endpoint.
- Failure isolation: dual-write call wrapped in try/except; on failure, log a warning and
  continue — the extractor's exit code / primary output is unaffected by cxportal being
  unreachable.

## File 2: `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py` (new)
- Standalone script, run manually or via cron, to sync already-extracted meeting records
  to cxportal.
- Reads meeting records from the same source `ff-extractor.py` writes to.
- POSTs each record to the cxportal ingest endpoint; skips records that already carry a
  `cxportal_synced` marker so re-runs are idempotent.
- Intended as the backfill/retry path for records that missed the inline dual-write.

## Acceptance criteria
- Both files present and syntactically valid.
- `ff-extractor.py` dual-write does not throw on cxportal unavailability.
- `sync_meetings_to_cxportal.py` is safely re-runnable (idempotent on already-synced
  records).
- No changes to unrelated cortextos TS pipeline code; `npm run build` / `npm test` stay
  green.
