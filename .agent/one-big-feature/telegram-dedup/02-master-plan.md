# Master Plan — Telegram send-layer content dedup

## Problem (verified, not assumed)
Agents and ephemeral workers re-surface already-handled items to Josh as duplicate Telegram messages. Live symptom: the "AIA notice" pinged Josh ~10x in one evening and was still firing every 15 minutes during diagnosis.

Root cause, diagnosed this session against live state:
- `comms-check` runs as a short-lived Haiku **worker** session. Its dedup is **prose convention** in the worker SKILL.md (Step 1 prune + Step 3 grep/append on `state/comms-surfaced.txt`).
- Empirically the worker does **not** execute that bash reliably: `frank2/state/comms-surfaced.txt` is **0 bytes**, last modified 16:58 while workers ran at 21:08 / 21:23 / 21:38. The dedup ledger is never written, so every 15-minute worker re-reads the same UNREAD email and re-surfaces it.
- Secondary flaws even when followed: 2-hour TTL re-fires lingering-unread emails; the record is appended **after** the Telegram send (lost if the worker dies first); relative path depends on CWD.

**Conclusion:** any fix that depends on worker discipline will keep failing. The fix must live at a chokepoint the worker cannot bypass.

## Approach
Add **content-hash dedup at the `cortextos bus send-telegram` layer** — the single command every agent and worker shells through to message Josh. A byte-identical (whitespace-normalized) body sent to the same `chat_id` within a TTL window is suppressed: logged, not sent, exit 0.

Why this is the real fix:
- **Worker-proof** — enforced in the send command itself; the Haiku worker needs no memory and cannot skip it.
- **Durable + CWD-independent** — instance-global ledger at `join(ctxRoot,'state','telegram-dedup.json')` (absolute), shared by all agents/workers, so cross-agent dups are caught too.
- **Atomic check-and-record BEFORE send** — no lost-write-on-death window.
- **Window anchored to first send** (ts NOT refreshed on a duplicate hit) → at most one identical alert per window; it naturally re-surfaces once after the window expires.

## Scope
IN: text sends, and image/file sends (key on caption text). Default-ON dedup, 6h window, `--no-dedup` bypass + `--dedup-window <sec>` override.
OUT: `--streaming` sends (final body unknown at send time — skip dedup), `react-telegram`, any change to worker SKILLs or the existing comms-surfaced.txt convention (left in place, now redundant — not removed in this change).

## Shards
- `03-specs/01-telegram-dedup.md` — the helper, the bus.ts guard, and the unit test.

## Acceptance
1. `npm run build` clean, `npm test` green incl. new `tests/unit/telegram-dedup.test.ts`.
2. Live proof: invoke `send-telegram` to the same chat with an identical body twice — first "Message sent", second "Message suppressed (duplicate …)"; Telegram API hit exactly once; ledger has one entry.
3. Before/after on the real symptom: a second worker re-surfacing the same AIA body does NOT reach Josh.

## Risk + mitigation
- Suppressing a legitimately-intended identical resend → `--no-dedup` escape hatch; 6h window; only byte-identical bodies collide (distinct real messages never do).
- Ledger corruption → tolerated (treat as empty), pruned each call to bound size.
