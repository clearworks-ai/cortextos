# Spec 01 — Telegram send-layer content dedup

## Josh's Exact Request (verbatim)
- "rael fix please"
- "dedup"
- Context: "oh so it also has to do with the new workers we spin up to not kill franks' context" — yes; the ephemeral-worker design is the root cause, so the fix must NOT live in the worker.

## Objective
Suppress duplicate Telegram messages at the send chokepoint. When a byte-identical (whitespace-normalized) message body is sent to the same `chat_id` within a TTL window, do not call the Telegram API again — log it and exit 0.

## File 1 (NEW): `src/telegram/dedup.ts`
Export:

```ts
export function normalizeBody(body: string): string;
// trim, then collapse every run of whitespace (incl. newlines) to a single space.

export function dedupKey(chatId: string, body: string): string;
// sha256 hex of `${chatId}\n${normalizeBody(body)}` using node:crypto.

export interface DedupResult { duplicate: boolean; ageSec?: number; }

export function checkAndRecord(
  ctxRoot: string,
  chatId: string,
  body: string,
  windowSec: number,
): DedupResult;
```

`checkAndRecord` behavior:
- Ledger path: `join(ctxRoot, 'state', 'telegram-dedup.json')`. Shape: `Record<string /*key*/, number /*epoch seconds of first send*/>`.
- Read ledger; on missing/parse-error treat as `{}` (never throw).
- Prune: drop entries whose age `> Math.max(windowSec, 86400)` (bounds file size; keep at least 24h).
- Compute `key = dedupKey(chatId, body)`.
- If `key` present AND `now - ledger[key] < windowSec`: return `{ duplicate: true, ageSec: now - ledger[key] }` and do **NOT** modify the ledger (window stays anchored to the first send — at most one identical message per window).
- Else: set `ledger[key] = now`, write atomically, return `{ duplicate: false }`.
- Atomic write: use `atomicWriteSync(filePath, data)` from `src/utils/atomic.ts`. Ensure the `state` dir exists first via `ensureDir(dirname(path))` from the same module.
- `now = Math.floor(Date.now()/1000)`.

No external deps. Strict TS, no `any`, no `console.log`.

## File 2 (EDIT): `src/cli/bus.ts` — `send-telegram` action (starts line ~1052)
1. Add two options:
   - `.option('--no-dedup', 'Bypass duplicate-content suppression for this send (always deliver).')`
   - `.option('--dedup-window <seconds>', 'Suppression window in seconds (default 21600 = 6h, or env CTX_TELEGRAM_DEDUP_WINDOW_SEC).')`
   - Commander maps `--no-dedup` to `opts.dedup === false`. Treat dedup as enabled unless `opts.dedup === false`.
2. After token resolution and the `message` newline/tab normalize, and AFTER the `if (!botToken)` guard, BEFORE constructing/sending — but ONLY for the non-streaming branches (text, image, file). Skip entirely when `opts.streaming` is true.
   ```ts
   const env0 = resolveEnv();
   const dedupEnabled = opts.dedup !== false && !opts.streaming && !!env0.ctxRoot;
   if (dedupEnabled) {
     const windowSec = Number(opts.dedupWindow ?? process.env.CTX_TELEGRAM_DEDUP_WINDOW_SEC ?? 21600);
     const { duplicate, ageSec } = checkAndRecord(env0.ctxRoot!, chatId, message, windowSec);
     if (duplicate) {
       const mins = Math.round((ageSec ?? 0) / 60);
       console.log(`Message suppressed (duplicate sent ${mins}m ago, within ${Math.round(windowSec/60)}m window)`);
       // best-effort activity event so the dashboard shows suppressions
       try {
         if (env0.agentName) {
           const paths = resolvePaths(env0.agentName, env0.instanceId, env0.org);
           logEvent(paths, env0.agentName, env0.org, 'message', 'telegram_suppressed', 'info',
             JSON.stringify({ chat_id: chatId, age_sec: ageSec }));
         }
       } catch { /* non-fatal */ }
       return; // exit 0 without sending
     }
   }
   ```
   (Reuse the existing `resolveEnv` / `resolvePaths` / `logEvent` imports already used later in this same action — do not add duplicate imports beyond the new `checkAndRecord`.)
3. Import `checkAndRecord` from `'../telegram/dedup.js'` at the top with the other telegram imports.
4. Do NOT change streaming, react-telegram, image/file send mechanics other than gating the dedup check. The existing post-send `logOutboundMessage` / `cacheLastSent` / `appendToBuffer` stay exactly as they are.

Edge: image/file branches still run the dedup check (keyed on the caption `message`). If `message` is empty for a media send, `checkAndRecord` still works (key is over chatId + empty body) — acceptable; an empty-caption media resend within window is rare and suppression is harmless.

## File 3 (NEW): `tests/unit/telegram-dedup.test.ts`
Use the repo's existing unit-test harness/style (match a sibling test in `tests/unit/`). Use a temp dir as `ctxRoot`. Cover:
1. First `checkAndRecord` → `{duplicate:false}`; ledger file created with one key.
2. Identical body again within window → `{duplicate:true}` with `ageSec` defined; ledger NOT mutated (key count still 1, ts unchanged).
3. Whitespace-only difference (`'a  b'` vs `'a b'` / trailing newline) → still `duplicate:true` (normalize collision).
4. Different body → `{duplicate:false}`; ledger now has 2 keys.
5. Entry older than window (seed ledger with an old ts) → `{duplicate:false}` again (re-anchors).
6. Corrupt ledger file (`'{not json'`) → treated as empty, `{duplicate:false}`, no throw.
7. `dedupKey` is stable and differs by chatId.

## Constraints
- TS strict, no `any`, no `console.log` in committed code except the intentional user-facing `console.log('Message suppressed …')` in the CLI action (CLI user output, mirrors existing `console.log('Message sent')`).
- No new runtime dependencies.
- Atomic writes via `src/utils/atomic.ts`.

## Acceptance
- `npm run build` clean; `npm test` green incl. the new test file.
- Diff limited to the 3 files above.
- Return the full diff + a scope-validation note (files touched, lines, confiricts) to Larry. Do NOT commit or push.
