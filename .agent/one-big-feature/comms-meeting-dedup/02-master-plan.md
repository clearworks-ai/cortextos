# 02 — Master Plan: comms meeting-notification dedup

**Slug:** comms-meeting-dedup
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature
**Plan engine:** Fable 5 HIGH
**Grounded in:** `.agent/one-big-feature/comms-meeting-dedup/01-research.md`

## Goal

One Telegram notification per meeting, deterministically enforced. Four differently-worded
emails about the same Thu-10am meeting must produce exactly ONE meeting-reminder ping;
two genuinely distinct meetings must still each surface once.

## Root cause (from 01-research.md, confirmed)

The comms-check-worker's dedup identity is the inbound **email** (`gmail:<MSG_ID>` via
`comms-filter` / `event-dedup`), but one meeting generates many distinct emails over its
scheduling lifecycle (schedule → platform question → confirmation → Teams link). Each email
is first-seen, so the worker legitimately reasons about it and emits a fresh, LLM-reworded
meeting reminder. Byte-hash dedup (`src/telegram/dedup.ts:54`, applied in `src/cli/bus.ts`
send-telegram) keys on normalized body text, so reworded text also passes. Wrong grain:
dedup keys on the email; the thing to dedup is the meeting.

## Approach

Mirror the `ci-alert-gate` pattern (PR #106, `src/utils/ci-alert-gate.ts` +
`src/cli/bus.ts` `ci-alert-gate` command at :3829): a deterministic, testable pure-logic
util + a thin bus command that folds identity derivation and record-and-fire-once into one
call, backed by the EXISTING event-dedup ledger (`src/utils/event-dedup.ts:91-131`
`checkAndRecordSourceEvent`, ledger `state/comms-event-dedup.json`). No new store.

1. **New util `src/utils/meeting-alert-gate.ts`** — derives a stable meeting key
   (`meeting:evt-<calendarEventId>` preferred; fallback
   `meeting:subj-<normalizedSubject>-<YYYY-MM-DD>`), checks-and-records it against the
   event-dedup ledger with a TTL window (default 7 days), returns
   `{ surface, reason, key }`. Fail-open (surface:true) when no key is derivable —
   better a duplicate ping than a dropped meeting notice (matches event-dedup's
   invalid-key fail-open at `src/utils/event-dedup.ts:100-102`).
2. **New bus command `cortextos bus meeting-alert-gate`** in `src/cli/bus.ts` —
   `--event-id` / `--subject` + `--date` / `--ttl-sec` / `--json`, printing
   `{"surface":true|false,"reason":"...","key":...}` with `--json`, else `SURFACE`/`SKIP`.
   Inserted directly after the existing `event-dedup` command block (which starts at
   `src/cli/bus.ts:3855`), before the `comms-filter` command (at :3916); the new
   `meeting-alert-gate` command begins at :3884.
3. **Wire the emitter** — edit
   `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md`: new
   mandatory "Step 4c — Meeting-notification gate" (SKILL.md:174, after Step 4b at
   SKILL.md:160) requiring the gate call BEFORE any meeting-class Telegram, plus a
   matching bullet in Step 5's result handling (SKILL.md:211+). Key derivation: calendar
   eventId when the notice came from/maps to a calendar event; else normalized subject +
   the MEETING's local date (not the email's date).

Deterministic normalization (in the util, not the LLM): lowercase → strip `re:`/`fwd:`/`fw:`
prefixes → drop every char outside `[a-z0-9]` → truncate (100 chars). So "E-Rate for
Scholarship Prep meeting tomorrow", "Re: E-rate for scholarship prep!" collapse to one
token; the date suffix keeps distinct occurrences distinct.

## Files to touch (codexer)

| File | Change |
|------|--------|
| `src/utils/meeting-alert-gate.ts` | NEW — `normalizeMeetingSubject`, `deriveMeetingKey`, `evaluateMeetingAlert`, `DEFAULT_MEETING_TTL_SEC` (spec 03-specs/01) |
| `src/cli/bus.ts` | NEW `meeting-alert-gate` command after the `event-dedup` block (command begins at line 3884); add import `evaluateMeetingAlert` next to existing dedup imports (`ci-alert-gate` :67, `event-dedup` :68, `meeting-alert-gate` :69) (spec 03-specs/01) |
| `tests/unit/utils/meeting-alert-gate.test.ts` | NEW — vitest, mirrors `tests/unit/utils/ci-alert-gate.test.ts` structure (mkdtempSync ctxRoot + real `checkAndRecordSourceEvent`) (spec 03-specs/01) |
| `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md` | New Step 4c (SKILL.md:174) + Step 5 bullet wiring the gate (spec 03-specs/02) |

## Test plan

- Unit (vitest, `npm test`): key-derivation table tests + ledger-behavior tests —
  first-surface=true; second-same-meeting=false even when reworded (same eventId; and
  same subject modulo case/punctuation/re:-prefix + same date); two distinct meetings
  both=true (different eventIds; different subjects same date; same subject different
  dates); no-eventId fallback path; no-derivable-key fail-open; TTL expiry re-surfaces.
- CLI smoke: `node dist/cli.js bus meeting-alert-gate --subject "E-Rate for Scholarship Prep" --date 2026-07-16 --json` twice → first `"surface":true`, second `"surface":false`.
- `npm run build` clean (TS strict), `npm test` green.
- Live proof after merge: replay the 4-email incident shape (4 gate calls with the
  incident's subjects/eventId) → exactly 1 surface.

## Risks

- **Over-collapse:** a recurring calendar event whose base eventId repeats across
  instances could suppress next week's reminder if TTL were long → default TTL 7d keeps
  suppression scoped to one scheduling cycle; date suffix on the fallback key already
  scopes by day. `--ttl-sec` overridable.
- **Under-collapse (residual):** an email in a DIFFERENT thread with an unrelated subject
  about the same meeting (e.g. "EratePros meeting platform decided") won't collapse via
  subject fallback — mitigated by instructing the worker to prefer the calendar eventId
  and to pass the meeting TITLE + meeting date (not raw email subject) when it knows them.
  Accept: worst case is one extra ping, never zero pings.
- **LLM discipline:** the worker is prompt-driven; the gate is a hard bash call with a
  machine-checkable JSON answer, same enforcement shape already proven for GATE D
  (ci-alert-gate, SKILL.md:123-129).

## Out of scope

- No schema migration, no new store, no multi-repo (reuse `state/comms-event-dedup.json`).
- No edit-in-place / message-update UX (research's stretch goal; MVP = suppress).
- No changes to `comms-filter`, `event-dedup`, `ci-alert-gate`, or `src/telegram/dedup.ts`.
- No daemon back-ping paths (that was PR #108, a different emitter).

## Plan sign-off

Validated against the actual implementation on branch `feat/comms-meeting-dedup` (commit
`d3b1825`, PR #109 — since merged to main). Design, function names, file set, TTL default
(7d), fail-open behavior, JSON output shape (`{surface,reason,key}`), and out-of-scope
items all match the built code; only stale line-number references were corrected (bus.ts
import 67-69 and command at :3884/:3916; ci-alert-gate at :3829; SKILL.md Steps 4b/4c at
:160/:174; GATE D at :123-129).
