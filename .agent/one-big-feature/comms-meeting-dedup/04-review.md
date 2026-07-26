# Review — comms-meeting-dedup Part B

**VERDICT: PASS**

Adversarial review of the `--kind comms` fail-closed source-key guard re-add (Part B of #131, minus the auto-send chokepoint). Diff at `/tmp/comms-meeting-dedup-part-b.diff` matches the working tree in `src/cli/bus.ts`, `tests/unit/cli/send-message-source-key.test.ts`, `tests/unit/cli/send-telegram-source-key.test.ts`.

## 1. `--kind comms` fails closed on missing / invalid source-key / missing CTX_ROOT (both paths)

Confirmed on BOTH commands. Each check exits non-zero (`process.exit(1)`) before any send/queue.

- **send-message** (`src/cli/bus.ts:431-444`): missing key → `:433`; invalid key → `:436-438`; missing `CTX_ROOT` → `:440-442`. The guard block runs before the `if (sourceKey !== undefined)` dedup block (`:445`), and the action returns nothing to the send path in between, so a comms send cannot reach queue-write without a valid key + ctxRoot.
- **send-telegram** (`src/cli/bus.ts:1776-1788`): missing key → `:1778`; invalid key → `:1781-1783`; missing `CTX_ROOT` → `:1785-1787`. Runs after BOT_TOKEN resolution (`:1770`) and before the source-dedup block (`:1790`), before `sendMessage` is ever called.

Error strings match the spec verbatim (`... requires --source-key`, `... requires a valid --source-key`, `... requires CTX_ROOT so source-event dedup can be enforced.`).

## 2. Default kind preserves prior fail-open behavior (no regression)

Confirmed. `parseKind(undefined)` returns `'default'` (`:353-356`), so the `kind === 'comms'` guard is skipped entirely.

- send-message `:445-447`: `if (kind !== 'comms' && !isValidSourceKey(sourceKey))` → the invalid-key **warning** + fail-through is preserved for default kind; valid keys still hit `checkAndRecordSourceEvent` under `env.ctxRoot`.
- send-telegram `:1791-1796`: `sourceDedupEnabled = kind === 'comms' || opts.dedup !== false` collapses to `opts.dedup !== false` for default kind — identical to prior main. The `opts.streaming` ignore-warning (`:1793`) and invalid-key fail-open-to-byte-hash warning (`:1795`) both retain the `kind !== 'comms'` guard, so default behavior is byte-for-byte the old path. `--source-key` unset → whole block skipped, unchanged.

## 3. Can `--kind comms` silently fail-open or double-send?

No.

- **Fail-open:** every comms precondition is an early `process.exit(1)`. By the time control reaches the dedup block, `sourceKey` is valid and `env.ctxRoot` is truthy, so the `else if (env.ctxRoot)` branch (send-message `:448`, send-telegram `:1797`) is guaranteed to execute — the source-event ledger check always runs for comms. There is no branch where a comms send skips the ledger.
- **`--no-dedup` override:** `sourceDedupEnabled = kind === 'comms' || opts.dedup !== false` (`:1791`) forces the source-event layer ON for comms even when `--no-dedup` is passed. The byte-hash layer (`dedupEnabled`, `:1827`) still honors `--no-dedup`, but that is the coarser layer; the source-event layer (the regression fix) stays active. Verified by the `--no-dedup` test (2nd call suppressed).
- **`--streaming` bypass:** `opts.streaming && kind !== 'comms'` (`:1793`) — the streaming ignore-branch is disabled for comms, so a comms send can't slip past the ledger via `--streaming`.
- **Double-send:** first-seen records the event (`recordedSourceEvent`, `:1821`); a re-worded duplicate of the same source event returns `surface:false` → `return` (`:1819`) before send. Rollback on send-failure / claim-gate hold removes the record (`:1910`, `:2036`) so a failed send doesn't permanently suppress a legitimate retry.

## 4. `parseKind` rejects unknown values

Confirmed (`:353-361`). Only `undefined`→`'default'` and `'comms'`→`'comms'`; every other value throws `Error: --kind must be 'comms' when set, got '<x>'.`. Both call sites wrap it in try/catch and `process.exit(1)` (send-message `:400-406`, send-telegram — `parseKind` called at the top of the telegram action per the diff, same try/catch shape). Return type `BusSendKind` is a closed union; no `any`.

## 5. Code quality / scope

- No `any` — `BusSendKind` union used throughout; opts objects typed with `kind?: string`.
- No `console.log` added for control flow; all new diagnostics use `console.error` (acceptable). Existing `console.log` suppression messages are pre-existing, unchanged.
- No scope creep: diff touches only the 3 declared files.
- **Part A symbol check:** `grep` for `renderCommsSurfaceMessage` → 0 hits in `bus.ts`. `grep -E "comms-filter.*surface"` → 0 hits. The two `--surface` matches (`:1457`, `:1578`) are unrelated `create-experiment` / experiment-config options, not comms auto-send. No auto-fetch/auto-send path present. `parseCommsFilterInput` (`:~330`) is pre-existing and untouched by this diff.

## 6. Tests assert the fail-closed contract

- **send-message** `:113-127`: `--kind comms rejects sends without a source key` — spies `process.exit` to throw, asserts `exit(1)`, asserts `inboxFiles('pa')` length 0 (no queue write), asserts stderr contains `requires --source-key`. Real fail-closed assertion.
- **send-message** `:82-96`: restored suppress-duplicate test now runs under `--kind comms` with a valid key; asserts the 2nd surface is suppressed. Contract intact.
- **send-telegram** `:199-215`: `--kind comms requires a source key` — asserts `exit(1)`, `sendMessageSpy` NOT called, stderr contains `requires --source-key`.
- **send-telegram** `:217-232`: `--kind comms keeps source-event dedup active even with --no-dedup` — 2 identical comms sends with `--no-dedup`; asserts `sendMessageSpy` called exactly once and the ledger key is written. Directly proves the `--no-dedup` override.

`mockExit()` helper (`:141-145` in send-message test) throws `__PROCESS_EXIT_<code>__` so the `.rejects.toThrow` assertions actually confirm the exit fired rather than swallowing it. Note: coverage of the *invalid-key* and *missing-CTX_ROOT* comms branches is asserted at the code level here but the two new tests cover only the missing-key case explicitly; the invalid-key/no-ctxroot branches are simple sibling guards in the same block and are low-risk. Not a blocker — the fail-closed contract (exit non-zero, no send) is proven for the primary path.

## Scope

Files touched (exactly the 3 in scope):
- `src/cli/bus.ts`
- `tests/unit/cli/send-message-source-key.test.ts`
- `tests/unit/cli/send-telegram-source-key.test.ts`

Part A confirmed ABSENT: no `renderCommsSurfaceMessage`, no `comms-filter --surface`, no auto-fetch/auto-send. Guard is fail-closed on both send-message and send-telegram; default kind is a byte-for-byte fail-open no-op; `--kind comms` overrides `--no-dedup` and ignores the `--streaming` bypass. Tests assert the contract.

**PASS** — ready for PR (Josh approval required for merge to main).
