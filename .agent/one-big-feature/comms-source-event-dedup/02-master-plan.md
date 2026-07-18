# OBF Master Plan — comms-source-event-dedup

**Slug:** `comms-source-event-dedup`
**Repo:** `/Users/joshweiss/code/cortextos`
**Task:** task_1784283774794_27005073 (larry)
**Scope source:** `.agent/one-big-feature/comms-source-event-dedup/00-scope-findings.md` (grounded 2026-07-17)

---

## 1. Problem statement

LLM worker sessions (Automator, frank2/pa comms workers) compose the SAME meeting reminder
N times with different wording and each composition passes the send-path dedup, so Josh's
PA Telegram channel gets N pings for one meeting (observed: 4 reworded ERatePros/Dean Wilcox
reminders at 8:43/8:58/9:13/10:44 PM; also the James Goldbach thread).

## 2. Root cause (verified in source)

- The only dedup on the general send path is a **byte-hash**:
  `src/cli/bus.ts:1524-1544` calls `checkAndRecord(env.ctxRoot!, chatId, message, windowSec)`
  (imported from `src/telegram/dedup.ts` at `src/cli/bus.ts:36`). Key = hash of
  `chatId + message` bytes → any rewording produces a new hash → no suppression (#33 layer).
- A **source-event identity dedup helper already exists and is proven**:
  `src/utils/event-dedup.ts:91-131` `checkAndRecordSourceEvent(ctxRoot, source, {fireOnce, ttlSec})`,
  key validation `isValidSourceKey` (`event-dedup.ts:24-26`, pattern at line 22:
  `/^[a-z0-9_-]{1,32}:[A-Za-z0-9_/+=@.<>-]{1,512}$/`), ledger at
  `<ctxRoot>/state/comms-event-dedup.json` (`event-dedup.ts:106`), return shape
  `{ surface, reason: 'first-seen'|'duplicate'|'duplicate-fire-once'|'invalid-key'|'no-ctx-root', ageSec? }`.
- The helper is wired to **specific gate commands** only: `ci-alert-gate` (`bus.ts:3000`),
  `event-dedup` (`bus.ts:3033`), `comms-filter` (`bus.ts:3100`), and `meeting-alert-gate`
  (`bus.ts:3060` via `src/utils/meeting-alert-gate.ts:69`). It is **NOT wired to the send
  choke point** (`send-telegram` / `send-message`), so any worker that composes a message
  and calls send directly — without voluntarily running a gate command first — bypasses
  identity dedup entirely. The pa `comms-check-worker` Step 4c gate (PR #109) is an
  honor-system prompt instruction, not enforcement; frank2's copy of that worker skill is
  an older revision **without** Step 4c at all, and Automator has no gate instruction.

## 3. Design — layered dedup at the send choke point

**Layer 1 (new, primary): source-event identity.** `send-telegram` and `send-message` gain
an optional `--source-key <key>` (+ `--source-ttl-sec <n>`). When present and valid, the
send path calls `checkAndRecordSourceEvent(env.ctxRoot, key, { ttlSec })` BEFORE the
byte-hash block. `surface:false` → suppress: log `telegram_suppressed` (resp.
`agent_message_suppressed`), print a suppression line, `return` with exit 0 — exactly the
byte-hash suppression contract at `bus.ts:1530-1542`.

**Layer 2 (kept, fallback): byte-hash.** The existing `checkAndRecord` block
(`bus.ts:1524-1544`) is untouched and still runs when no source-key is passed (or the key
is invalid → fail-open warn + fall through, mirroring the `event-dedup` command's warn
idiom at `bus.ts:3030-3032`). `--no-dedup` bypasses BOTH layers (its documented contract
is "always deliver").

**Rollback parity.** The byte-hash record is rolled back on claim-gate hold
(`bus.ts:1604-1610`) and on send failure (`bus.ts:1727-1733`) via `removeRecord`. The
source-event record needs the same, or a failed send burns the key for the whole TTL and
permanently eats a legit reminder. Add `removeSourceEventRecord(ctxRoot, source)` to
`src/utils/event-dedup.ts` and call it at both rollback sites, but ONLY when this
invocation was the first-seen recorder (`reason === 'first-seen'`) — never delete an entry
recorded by an earlier successful send.

**Emitters pass identity, not wording.** Workers derive the key from the SOURCE identity —
`automator:meeting-<eventId>`, `pa:meeting-<eventId>`, `<agent>:thread-<gmailThreadId>` —
mirroring `deriveMeetingKey` in `src/utils/meeting-alert-gate.ts:35-53` (eventId preferred;
fallback normalized-subject + meeting-date). Same source event collapses regardless of
rewording; the namespace prefix is the sending agent (or a stable domain like `meeting:`),
which already satisfies `SOURCE_KEY_PATTERN`.

## 4. TTL decision: `43200` s (12 h), NOT fire-once

- **Why not fire-once:** recurring calendar events can share a base event id across
  instances (Google recurring-event ids), and meetings get rescheduled. `fireOnce` entries
  persist ~365 d in the ledger (`event-dedup.ts:20`, `FIRE_ONCE_PRUNE_SEC`) — one ping
  would suppress every future instance of a weekly meeting. Fire-once is reserved for
  truly one-shot events (calendar accepts, zcal confirms — already handled in
  `comms-check-worker` Step 2).
- **Why 12 h:** the observed dupe storm spans ~2 h of worker cycles; 12 h covers a full
  working day of re-checks with margin. A genuinely new instance (tomorrow's or next
  week's meeting) surfaces again — and when the key embeds the date (subject+date
  fallback, per `deriveMeetingKey`), even a long TTL is safe. 12 h is deliberately shorter
  than `DEFAULT_MEETING_TTL_SEC` (7 d, `meeting-alert-gate.ts:15`) because the send-path
  key may fall back to a base event id without a date component.
- **CLI default when `--source-ttl-sec` is omitted:** the helper's own default (30 d,
  `event-dedup.ts:18`) — identical to the `event-dedup` command's behavior (`bus.ts:3033`).
  Workers pass `--source-ttl-sec 43200` explicitly for meeting reminders.

## 5. File-by-file change list

| # | File | Change | Anchors |
|---|------|--------|---------|
| 1 | `src/utils/event-dedup.ts` | Add exported `removeSourceEventRecord(ctxRoot, source): void` (read ledger, delete key if present, atomic write). No changes to existing exports. | append after `checkAndRecordSourceEvent` (line 131); reuse `readLedger` (41) / `writeLedger` (86) |
| 2 | `src/cli/bus.ts` — `send-telegram` | Add `--source-key <key>` + `--source-ttl-sec <n>` options; insert source-event check between BOT_TOKEN resolution and the byte-hash block; wire rollback at both existing rollback sites. | options 1486-1492; action sig 1493; insert before 1524; rollbacks 1604-1610 and 1727-1733 |
| 3 | `src/cli/bus.ts` — `send-message` | Add same two options; check before `sendMessage(...)`; on suppress log `agent_message_suppressed` + return 0. No rollback needed (sendMessage is synchronous local file write; on throw at 262-265 remove first-seen record best-effort). | command 212-270; insert before 259; sendMessage call 261 |
| 4 | `community/skills/comms/SKILL.md` (git-TRACKED template) | Document `--source-key` for proactive/event-driven pings (meeting reminders, thread alerts): derive key from event identity, pass `--source-ttl-sec 43200`. | send-telegram usage line 17 |
| 5 | Agent-local worker skills (git-IGNORED, Larry edits directly, NOT codexer): `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md` (Step 4c lines 143-177, Step 5 meeting bullet 190-192), `orgs/clearworksai/agents/frank2/.claude/skills/comms-check-worker/SKILL.md` (older rev, NO Step 4c — bring to parity), automator + pa `comms` skills | Instruct: every meeting/thread ping MUST pass `--source-key` on the send itself (choke-point enforcement; the Step 4c gate stays as belt-and-suspenders). | see 03-specs/02 |
| 6 | Tests | Extend `tests/unit/utils/event-dedup.test.ts` (removeSourceEventRecord); new `tests/unit/cli/send-telegram-source-key.test.ts` following the full-command idiom of `tests/unit/cli/send-telegram-normalize.test.ts` (mock `TelegramAPI`, drive `busCommand`). | see 03-specs/03 |

## 6. Risk / rollback

- **Risk: legit message suppressed.** Mitigations: opt-in flag (no behavior change unless
  `--source-key` passed); invalid key fails OPEN (helper returns `surface:true,
  reason:'invalid-key'`); `--no-dedup` escape hatch; rollback on claim-gate hold / send
  failure; TTL-bounded (12 h worker default).
- **Risk: shared ledger cross-talk.** `state/comms-event-dedup.json` is shared with the
  gate commands. Keys are namespaced (`automator:…`, `pa:…`, `meeting:…`) so collisions
  require identical keys — which is the desired collapse. Spec documents: use distinct
  keys if the same event legitimately needs two deliveries on two channels.
- **Risk: streaming interplay.** Byte-hash dedup already skips `--streaming`
  (`bus.ts:1525`); source-key does the same (warn + ignore if combined).
- **Rollback plan:** revert the PR — flag is additive; no schema change; ledger file is
  forward/backward compatible (unknown keys just age out via prune, `event-dedup.ts:71-84`).
- **Gates:** no push to main without Josh approval; codexer touches only `src/*.ts` +
  `tests/*`; Larry writes the `.md` skill files (hook: codexer owns `.ts`, Larry owns docs).

## 7. Ordered task list

1. **T1** — `src/utils/event-dedup.ts`: add `removeSourceEventRecord`. (codexer)
2. **T2** — `src/cli/bus.ts` `send-telegram`: options + pre-byte-hash source-event check +
   both rollback sites. Spec: `03-specs/01-bus-send-source-key.md`. (codexer)
3. **T3** — `src/cli/bus.ts` `send-message`: options + pre-send check + throw-path
   best-effort rollback. Spec: `03-specs/01-bus-send-source-key.md` §5. (codexer)
4. **T4** — tests per `03-specs/03-tests.md`; `npm run build` + `npm test` green. (codexer)
5. **T5** — `community/skills/comms/SKILL.md` template guidance. (codexer or Larry — .md)
6. **T6** — agent-local worker SKILL.md updates (pa + frank2 comms-check-worker, automator/pa
   comms). Spec: `03-specs/02-worker-source-key.md`. (Larry directly — git-ignored files)
7. **T7** — proof replay per acceptance tests (ERatePros ×4 → 1; Goldbach thread → 1/event;
   new meeting → surfaces; no-source-key byte-hash regression). (Larry, adversarial review)
