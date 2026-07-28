# spec06b — extractor dual-write research

## Goal
Dual-write meeting extraction data produced by `ff-extractor.py` (Fireflies transcript
extractor, cortextos-side) to cxportal, alongside the existing local/knowledge-sync write
path. This is the companion to the cxportal-side ingest endpoint (meeting-intelligence
spec06a) that already accepts extracted meeting payloads.

## Current state (before this change)
- `ff-extractor.py` extracts structured meeting intelligence (attendees, action items,
  decisions, summary) from Fireflies transcripts and writes it to the existing
  cortextos-local sink only.
- No worker exists to push that same payload to cxportal's ingest endpoint, so
  meeting-intelligence data landed in cortextos but never reached cxportal's knowledge
  graph.

## Scope of this slug
1. `ff-extractor.py` — add a dual-write branch that POSTs the extracted payload to the
   cxportal ingest endpoint in addition to the existing local write, guarded so a cxportal
   failure never blocks the primary local write.
2. New `orgs/clearworksai/agents/frank2/scripts/sync_meetings_to_cxportal.py` — standalone
   sync worker that can also be run out-of-band to backfill/retry meetings that didn't
   reach cxportal via the inline dual-write (e.g. transient network failure).

## Why dual-write instead of single-path
cxportal is the durable org-memory store; cortextos-local output is consumed by frank2/
other agents synchronously. Dual-write avoids a hard dependency on cxportal's uptime for
the primary extraction path while still keeping cxportal in sync.
