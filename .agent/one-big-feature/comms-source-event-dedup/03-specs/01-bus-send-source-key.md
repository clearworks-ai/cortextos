# Spec 01 — `--source-key` on the send path (`src/cli/bus.ts` + `src/utils/event-dedup.ts`)

All line numbers verified against working tree 2026-07-17 (branch `fix/fleet-bus-daemon-bugfixes`).
Implementer: codexer. TypeScript strict, no `any` in NEW code (`err: any` at `bus.ts:1726` is
pre-existing — do not touch), match surrounding console-logging style.

---

## 1. `src/utils/event-dedup.ts` — add `removeSourceEventRecord`

Append after `checkAndRecordSourceEvent` (current end of file, line 131):

```ts
export function removeSourceEventRecord(ctxRoot: string, source: string): void {
  if (!ctxRoot || !isValidSourceKey(source)) {
    return;
  }
  const ledgerPath = join(ctxRoot, 'state', 'comms-event-dedup.json');
  const ledger = readLedger(ledgerPath);
  if (ledger[source] === undefined) {
    return;
  }
  delete ledger[source];
  writeLedger(ledgerPath, ledger);
}
```

Reuses existing private `readLedger` (line 41) and `writeLedger` (line 86) — no new imports.
Best-effort semantics: missing file / missing key = silent no-op.

## 2. `src/cli/bus.ts` — import

Line 41 currently:
```ts
import { checkAndRecordSourceEvent, isValidSourceKey } from '../utils/event-dedup.js';
```
Change to also import `removeSourceEventRecord`:
```ts
import { checkAndRecordSourceEvent, isValidSourceKey, removeSourceEventRecord } from '../utils/event-dedup.js';
```

## 3. `send-telegram` command (starts `bus.ts:1481`)

### 3a. Options (insert after the `--dedup-window` option, line 1490)

```ts
.option('--source-key <key>', 'Source-event identity key (<namespace>:<id>, e.g. automator:meeting-<eventId>). When set, the send is gated on first-sight of this SOURCE EVENT via the comms-event-dedup ledger — reworded duplicates of the same event are suppressed BEFORE the byte-hash layer. Invalid keys warn and fall through to byte-hash dedup (fail-open). Ignored with --streaming; bypassed by --no-dedup.')
.option('--source-ttl-sec <n>', 'Re-surface window in seconds for --source-key (default 2592000 = 30d, same as `bus event-dedup`). Meeting-reminder workers should pass 43200 (12h).')
```

### 3b. Action signature (line 1493)

Extend the opts type with `sourceKey?: string; sourceTtlSec?: string`:
```ts
.action(async (chatId: string, message: string, opts: { dedup?: boolean; dedupWindow?: string; image?: string; file?: string; plainText?: boolean; streaming?: boolean; confirmClaim?: boolean; sourceKey?: string; sourceTtlSec?: string }) => {
```

### 3c. Source-event check — INSERT between line 1523 (blank line after the
`if (!botToken) { … process.exit(1); }` block ending at 1522) and line 1524
(`let recordedDedup = false;`). It must run BEFORE the byte-hash block (1524-1544)
so identity suppression wins and the byte-hash ledger is not polluted by a
suppressed send.

```ts
    // Layer 1 — source-event identity dedup (opt-in). Collapses reworded
    // duplicates of the SAME source event (meeting, thread) before the
    // byte-hash layer ever sees the message. Fail-open on invalid keys.
    let recordedSourceEvent = false;
    const sourceKey = opts.sourceKey;
    if (sourceKey !== undefined && opts.dedup !== false && !opts.streaming) {
      if (opts.streaming) { /* unreachable guard kept out — see note below */ }
      if (!isValidSourceKey(sourceKey)) {
        console.error(`Warning: invalid --source-key '${sourceKey}' — expected <namespace>:<id> (e.g. automator:meeting-<eventId>); failing open to byte-hash dedup.`);
      } else if (env.ctxRoot) {
        let sourceTtlSec: number | undefined;
        if (opts.sourceTtlSec !== undefined) {
          const parsed = Number(opts.sourceTtlSec);
          if (Number.isInteger(parsed) && parsed > 0) {
            sourceTtlSec = parsed;
          } else {
            console.error(`Error: --source-ttl-sec must be a finite positive integer, got '${opts.sourceTtlSec}'; failing open with the default TTL.`);
          }
        }
        const sourceResult = checkAndRecordSourceEvent(env.ctxRoot, sourceKey, { ttlSec: sourceTtlSec });
        if (!sourceResult.surface) {
          const mins = Math.round((sourceResult.ageSec ?? 0) / 60);
          console.log(`Message suppressed (source event '${sourceKey}' already surfaced ${mins}m ago)`);
          try {
            if (env.agentName) {
              const paths = resolvePaths(env.agentName, env.instanceId, env.org);
              logEvent(paths, env.agentName, env.org, 'message', 'telegram_suppressed', 'info', JSON.stringify({ chat_id: chatId, source_key: sourceKey, age_sec: sourceResult.ageSec ?? 0, layer: 'source-event' }));
            }
          } catch {
            // Non-fatal: suppression still succeeds even if event logging fails.
          }
          return;
        }
        recordedSourceEvent = sourceResult.reason === 'first-seen';
      }
    }
```

Notes for the implementer (do NOT copy the placeholder comment line — it is spec
scaffolding; drop the `if (opts.streaming)` no-op line entirely):
- **Gating conditions:** the whole block is skipped when `--no-dedup`
  (`opts.dedup === false` — "always deliver" contract) or `--streaming` (parity with
  the byte-hash skip at line 1525). If `--source-key` is combined with `--streaming`,
  additionally emit `console.error('Warning: --source-key is ignored with --streaming.')`
  once before skipping.
- **`env` already exists** — `const env = resolveEnv();` at line 1499. Do not re-resolve.
- **No ctxRoot** → helper would fail open anyway; the `else if (env.ctxRoot)` guard just
  avoids a pointless call. Send proceeds.
- **TTL parse idiom** copied from the `event-dedup` command (`bus.ts:3021-3029`);
  invalid-key warn idiom copied from `bus.ts:3030-3032`.
- **`recordedSourceEvent` is true ONLY on `reason === 'first-seen'`** — an entry recorded
  by a previous successful send must never be rolled back by this invocation.
- Suppression exit contract matches the byte-hash path (`bus.ts:1530-1542`): stdout line,
  best-effort `logEvent('telegram_suppressed')`, `return` (exit 0).

### 3d. Rollback site 1 — claim-gate hold (lines 1604-1610)

Current:
```ts
          try {
            if (recordedDedup && env.ctxRoot) {
              removeRecord(env.ctxRoot, chatId, message);
            }
          } catch {
            // Non-fatal: rollback best-effort only.
          }
```
Add source-event rollback inside the same try (after the `removeRecord` if-block):
```ts
            if (recordedSourceEvent && env.ctxRoot && opts.sourceKey) {
              removeSourceEventRecord(env.ctxRoot, opts.sourceKey);
            }
```

### 3e. Rollback site 2 — send failure catch (lines 1727-1733)

Same addition inside the existing `try { if (recordedDedup …) removeRecord(…) }` block:
```ts
        if (recordedSourceEvent && env.ctxRoot && opts.sourceKey) {
          removeSourceEventRecord(env.ctxRoot, opts.sourceKey);
        }
```
Rationale: without rollback, a Telegram API failure or claim-gate hold burns the key and
silently suppresses the retry for the whole TTL.

## 4. Ordering summary (send-telegram, post-change)

1. message normalize (1497) → env + BOT_TOKEN (1499-1522)
2. **NEW: source-event identity check** — suppress/return or record first-seen
3. byte-hash `checkAndRecord` (1524-1544, unchanged) — suppress/return or record
4. claim gate (1546-1619) — on hold: roll back BOTH records, exit 2
5. send (1621-1725) — on throw: roll back BOTH records, exit 1

## 5. `send-message` command (starts `bus.ts:212`)

### 5a. Options (insert after the `--reply-to` option, line 218)

```ts
.option('--source-key <key>', 'Source-event identity key (<namespace>:<id>). When set, this bus message is suppressed if the same source event was already surfaced (shared comms-event-dedup ledger). Invalid keys warn and fail open.')
.option('--source-ttl-sec <n>', 'Re-surface window in seconds for --source-key (default 2592000 = 30d).')
```

### 5b. Action signature (line 219)

Extend opts: `{ replyTo?: string; sourceKey?: string; sourceTtlSec?: string }`.

### 5c. Check — INSERT after the agent-exists warning block (ends line 257), BEFORE
`let msgId: string;` (line 259):

Same structure as §3c with these differences:
- No `--no-dedup` / `--streaming` flags exist here — the check runs whenever
  `opts.sourceKey` is set.
- Suppression log event name: `agent_message_suppressed` (audience `'message'`,
  level `'info'`, meta `{ to, source_key, age_sec }`), mirroring the
  `agent_message_sent` idiom at line 267. `paths` already exists (line 236).
- Suppression stdout: `` console.log(`Message suppressed (source event '${sourceKey}' already surfaced ${mins}m ago)`); `` then `return`.
- On `sendMessage` throw (catch at 262-265), before `process.exit(1)` add best-effort
  rollback: `if (recordedSourceEvent && env.ctxRoot) removeSourceEventRecord(env.ctxRoot, sourceKey);`
  wrapped in try/catch.

## 6. Edge cases (must hold)

| Case | Behavior |
|------|----------|
| `--source-key` invalid (fails `SOURCE_KEY_PATTERN`, `event-dedup.ts:22`) | stderr warning, NO error exit, fall through to byte-hash layer |
| `--source-key` valid, first sight | record, proceed to byte-hash + send |
| `--source-key` valid, duplicate within TTL | suppress, exit 0, byte-hash ledger untouched |
| `--source-key` + `--no-dedup` (send-telegram) | both layers bypassed, always deliver |
| `--source-key` + `--streaming` (send-telegram) | warn, source-key ignored (byte-hash already skips streaming, line 1525) |
| no `env.ctxRoot` | check skipped, send proceeds (fail-open) |
| claim-gate hold or send failure after first-seen record | record removed → retry can surface |
| duplicate suppressed send, then a later send failure with same key | rollback does NOT fire (`recordedSourceEvent` false — this invocation didn't record) |
| `--source-ttl-sec` non-integer/≤0 | stderr error line, default TTL used (parity with `bus.ts:3027`) |

## 7. Non-goals

- Do NOT modify the byte-hash layer (`src/telegram/dedup.ts`) or its window logic.
- Do NOT touch the gate commands (`event-dedup`, `meeting-alert-gate`, `ci-alert-gate`,
  `comms-filter`, `bus.ts:2986-3107`).
- Do NOT change the ledger schema — `removeSourceEventRecord` only deletes keys.
