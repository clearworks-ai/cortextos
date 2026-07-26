# Spec 03 — §4.3 Extraction: keep the good machinery, feed it context

**Repo:** `/Users/joshweiss/code/cortextos`
**Status this run:** materialized, NOT dispatched. Depends on spec 02 (client_context must exist before this can inject it).

**Source (verbatim, Google Doc §4.3):** "Keep the Haiku casual-gate and outbound/inbound split — genuinely good, hard-won. Change: run once per new meeting (webhook-triggered), inject client_context."

## Verified live

- `frank2/scripts/ff-extractor.py` already implements the Haiku casualness gate and outbound/inbound direction split (confirmed present per research doc: "Outbound/inbound split — KEEP, already good (Chris Samron fix)" and referenced in `meeting-commitments-worker/SKILL.md` Step 3's WE-vs-THEY handling).
- Currently the extractor runs on a poll cycle against the last N transcripts (`--limit`), not once-per-new-meeting.

## Build

Two changes, both small, both explicitly framed by the Doc as "keep, don't rewrite":
1. **Trigger change**: once spec 01 (webhook) lands, extraction should run once per NEW meeting (triggered by the webhook's dedup ledger emitting a genuinely-new meeting_id), not on a recurring poll re-scanning the last 20. This is a consumer-side change to whatever calls the extractor after the webhook fires — do not modify the Haiku gate or the outbound/inbound split logic itself.
2. **Context injection**: consume spec 02's `client_context` output (already injected into `ACTION_ITEMS_PROMPT` as part of spec 02's build) — this spec's job is verifying/tuning that the injected context measurably improves extraction relevance, not re-doing the injection (injection code itself lives in spec 02).

## Explicit non-goals (verbatim from Doc §5 "what NOT to do first")

"Do not rewrite ff-extractor.py (direction-split is good)."

## Dependencies

Blocked on spec 02 (client_context) and benefits from spec 01 (webhook trigger) but can partially land independently — the context-injection half is spec 02's responsibility; this spec is really about the trigger-cadence change (poll → once-per-new-meeting), which depends on spec 01 existing.

## Test plan

- Before/after comparison: same transcript set, extraction WITH client_context vs WITHOUT — confirm item count drops and relevance (per client's actual deal stage) improves, matching Doc §5's proof bar ("<=3 relevant items instead of a flood").
- Confirm Haiku casual-gate and outbound/inbound split behavior unchanged (regression test against existing extractor test suite, if one exists — locate before writing new tests).
