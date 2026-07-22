# Research — comms-source-dedup-enforce

## Problem (Josh, 2026-07-21 ~22:17 PT, w/ screenshots)
Automator-bot Telegram chat blows up with duplicate email notifications. Proof: ONE Gmail
email (Dr. Bob Newport — "Hermes Stuckness.20260721.docx" OneDrive share) surfaced 3x, each
REWORDED:
- 8:46 PM "Email from Dr. Bob Newport: shared OneDrive doc 'Hermes Stuckness. 20260721.docx'"
- 10:01 PM "Dr. Bob Newport shared: Hermes Stuckness (OneDrive doc). Link:…"
- 10:16 PM "Dr. Bob Newport shared: Hermes Stuckness.20260721.docx"
Josh: source-dedup was asked for ~5x, sent to Fable, reported built — still firing.

## Dedup layers that EXIST (grounded, src/ of cortextos)
1. `src/telegram/dedup.ts` — `dedupKey = sha256(chatId + normalizeBody(body))`. BYTE/TEXT hash.
   normalizeBody only trims whitespace → any rewording = new hash = passes. Dumb layer.
2. `src/utils/event-dedup.ts` — `checkAndRecordSourceEvent(ctxRoot, source, {fireOnce})`,
   `isValidSourceKey` (pattern `<ns:1-32>:<id>`). SOURCE-EVENT layer, 30d TTL. THE RIGHT LAYER.
3. `src/utils/meeting-alert-gate.ts` — meeting-specific gate (imports checkAndRecordSourceEvent).

## The chokepoint that EXISTS and works
`src/cli/bus.ts` `comms-filter` command (~line 3178): reads comms JSON on stdin, for each email
keys `gmail:<id|messageId>`, runs `checkAndRecordSourceEvent`, emits ONLY first-seen. Shipped
PR #97 (2026-07-12, slug comms-dedup-pipe).
Also: `bus send-telegram`/`send-message` accept `--source-key <ns>:<id>` + `--source-ttl-sec`
(bus.ts ~1550) which gate the send on first-sight BEFORE byte-hash. Invalid key = fail-open to byte-hash.

## WHO uses it vs who leaks
- frank2 + pa: `comms-check-worker` SKILL pipes Gmail through `cortextos bus comms-filter --namespace gmail`
  (AP invoices + Josh inbox). SKILL.md lines 64-70: "the real protection layer … only first-seen …
  regardless of rewording." CORRECT.
- AUTOMATOR: has a `comms` skill (42 lines) NOT `comms-check-worker`. It sends via raw
  `send-telegram` (line 16/33) with NO comms-filter, NO --source-key, NO message-id. → LEAK.
  Automator surfaces email through a path that never touches the source-event ledger.

## Root cause (one sentence)
Source-dedup is OPT-IN (emitter must pipe comms-filter or pass --source-key); automator's comms
surfacing opts out, so its emails hit byte-hash-only and every rewording sends.

## Open item to confirm at build time
Pin the EXACT automator instruction/skill that emits "Email from X" surfacings (the 42-line
`comms` skill is about replying to Telegram; the email-surface duty may live in automator SYSTEM.md
/ heartbeat / a cron prompt). automator has only 1 cron (heartbeat, last fire 07-20) so the
tonight sends came from a live/other trigger — confirm the emitter file before editing.
