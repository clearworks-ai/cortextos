# Deep pass: src/daemon/telegram-streamer.ts (FORK-ONLY, 276 lines — no upstream counterpart)

Analyzed: 2026-08-02 (M1 backfill — the earlier exoneration was critic spot-check only; this is the written trail). `git show upstream/main:src/daemon/telegram-streamer.ts` → does not exist.

Purpose: token-streaming Telegram output — one `sendMessage` opener, then batched `editMessageText` updates. Product feature (v9 lane), not supervision machinery.

## Live surface

Sole caller: `src/cli/bus.ts:1993-1996` (lazy `await import` inside a bus command) — it does **not** run inside the daemon loop despite living in `src/daemon/`. Companion divergence in `src/telegram/api.ts:682` is escaping-only (already ruled NEUTRAL in synthesis M8).

## Findings — all bounded, no instability class

- **Rate limiting:** edits clamped by `minEditIntervalMs` (default 1000ms, :64/:76) + token/time flush triggers (:165-188); single `flushTimer` slot (:167 guard) — no timer pileup.
- **Bounded memory:** `accumulated` head-trimmed to `MAX_TEXT_LEN = 3900` at every append (`trimIfOverflow()`, :121-124, :253-269) — no unbounded growth on long streams.
- **Concurrency:** `flushInFlight` mutex (:192-196) + re-schedule after in-flight edit (:246-249); `finalize()` spin-waits 20ms ticks for the in-flight edit before the final pass (:140-142) — bounded because `doEdit` always clears the flag in `finally` (:243).
- **Failure handling:** "message is not modified" absorbed (:225-228); final-pass parse-error retried once with `parseMode: null` (:229-239); all other errors logged and dropped — the stream degrades, never throws into the caller.
- **No secret custody:** takes an already-constructed `TelegramAPI` handle; never reads env/tokens itself.
- **Nit (non-wound):** interim edits at 1s cadence share the per-bot Telegram rate budget — same budget class M2 flags for hook-tool-result-router. Streamer use is on-demand (bus command), not per-tool-call, so it is not the M2 amplifier.

**Verdict: EXONERATED (now with a written trail).** NEUTRAL-FEATURE, bounded in memory/timers/retries, off the daemon supervision path. No convergence action — fork-only product surface explicitly out of revert scope (v9 lane).
