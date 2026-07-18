# Comms source-event dedup — scope + grounded findings

**Task:** task_1784283774794_27005073 (larry) — redispatch of task_1782975510530_74147799 (frank2 held 2wk, no-direct-eng block).
**Origin:** Josh screenshot — Automator posted 4 reworded messages about the SAME ERatePros/Dean Wilcox meeting reminder to PA channel over ~2h (8:43/8:58/9:13/10:44 PM). Also James Goldbach thread. Same root cause across emitters (Automator, frank2).

## Root cause (grounded, 2026-07-17)
- #33 dedup = byte-hash `sha256(chatId+body)`. Reworded LLM prose = different bytes = bypasses it. Confirmed byte-hash sites: `src/bus/meeting-brief.ts`, `src/daemon/context-handoff-lease.ts`, `src/daemon/fast-checker.ts`.
- A **source-event dedup helper ALREADY EXISTS**: `src/utils/event-dedup.ts` → `checkAndRecordSourceEvent(ctxRoot, source, {fireOnce, ttlSec})`. Ledger at `state/comms-event-dedup.json`. Key pattern `SOURCE_KEY_PATTERN = /^[a-z0-9_-]{1,32}:[A-Za-z0-9_/+=@.<>-]{1,512}$/`. Returns surface:false on `duplicate`/`duplicate-fire-once`.
- Current callers of the helper: `src/utils/meeting-alert-gate.ts`, `src/cli/bus.ts` (partial), `src/utils/event-dedup.ts`. So wiring exists for meeting-alerts but NOT for the general agent-composed ping path.

## The real gap
The reworded dupes come from LLM AGENTS (Automator/frank2 workers) composing a meeting-reminder and calling send (`send-telegram`/`send-message` to PA channel) N times. The send path only byte-hashes. Fix = gate agent-composed comms on a **stable source key = sender + source-item id** (e.g. `automator:meeting-<meetingId>`), NOT the generated wording.

## Fix surface (to spec)
1. Add `--source-key <key>` (optional) to the send path in `src/cli/bus.ts` (send-telegram / send-message-to-channel). When present, call `checkAndRecordSourceEvent(ctxRoot, key, {ttlSec})` BEFORE dispatch; drop if `surface:false`. Keep byte-hash #33 as the fallback layer.
2. Make the comms-check / meeting-reminder worker (the skill that emits these) always compute + pass a deterministic source key from the meeting/thread identity (meetingId or gmail threadId + sender), so the same source-event collapses regardless of wording.
3. TTL: meeting reminders → a sane window (e.g. per-meeting fire-once or 6–12h) so a genuinely NEW event still surfaces.

## Proof required (verify-outcome, not render)
- Replay the ERatePros/Dean Wilcox sequence (4 reworded bodies, same meetingId) → exactly ONE surfaces.
- Replay James Goldbach thread → one ping per source-event.
- A genuinely different meeting/thread → still surfaces.

## Gate status
- Build-class. one-big-feature. PLAN-ENGINE CHOICE (Fable HIGH vs Opus) MANDATORY before codexer dispatch — NOT yet answered by Josh. Do NOT dispatch codexer until Josh picks. No push without Josh merge approval.
- Next session: read this file, get Josh's plan-engine answer, then run OBF plan → 03-specs → codexer under `GATE: build framework=one-big-feature slug=comms-source-event-dedup repo=/Users/joshweiss/code/cortextos`.
