# spec06b — extractor dual-write plan

## Approach
1. Add a small `_dual_write_cxportal(payload)` helper inside `ff-extractor.py` that fires
   after the existing local write succeeds. Wrap in try/except so a cxportal-side error is
   logged (not raised) and never blocks the extractor's primary responsibility.
2. Add `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py` as an
   independent worker script: reads already-extracted meeting records, POSTs each to the
   cxportal ingest endpoint, and can be re-run idempotently (skips records already synced).
3. No schema changes on the cortextos side — this is additive network I/O only, so no
   Drizzle migration is required.
4. Config: cxportal ingest URL + auth token read from environment (matches existing
   frank2 script conventions), not hardcoded.

## Out of scope
- Changes to the cxportal-side ingest endpoint itself (already landed separately as the
  spec06a companion).
- Retry/backoff tuning beyond a basic try/except — can be hardened in a follow-up if
  failures are observed in production.

## Test plan
- `npm run build` — TypeScript compiles cleanly (this repo is TS-first; the Python
  scripts are not type-checked by this command but must not break the build).
- `npm test` — existing unit/integration suite stays green; no test regressions expected
  since this change only touches Python extractor/worker scripts, not TS pipeline code.
