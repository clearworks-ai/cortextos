# 01 — Research: comms meeting-notification dedup

**Slug:** comms-meeting-dedup
**Repo:** /Users/joshweiss/code/cortextos
**Owner:** larry
**Task:** task_1782975510530_74147799 (pending since 2026-07-02; fresh user-visible proof 2026-07-16)
**Date:** 2026-07-16

## Problem (Josh, with screenshot)
4 separate reworded Telegram messages about the SAME meeting (E-Rate / Scholarship Prep, Dean Wilcox, ERatePros, Thu 2026-07-16 10:00 AM PST), posted under "Automator" over ~2h:
- 8:43 PM — "Meeting reminder: E-Rate for Scholarship Prep meeting tomorrow ... Teams link in email ..."
- 8:58 PM — "Meeting tomorrow (Thu Jul 16) at 10:00 AM PST: E-Rate for Scholarship Prep ..."
- 9:13 PM — "E-Rate meeting tomorrow (Thursday 10:00 AM PST) ... Confirmed on calendar."
- 10:44 PM — "EratePros meeting platform decided: Teams ... Meeting link: ..."

Actual sent text confirmed in `~/.cortextos/cortextos1/state/comms-check-<id>/last-telegram-6690120787.txt` for ids 1784160708, 1784173345, 1784174245, 1784175145 — matches screenshot verbatim.

## Root cause (confirmed from source)
The emitter is the **comms-check-worker** (spawned worker sessions, ~15min cadence via PA cron). Its dedup keys on **inbound Gmail message id**:
- `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md` — Step 2 pipes Gmail through `cortextos bus comms-filter` (keys on `gmail:<MSG_ID>` source-event identity); Step for calendar noise uses `cortextos bus event-dedup --source "gmail:${MSG_ID}" --fire-once`.
- **One meeting generates MANY distinct inbound emails over time** (scheduling → platform question → confirmation → Teams-link). Each is a different `gmail:MSG_ID`, so each is "un-surfaced" → the worker reasons about it → sends a fresh meeting notification, LLM-reworded each time.
- Byte-hash dedup (`src/telegram/dedup.ts:54` `checkAndRecord`, applied unconditionally in `src/cli/bus.ts:1515` send-telegram) keys on `SHA256(chatId + normalizedBody)` — reworded text = different hash, so it does NOT collapse the 4.
- Source-event dedup util (`src/utils/event-dedup.ts` `checkAndRecordSourceEvent`, ledger `state/comms-event-dedup.json`) exists but is keyed on the EMAIL id, so 4 emails = 4 distinct keys.

Net: dedup identity is **email**, but the thing to dedup is the **meeting**. Wrong grain.

## Fix direction (frank2-confirmed: dedup on source-event = sender+meeting-id, not wording hash)
Introduce a **meeting-identity fire-once** for meeting-notification-class messages in comms-check-worker:
- Key = `meeting:<calendarEventId>`; fallback `meeting:<normalizedSubject>+<localDate>` when no event id (LLM-derived meeting notices from email may lack a calendar id).
- Reuse existing `cortextos bus event-dedup --source "meeting:<key>" --fire-once` + `state/comms-event-dedup.json` ledger. Same pattern as `ci-alert-gate` (PR #106, `src/utils/ci-alert-gate.ts`) which folds identity + per-run dedup into one deterministic surface/skip call.
- Semantics: first email about a meeting → notify once. Subsequent emails about the SAME meeting within window → suppress (or, stretch goal, edit-in-place; MVP = suppress).

## Prior art / reuse
- `src/utils/event-dedup.ts` — fire-once source-event ledger (PR #46). Reuse directly.
- `src/utils/ci-alert-gate.ts` — deterministic surface/skip on stable id (PR #106). Pattern to mirror for a `meeting-notification-gate`.
- comms-check-worker already calls `event-dedup --fire-once` for calendar accepts — extend the same discipline to meeting reminders keyed on meeting id.

## NOT this bug (disambiguation)
- PR #108 (merged 2026-07-16 05:52Z, commit 9ecaebc) gated the daemon "back —" onlineMessage back-pings — a DIFFERENT emitter (agent restart pings). It does not touch comms-check meeting notifications and is not yet live (daemon last restarted Mon).

## Open decision (blocks plan stage)
- Plan engine: **Fable 5 HIGH vs Opus** — surfaced to Josh 2026-07-16 06:05Z, awaiting answer. Plan stage does not run until answered (memory: plan-engine choice GATE-enforced).

## Scope guard
- Single-repo, single-subsystem (comms-check-worker + a small dedup helper). One-big-feature, NOT full M2C1 (no schema migration, no multi-repo, no net-new subsystem).
- Must include: unit test for meeting-identity dedup (first-surface + suppress-on-rewording-same-meeting), and confirmation that distinct meetings still each surface once.
