# Research — frank-inject-echo-fix

## Symptom
Frank dismissed Josh's live Telegram office-hours messages as replayed history,
replying "no new ask there, just your own message pasted back. Already answered above."
without answering. Confirmed frank2 transcript 2026-07-17T15:55:08Z.

## Root cause (two factors, from source read)
1. src/telegram/logging.ts buildRecentHistory() (L218) reads logs/<agent>/inbound-messages.jsonl,
   which already contains the just-arrived message (logged before injection) — so the CURRENT
   inbound message appears inside the [Recent conversation:] block.
2. src/daemon/fast-checker.ts formatTelegramTextMessage() (L440) renders the message body with
   NO label after the [Recent conversation:] block. Body == the tail of the history block, so the
   agent reads the whole envelope as replayed context and no-ops the live request.

## Fix direction
A. Exclude the current inbound message from buildRecentHistory (optional excludeText param).
B. Label the injected body: [NEW MESSAGE — respond to THIS now:] before body.
C. Unit tests for both + no-regression when param absent.
