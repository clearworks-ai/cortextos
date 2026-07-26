# Gmail push → event, replacing the comms-check poll (00-brief)

## Problem
pa `comms-check` cron polls Gmail every 15min (112 fires/24h) to surface human-to-human email to Josh. It's a POLLING WORKAROUND — burns a pa turn + context every 15min whether or not new mail exists, and adds to the fleet churn. The daemon already event-delivers internal bus/Telegram (fast-checker); Gmail is the one real external poll left.

## Goal
Event-drive Gmail: a new relevant email → surfaced to Josh in near-real-time, WITHOUT a fixed poll cron. Delete/retire comms-check's 15min cadence once live (keep a slow ~4h safety-net sweep for missed events only).

## Design options (larry + fable to pick, weigh infra cost)
1. **Gmail API watch() + Pub/Sub push** — `users.watch` subscribes the mailbox to a Google Cloud Pub/Sub topic; Google POSTs on change to a webhook (a small endpoint on an existing Railway service, e.g. gws-security). Endpoint → `cortextos bus` event → existing comms-filter/surface logic. Requires: GCP Pub/Sub topic + subscription, a public HTTPS endpoint, watch() re-registration every ≤7 days (Google caps watch TTL). Truest event-driven.
2. **history.list incremental** — store historyId; a lightweight daemon check calls `history.list(startHistoryId)` (cheap, returns only deltas) on a short cadence but only ACTS when there's a delta — no LLM turn on empty. Cuts the per-fire LLM cost even if still time-based. Lower infra, not true-push.

Prefer option 1 if the Railway endpoint + Pub/Sub are cheap to stand up (larry owns gws-security + Railway); fall back to option 2.

## Constraints
- Reuse existing comms-filter (`cortextos bus comms-filter --namespace gmail`) + event-dedup (`--source gmail:<msgid> --fire-once`) — the surfacing/dedup logic already exists and is correct; this changes only the TRIGGER from poll→push.
- Must not surface non-human/OOO/receipt mail (existing exclusion rules — incident_comms_check_nonhuman_email_leak_2026-07-25).
- Auth: SA + DWD token already used by gws (reference_gws_send_and_alias_path).
- Keep a slow safety-net sweep (~4h) for events missed during watch() gaps/re-registration.

## Verify
Send a test email to josh@ → surfaces within ~1min via push (not the 15min poll) → dedup prevents double-surface → non-human test mail correctly excluded. Then confirm comms-check 15min cadence retired, fleet cron-fire count for pa drops.
