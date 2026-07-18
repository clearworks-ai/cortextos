# Master Plan — frank-inject-echo-fix

**Slug:** `frank-inject-echo-fix`
**Repo:** `/Users/joshweiss/code/cortextos`
**Framework:** one-big-feature (OBF)
**Date:** 2026-07-17

## Problem statement

Frank (frank2 agent) dismissed Josh's live Telegram messages as replayed history, replying "no new ask there, just your own message pasted back. Already answered above." — without answering. Confirmed from frank2 transcript at 2026-07-17T15:55:08Z. The agent read the entire injected Telegram envelope as replayed context and no-oped on a live request.

## Root cause (two contributing factors, already confirmed)

1. **History block contains the current message.** `buildRecentHistory()` (`src/telegram/logging.ts:218`) reads `logs/<agent>/inbound-messages.jsonl`. The inbound message is logged via `recordInboundTelegram()` at `src/daemon/agent-manager.ts:667` **before** `buildRecentHistory()` is called at `src/daemon/agent-manager.ts:726`. So the just-arrived message is always the newest inbound entry in the JSONL and appears inside the `[Recent conversation:]` block.

2. **The new-message body is unlabeled.** `formatTelegramTextMessage()` (`src/daemon/fast-checker.ts:440`) renders:
   `=== TELEGRAM from [USER: x] ===` → `[Recent conversation:]\n<history>` → `<body>` (the NEW message, no label) → `[Your last message: "..."]`.
   Because the history block ends with the same text as the unlabeled body, the agent perceives the whole envelope as echo → treats the live request as replay → no-ops.

## Fix approach

### A — Exclude the current message from history (`src/telegram/logging.ts`)

Add an optional fifth parameter `excludeText?: string` to `buildRecentHistory()`. When provided, drop the **single newest inbound** entry whose text matches `excludeText` (control-char-stripped + trimmed comparison on both sides, since the JSONL stores raw `msg.text` while the caller passes a `stripControlChars()`-ed body). Only inbound entries are candidates (tag entries with an `inbound` boolean); only one entry is removed (the newest match), so a legitimately repeated earlier message stays in history. If removal empties the list, return `null` (same contract as no-history). Param is optional → fully backward compatible; existing callers/tests unchanged.

Caller update: `src/daemon/agent-manager.ts:726` passes the current `text` as the new argument.

### B — Explicit NEW-MESSAGE marker (`src/daemon/fast-checker.ts`)

In `formatTelegramTextMessage()`, insert one literal label line immediately before the body:

```
[NEW MESSAGE — respond to THIS now:]
```

Rendered order becomes: header → replyCx → historyCx → **marker line** → body → lastSentCtx → reply instruction. The body's fence-safe wrapping (`wrapFenceSafe`) and slash-command handling (`isSlashCommand` unfenced path) are untouched — only a constant label line is added above the body. Marker is emitted unconditionally (with or without history) for a consistent, unmistakable envelope.

### C — Unit tests (`tests/unit/`)

1. `buildRecentHistory` excludes the current message when `excludeText` is passed (and only the newest inbound match; older duplicate survives; returns `null` when exclusion empties history).
2. `formatTelegramTextMessage` output contains `[NEW MESSAGE — respond to THIS now:]`, the marker appears **after** `[Recent conversation:]` and **before** the body, for both fenced and slash-command bodies.
3. Existing behavior unchanged with no exclude param (history identical to today; all existing tests still pass).

Full assertions and file placement: `03-specs/01-inject-echo-fix.md`.

## File list

| File | Change |
|---|---|
| `src/telegram/logging.ts` | Add `excludeText?` param + newest-inbound-match exclusion in `buildRecentHistory()` (line 218). Incidental: the doc comment directly above it (lines 204-211) is corrupted with pasted ulimit output — replaced as part of updating the docblock for the new param. |
| `src/daemon/fast-checker.ts` | Add marker line in `formatTelegramTextMessage()` return template (line 476-478). |
| `src/daemon/agent-manager.ts` | One-line caller change at line 726: pass `text` as `excludeText`. |
| `tests/unit/telegram/logging.test.ts` | New `buildRecentHistory` describe block (none exists today). |
| `tests/unit/daemon/fast-checker.test.ts` | New marker assertions in existing `formatTelegramTextMessage` describe (line 589). |

No other files. No schema, no deps, no config.

## Risk / rollback

- **Risk: dedup churn.** `checker.isDuplicate(formatted)` hashes the formatted string; the new marker changes every envelope once, so the first message after deploy can never be a false-duplicate of a pre-deploy one. Benign.
- **Risk: exclusion over-matching.** Mitigated: only the single newest inbound entry matching the exact (normalized) text is dropped; outbound entries and older duplicates are never touched.
- **Risk: text mismatch → no exclusion.** If logged text and injected body diverge beyond control-chars/whitespace, the entry is not excluded — behavior degrades to today's (message appears in history) but factor B's marker still prevents the no-op. Fail-safe by construction.
- **Rollback:** revert the single PR. `excludeText` is optional and the marker is a constant string — no state, no migration, no persisted format change.

## Test plan

1. `npm run build` — strict TS compiles clean (no `any`, no `console.log`).
2. `npm test` — full suite green, including the 5 existing `formatTelegramTextMessage` tests unchanged.
3. New tests per section C prove both factors fixed and backward compat preserved.

## Acceptance criteria

- Injected Telegram envelope for a new text message never shows the current message inside `[Recent conversation:]`.
- Envelope always contains `[NEW MESSAGE — respond to THIS now:]` immediately before the body.
- No behavior change for callers that omit `excludeText`.
- Minimal diff; unrelated code untouched.
