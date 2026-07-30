# spec06b — extractor dual-write review

## Diff scope (origin/main...feat/meeting-intelligence-spec06b-extractor-dual-write-fixed)
- 2 files changed, verified via `git diff origin/main...HEAD --stat`.
- `ff-extractor.py` — modified: adds a guarded dual-write branch that POSTs the extracted
  meeting payload to cxportal's ingest endpoint after the existing local write succeeds.
  Wrapped in try/except so a cxportal outage never blocks or fails the extractor's primary
  responsibility.
- `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py` — new file: standalone
  backfill/retry worker that reads already-extracted meeting records and syncs any that are
  missing a `cxportal_synced` marker to cxportal, idempotently.

## Review checklist
- No stub functions / TODO placeholders in either file.
- Merge-base clean vs `origin/main` — branch is fast-forwardable, no unresolved conflict
  markers in the diff.
- `ff-extractor.py` dual-write logic verified: failure isolation confirmed (try/except around
  the cxportal POST call; local write path unaffected by cxportal errors).
- `sync_meetings_to_cxportal.py` verified: standalone entrypoint, reads existing extractor
  output, re-runnable without duplicating already-synced records.
- No unrelated files touched; no changes to core TS pipeline code (`src/pipeline/**`).

## Verdict
Diff is scoped, additive, and isolated to the meeting-intelligence dual-write path. Ready for
`true-verify` (build + test) and PR.
