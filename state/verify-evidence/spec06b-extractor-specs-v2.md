# spec06b — Extractor Dual-Write Specs (v2)

## File 1: `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` (modified)

Behavior added/changed, read directly from the diff:

- **Client-context matching.** New constants (`KNOWLEDGE_DIR`, `CLIENTS_DIR`,
  `COMPANY_PATH`, `OFFER_PATH`, `STATE_PATH`) point at the org's knowledge tree.
  `client_context_records()` parses each `clients/*.md` file into name/email sets,
  deal stage, CRM status, engagement, and an `open items` markdown table.
  `matched_client_context_record_for_transcript()` scores each client record against
  a transcript's attendee emails/names (email match = 10pts, name substring = 2-3pts)
  and only returns a match at score >= 3. The matched context string is injected into
  `ACTION_ITEMS_PROMPT` via a new `{client_context}` placeholder (previously
  `{client_context_block}`, now always populated with `client_context or ""`).
- **Priority/relevance scoring.** `RefinedCommitment` gains `action_text`, `priority`
  (default "P3"), `relevance_score`. `priority_for_commitment()` assigns P0 if due
  within 3 days (and relevance above threshold when client context exists), P1 if due
  within 10 days or relevance >= 0.45, P2 if any due date or relevance >= 0.2, else P3.
  `enforce_priority_caps()` caps P0 at 3 and P1 at 7, demoting overflow down a tier
  (P0 overflow -> P1 pool, P1 overflow -> P2 pool), with tie-break by relevance then due
  date. `deduped_commitments()` fuzzy-matches (`SequenceMatcher` + token Jaccard,
  threshold 0.6) each commitment's text against the client's existing open-items
  backlog and drops matches.
- **Full-mode ledger dedup.** New `--full-ledger` CLI flag; `run_full()` now skips any
  transcript id present in the ledger file and reports `skipped_ledger` in output JSON.
- **Removed:** `select_commitment_transcripts()` (dead code, deleted) and the
  `--meeting-id` filter for commitments mode — `run()`/`execute()` no longer accept a
  `meeting_id` param. The watermark save at end of `run()` is now unconditional
  (previously gated on `is_newer_than_watermark`).

## File 2: `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py` (new, 201 lines)

Standalone script, run independently (not imported by ff-extractor.py):

- `load_meeting_records(meetings_dir)` walks `crm/crm/meetings/*.md`, treats the first
  line as the title, then state-machine-parses `## Attendees` and
  `## Commitments|Action Items|Follow-up` sections. Commitment lines matched by
  `COMMITMENT_RE` (`- [x] text by: owner due: date`); non-matching lines under an open
  commitment are appended to the previous commitment's description (multi-line support).
- `post_to_cxportal(meeting, org_id, ingest_url, ingest_secret)` builds a JSON payload
  (`orgId`, `meeting.{title,status:"completed",source,sourceId,extract.attendees}`,
  `actionItems[]`) and POSTs to `ingest_url` with header
  `x-meeting-ingest-secret`. Wraps the whole POST in `try/except Exception`, printing
  an error and returning `None` on any failure (including non-200/201 status).
- `main()` requires `CXPORTAL_ORG_ID`, `CXPORTAL_INGEST_URL`, `CXPORTAL_INGEST_SECRET`
  env vars (exits 1 if any missing), supports `--dry-run` (prints without POSTing),
  otherwise loops all meeting records, POSTs each independently, tallies posted/failed,
  and exits 1 only if any meeting failed.
