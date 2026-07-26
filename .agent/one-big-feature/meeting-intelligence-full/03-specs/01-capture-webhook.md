# Spec 01 — §4.1 Capture: turn on the webhook you already built

**Repo:** `/Users/joshweiss/code/briefs` (NOT cortextos — flag for cross-repo GATE dispatch, see master plan)
**Status this run:** materialized, NOT dispatched.

**Source (verbatim, Google Doc §4.1):** "Stop polling. Use briefs.ts:2551 /api/fireflies/webhook/:id. Set firefliesWebhookPathId + firefliesWebhookSecret (already read at :169-173), register the URL in Fireflies. Deterministic dedup ledger (zero LLM): a meeting_id seen-set. New id -> proceed; seen -> no-op. Collapse the two pollers into one path — one extractor, one suppression list, one destination."

## Verified live (2026-07-26)

- `src/briefs.ts:2551` — route `/api/fireflies/webhook/:id` exists.
- `src/briefs.ts:169,172` — `firefliesWebhookSecret` / `firefliesWebhookPathId` already read from config.
- `src/server.ts:34,37` — `env.FIREFLIES_WEBHOOK_SECRET` / `env.FIREFLIES_WEBHOOK_PATH_ID` already wired into config.
- Per research doc: "Fireflies webhook | `~/code/briefs` PR#24 | deployed | Unwired from delivery path. Input dependency only — do NOT re-plan; cron polling is the live trigger today."

So the route + config plumbing already exist and are deployed (PR #24) — this piece is registration + a dedup ledger + collapsing the two existing pollers (`frank2/scripts/ff-extractor.py:373` polling loop, `crm/fireflies-ingest.py`), not new endpoint code.

## Build (for the briefs repo, once dispatched)

1. Confirm `FIREFLIES_WEBHOOK_SECRET` / `FIREFLIES_WEBHOOK_PATH_ID` are set in the briefs deploy env (Railway) — if not, generate + set.
2. Register the webhook URL in the Fireflies account settings (external, manual — Fireflies has no API for this, confirm via their dashboard).
3. Add the meeting_id seen-set ledger inside the webhook handler (zero LLM, deterministic — new id proceeds, seen id no-ops), same shape as `event-dedup`'s `checkAndRecordSourceEvent` pattern already used elsewhere in this codebase (`src/utils/event-dedup.ts` in cortextos — port the pattern, this repo is separate so it needs its own small ledger util or a shared package if one exists).
4. Once the webhook is live and proven (a real Fireflies meeting completes and the webhook fires), collapse the two pollers: retire `crm/fireflies-ingest.py`'s independent polling cron AND `frank2/ff-extractor.py`'s polling entry point, routing both downstream consumers (crm's flat-file writer, frank2's commitments/writeback flow) off the ONE webhook-triggered event instead of two independent 2h polls.

## Out of scope for this spec

- The consolidation of the two pollers' DOWNSTREAM logic (crm's `add-interaction.py`/`add-followup.py` vs frank2's extractor) is not itself part of 4.1 — 4.1 is capture-layer only. Downstream consolidation, if needed, is a separate follow-up.
- Do not build this before spec 02 (context layer) per the Doc's own §5 "smallest first build" ordering — captured in master plan sequencing.

## Test plan (once dispatched)

- Simulate a webhook POST with a known meeting_id twice — first call proceeds (ledger miss), second call no-ops (ledger hit), zero LLM calls on either path for the dedup check itself.
- Live proof: one real Fireflies meeting completes, webhook fires, downstream pipeline picks it up without either poller having touched it.
