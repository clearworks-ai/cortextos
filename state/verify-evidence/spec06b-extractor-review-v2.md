# spec06b — Extractor Dual-Write Review (v2)

## Stub check
No stubs. `sync_meetings_to_cxportal.py`'s functions (`load_meeting_records`,
`post_to_cxportal`, `main`) are fully implemented, no `TODO`/`pass`/`NotImplementedError`.
Same for the `ff-extractor.py` additions — `priority_for_commitment`,
`enforce_priority_caps`, `deduped_commitments`, `client_context_records`, etc. are all
real logic, not placeholders.

## Scope check
This diff is broader than its "dual write" label suggests. Beyond adding the sync
worker, `ff-extractor.py` alone bundles four distinct changes: (1) client-context
matching against CRM markdown, (2) a new priority/relevance scoring + cap/demotion
system, (3) full-mode ledger-based dedup (`--full-ledger`), and (4) two unrelated
behavior removals — dropping `--meeting-id` filtering from commitments mode and making
watermark save unconditional. None of these four are "dual write" in the literal
sense; they're prompt/ranking/dedup changes that happen to land in the same commit as
the new sync script. Worth flagging to whoever named this diff — the name undersells
what actually changed and a reviewer scanning by title alone would miss the priority
scoring/dedup logic entirely.

## Failure isolation
Reasonable. `post_to_cxportal()` wraps its request in `try/except Exception`,
returning `None` on any failure (network error, non-200/201 status, malformed
response) rather than raising. `main()`'s loop continues past a failed meeting,
tallying `posted`/`failed` counts and only exiting non-zero at the end if any meeting
failed — one bad meeting record does not block the rest of the batch. On the
`ff-extractor.py` side, `execute()`/`execute_full()` already caught the relevant
exception classes before this diff and still do; that pattern wasn't changed here.

## Idempotency — real gap
`sync_meetings_to_cxportal.py` has no client-side idempotency guard. Every run reloads
every `*.md` file under `meetings_dir` and re-POSTs all of them — there is no watermark
file and no "already synced" ledger, unlike `ff-extractor.py`'s own
`load_ledger`/`--full-ledger` pattern introduced in this same diff. Whether repeated
runs are safe depends entirely on the cxportal ingest endpoint doing an upsert keyed
on `sourceId` server-side; the client makes no such guarantee. If the endpoint appends
rather than upserts, running this script on a cron will duplicate every meeting on
every tick. This should be either confirmed against the ingest endpoint's actual
behavior or fixed client-side (a synced-ids ledger, mirroring the ledger pattern
already established in `ff-extractor.py`) before this runs unattended.

## Minor
- `ORG_ID`/`INGEST_URL`/`INGEST_SECRET` are read from `os.environ` at module import
  time, not inside `main()` — if env vars are injected after import (e.g. a dotenv
  loader that runs later in some caller), the script will fail even though the env is
  correct by the time `main()` runs. Low risk for a script invoked as `__main__`, but
  worth noting if it's ever imported.
- The multi-line commitment continuation (`elif current_commitments and line.strip()`)
  will append *any* non-blank line under a commitments section to the previous
  commitment's description, with no delimiter check — a stray paragraph in CRM
  markdown that isn't meant as a continuation would silently get glued onto the prior
  commitment's text.
