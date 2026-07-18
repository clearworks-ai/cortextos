# Spec 03 — Tests (verify OUTCOME: ledger + send/suppress, not render)

Runner: vitest (`npm test`). All tests must pass plus `npm run build` clean.

## File A — extend `tests/unit/utils/event-dedup.test.ts` (exists, 200+ lines)

Reuse the existing harness: `mkdtempSync` ctxRoot, `vi.spyOn(Date, 'now')`, `ledgerPath()`
= `<ctxRoot>/state/comms-event-dedup.json`, `readLedger()`/`seedLedgerFile()` helpers
(lines 25-42). Add a `describe('removeSourceEventRecord', …)` block:

1. **`removes a recorded key so the next check surfaces again`**
   - Setup: `checkAndRecordSourceEvent(ctxRoot, 'automator:meeting-evt1')` → first-seen.
   - Act: `removeSourceEventRecord(ctxRoot, 'automator:meeting-evt1')`.
   - Expect: ledger no longer contains the key; a second `checkAndRecordSourceEvent`
     returns `{ surface: true, reason: 'first-seen' }`.
2. **`is a no-op for a missing key`** — call remove on an empty/absent ledger; expect no
   throw and (if the file exists) other keys untouched.
3. **`is a no-op for invalid key or empty ctxRoot`** — `removeSourceEventRecord('', k)`
   and `removeSourceEventRecord(ctxRoot, 'NotValid')` leave a seeded ledger byte-identical.
4. **`does not disturb sibling entries`** — seed two keys, remove one, expect the other's
   `firstSeenAt`/`fireOnce` unchanged.

## File B — NEW `tests/unit/cli/send-telegram-source-key.test.ts`

Follow the full-command idiom of `tests/unit/cli/send-telegram-normalize.test.ts` exactly:
`vi.mock('../../../src/telegram/api.js', …)` with a `sendMessageSpy`, import
`{ busCommand } from '../../../src/cli/bus'`, temp `CTX_ROOT`/`CTX_AGENT_NAME`/`BOT_TOKEN`
env, drive commands via `busCommand.parseAsync([...], { from: 'user' })`, and read the
REAL ledger file `<ctxRoot>/state/comms-event-dedup.json` to assert outcomes.

Named cases (each maps to an acceptance criterion from `00-scope-findings.md`):

1. **`eratepros replay: 4 reworded bodies, same source key -> exactly ONE send`**
   - Act: run `send-telegram <chat> <bodyN> --source-key automator:meeting-evt-eratepros
     --source-ttl-sec 43200` four times with four DIFFERENT message bodies
     ("Reminder: ERatePros call w/ Dean Wilcox at 10am", "Heads up — Dean Wilcox meeting
     coming up", etc.).
   - Expect: `sendMessageSpy` called exactly **1** time; ledger has exactly one
     `automator:meeting-evt-eratepros` entry; sends 2-4 print the suppression line.
2. **`goldbach thread: one ping per source event`**
   - Act: two sends with `--source-key frank2:thread-goldbach123` (different bodies),
     then one send with `--source-key frank2:thread-goldbach999`.
   - Expect: spy called 2× total (first goldbach123 + goldbach999); second goldbach123
     suppressed.
3. **`different meeting still surfaces`**
   - Act: send with `--source-key pa:meeting-evt-A`, then `--source-key pa:meeting-evt-B`,
     same identical body both times AND `--dedup-window 1` not set (byte-hash would
     suppress identical bodies — use different bodies OR pass `--no-dedup`? NO — use
     different bodies so only the source-key layer is exercised).
   - Expect: spy called 2×.
4. **`byte-hash fallback regression: no source key, identical body suppressed`**
   - Act: send the SAME body twice with NO `--source-key`.
   - Expect: spy called 1×; second run prints the existing byte-hash suppression line
     (`Message suppressed (duplicate sent …)`); `comms-event-dedup.json` untouched
     (byte-hash uses its own `state/telegram-dedup.json`).
5. **`invalid source key fails open to byte-hash`**
   - Act: send twice with `--source-key "NoNamespace"` and two DIFFERENT bodies.
   - Expect: spy called 2× (invalid key never suppresses), stderr warning emitted,
     `comms-event-dedup.json` has no entry.
6. **`ttl expiry: same key surfaces again after window`**
   - Setup: `vi.spyOn(Date, 'now')` (idiom from `tests/unit/utils/event-dedup.test.ts:16`).
   - Act: send with `--source-key pa:meeting-evt-C --source-ttl-sec 43200`; advance mocked
     now by 43_201_000 ms; send again with a different body, same key.
   - Expect: spy called 2×.
7. **`send failure rolls back a first-seen source record`**
   - Setup: make `sendMessageSpy` reject once.
   - Act: send with `--source-key pa:meeting-evt-D` (expect nonzero exit / caught
     `process.exit` — follow the normalize-test's exit-handling pattern); then send again
     with the same key and a resolving spy.
   - Expect: second send delivers (spy success call count 1); ledger contains the key
     exactly once, recorded by the SECOND send.
8. **`no-dedup bypasses the source-key layer`**
   - Act: send twice, same `--source-key pa:meeting-evt-E`, `--no-dedup`, different bodies.
   - Expect: spy called 2×; ledger has NO entry for the key (layer skipped entirely).

## File C — NEW `tests/unit/cli/send-message-source-key.test.ts` (or fold into File B)

`send-message` writes to the local bus (no Telegram mock needed). Harness: temp
project/agent dirs the way `tests/unit/cli/bus-crons.test.ts` builds them, or assert on
stdout + inbox file. Cases:

1. **`suppresses a duplicate source event on the bus path`** — two
   `send-message pa normal <textN> --source-key automator:meeting-evt-F` runs with
   different texts → first prints a msgId, second prints the suppression line; target
   inbox contains exactly one message.
2. **`no source key -> both messages deliver (regression)`** — two plain sends, both land.

## Outcome-verification rules (test-on-staging discipline)

- Assert on the LEDGER FILE contents and the SPY CALL COUNT — never on log text alone
  (log lines are asserted only as secondary evidence for suppression cases).
- Every acceptance criterion in `00-scope-findings.md` §Proof maps to a named case above:
  ERatePros → B1, Goldbach → B2, new-meeting → B3, byte-hash regression → B4.
- Full suite: `npm run build && npm test` (repo root `CLAUDE.md` contract).
