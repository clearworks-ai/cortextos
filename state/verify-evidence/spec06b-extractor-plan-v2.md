# spec06b — Extractor Dual-Write Plan (v2)

## What the diff actually does

The diff touches two files. It is not a single "dual-write helper" living inside
`ff-extractor.py` — it is two independently-written paths into cxportal:

1. **`ff-extractor.py`** (existing extractor, ~1650 lines) gains client-context
   awareness. It now reads `knowledge/clients/*.md`, `company.md`, `offer.md`, and
   `STATE.md` from the org's knowledge dir, fuzzy-matches a Fireflies transcript to a
   client record by attendee email/name overlap (`matched_client_context_record_for_transcript`),
   and threads that context into the `ACTION_ITEMS_PROMPT` so the LLM extraction is
   client-aware. On top of that it adds a full priority/relevance scoring layer
   (`priority_for_commitment`, `relevance_score_for_commitment`), fuzzy dedup against
   a client's open-items backlog (`deduped_commitments`, `FUZZY_DEDUP_THRESHOLD`), and
   P0/P1 caps with overflow demotion (`enforce_priority_caps`). Separately it removes
   the `--meeting-id` filter from commitments mode (deletes `select_commitment_transcripts`),
   adds a `--full-ledger` flag + `skipped_ledger` counter to full mode, and drops the
   `is_newer_than_watermark` guard so the watermark now always advances.

2. **`sync_meetings_to_cxportal.py`** (new, 201 lines) is a standalone worker, not a
   helper called from the extractor. It reads CRM meeting markdown files from
   `crm/crm/meetings/*.md`, parses attendees + commitment checkboxes via regex, and
   POSTs each meeting + its action items to a cxportal ingest endpoint
   (`CXPORTAL_INGEST_URL`, org/secret from env). It runs on its own, independently of
   the extractor's execution path.

## Approach

"Dual write" in practice means: two separate producers write meeting/commitment data
toward cxportal from two separate sources (Fireflies-derived commitments via the
extractor's existing output path, and CRM-markdown-derived meetings via the new sync
script) rather than one function fanning out to two destinations. This should be
called out plainly rather than described as a single in-process dual-write helper,
since that's not what the code shows.
