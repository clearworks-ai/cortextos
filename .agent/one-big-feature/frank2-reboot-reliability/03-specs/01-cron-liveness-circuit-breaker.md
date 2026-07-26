# Spec 01 — cron-liveness escalation: fresh restart + circuit breaker

## File
`src/daemon/fast-checker.ts` only (plus its test file `tests/unit/daemon/fast-checker.test.ts`).
Do not touch `src/daemon/cron-liveness.ts` or its test file — `evaluateCronLiveness()` is
correct and fully covered; this bug is entirely in how `FastChecker.checkCronLiveness()`
escalates.

## Problem (exact lines, current code)

```ts
// fast-checker.ts:1254-1266 (current)
this.cronLivenessOverdueStreak += 1;
if (this.cronLivenessOverdueStreak === 1) {
  this.log('Cron liveness: overdue detected — waiting one more cycle before restart escalation');
  return;
}

// Second consecutive: escalate via existing sessionRefresh + circuit
if (now - this.cronLivenessLastEscalationAt < 15 * 60_000) return;
this.cronLivenessLastEscalationAt = now;
this.log('Cron liveness: escalating via sessionRefresh');
this.agent.sessionRefresh().catch((err) => this.log(`Cron liveness restart failed: ${err}`));
```

Two bugs:
1. `this.agent.sessionRefresh()` is called directly with no preceding `hardRestart(...)` call.
   `sessionRefresh()` (`agent-process.ts:456-478`) always restarts with `--continue` (it never
   writes `.force-fresh`) — see its own doc comment: "Restart with --continue (session
   refresh)". A `--continue` restart reloads the agent's full prior conversation history
   (documented at `agent-process.ts:851-856`). Compare `forceLoopStallRestart()`
   (fast-checker.ts:1378-1397) and `forceContextRestart()` (fast-checker.ts:1749-1822) — BOTH
   call `hardRestart(this.paths, this.agent.name, reason)` (writes `.force-fresh` +
   `.restart-planned`, `src/bus/system.ts:78-89`) immediately before `sessionRefresh()`, which
   is what makes `shouldContinue()` (`agent-process.ts:953-969`) return `false` on the next
   boot and actually shed context. `checkCronLiveness()`'s escalation skips that call entirely.
2. The comment literally says "escalate via existing sessionRefresh **+ circuit**" but there is
   no circuit breaker anywhere in this function or file for cron-liveness escalations — compare
   `ctxCircuitBrokenAt`/`ctxCircuitRestarts` (context restarts) and `stallCircuitBrokenAt`/
   `stallCircuitRestarts` (loop-stall restarts), both of which trip after 3 restarts in 15
   minutes and pause 30 minutes. The `now - this.cronLivenessLastEscalationAt < 15 * 60_000`
   check only rate-limits to once per 15 minutes — it never stops, so a cron whose overdue
   state cannot be fixed by restarting (e.g. a stuck dispatch/state-write bug elsewhere) causes
   an indefinite 15-minute restart loop, forever, each iteration reloading the full growing
   conversation history via `--continue`. This is the confirmed cause of the frank2 reboot loop
   (2026-07-25T21:56Z–2026-07-26T01:37Z, see `02-master-plan.md` for the log evidence).

## Fix

### 1. New per-instance state fields
Add next to the existing `cronLiveness*` fields (~line 187-189):
```ts
private cronLivenessCircuitRestarts: number[] = [];
private cronLivenessCircuitBrokenAt: number | null = null;
private cronLivenessCircuitFile: string = '';
```

### 2. Constructor wiring
In the constructor, next to the existing `ctxCircuitFile`/`stallCircuitFile` setup
(~line 210-214):
```ts
this.cronLivenessCircuitFile = join(paths.stateDir, '.cron-liveness-circuit.json');
this.loadCronLivenessCircuit();
```

### 3. Load/save helpers
Add methods with the exact same shape as `loadStallCircuit()`/`saveStallCircuit()`
(fast-checker.ts:1356-1376), renamed for cron-liveness:
```ts
private loadCronLivenessCircuit(): void {
  try {
    if (!existsSync(this.cronLivenessCircuitFile)) return;
    const data = JSON.parse(readFileSync(this.cronLivenessCircuitFile, 'utf-8'));
    this.cronLivenessCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
    this.cronLivenessCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
  } catch {
    // Start fresh on error
  }
}

private saveCronLivenessCircuit(): void {
  try {
    writeFileSync(this.cronLivenessCircuitFile, JSON.stringify({
      restarts: this.cronLivenessCircuitRestarts,
      brokenAt: this.cronLivenessCircuitBrokenAt,
    }), 'utf-8');
  } catch {
    // Non-critical
  }
}
```

### 4. Circuit-breaker gate at the top of `checkCronLiveness()`
Immediately after the existing 60s throttle guard (`if (now - this.cronLivenessLastCheckedAt <
60_000) return;`) and BEFORE any cron scanning, add the same reset-or-skip shape used by
`checkContextStatus()` (~1484-1494) / `evaluateStallWatchdog()` (~1404-1413):
```ts
if (this.cronLivenessCircuitBrokenAt !== null) {
  if (now - this.cronLivenessCircuitBrokenAt >= 30 * 60_000) {
    this.cronLivenessCircuitBrokenAt = null;
    this.cronLivenessCircuitRestarts = [];
    this.saveCronLivenessCircuit();
    this.log('Cron-liveness circuit breaker reset after 30min pause');
  } else {
    return; // still paused
  }
}
```
(Exact placement: after `this.cronLivenessLastCheckedAt = now;` is set, so the throttle timer
keeps advancing even while the circuit is broken — matches how the other two watchdogs behave.)

### 5. Track the overdue cron's name
`checkCronLiveness()`'s `for (const cron of crons)` loop currently only sets `anyOverdue =
true`. Capture the name of the first overdue cron found in that loop (e.g. a
`let firstOverdueName: string | null = null;` set alongside `anyOverdue = true`) so the
escalation message can name it.

### 6. Replace the escalation body
Replace the current lines (see "Problem" above, from `// Second consecutive:` through the
`sessionRefresh()` call) with:
```ts
if (now - this.cronLivenessLastEscalationAt < 15 * 60_000) return;
this.cronLivenessLastEscalationAt = now;
this.forceCronLivenessRestart(firstOverdueName ?? 'unknown', `cron '${firstOverdueName ?? 'unknown'}' overdue`);
```

### 7. New `forceCronLivenessRestart` method
Add as a new private method (place near `forceLoopStallRestart`, which it mirrors):
```ts
private forceCronLivenessRestart(cronName: string, reason: string): void {
  const now = Date.now();

  this.cronLivenessCircuitRestarts = this.cronLivenessCircuitRestarts.filter(t => now - t < 15 * 60_000);
  if (this.cronLivenessCircuitRestarts.length >= 3) {
    this.cronLivenessCircuitBrokenAt = now;
    this.saveCronLivenessCircuit();
    const msg = `Cron-liveness circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min over cron '${cronName}' that stayed overdue. Restarting the agent cannot fix a stuck cron dispatch — auto-restarts paused 30min. Check cron-state.json / crons.json for '${cronName}'.`;
    this.log(msg);
    if (this.telegramApi && this.chatId) {
      this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
    }
    return;
  }

  this.cronLivenessCircuitRestarts.push(now);
  this.saveCronLivenessCircuit();
  hardRestart(this.paths, this.agent.name, `CRON-LIVENESS-RESTART: ${reason}`);
  this.agent.sessionRefresh().catch(err => this.log(`Cron liveness restart failed: ${err}`));
}
```
`hardRestart` is already imported in this file (used by `forceLoopStallRestart` /
`forceContextRestart`) — no new import needed.

## Do NOT change
- `evaluateCronLiveness()` / `scheduleIntervalMs()` in `cron-liveness.ts` — correct as-is.
- The 15-minute `cronLivenessLastEscalationAt` re-escalation floor's timing semantics, or the
  "wait one more cycle" streak===1 soft-log behavior — only the restart mechanism (fresh vs
  `--continue`) and the addition of a circuit breaker on top change.
- Any agent's `config.json` (frank2's or otherwise) — this is a daemon-only fix.

## Tests to add (extend `tests/unit/daemon/fast-checker.test.ts`)

Follow the existing `describe('stall watchdog', ...)` block's structure and mocking pattern
(top of file: `vi.mock('../../../src/bus/system', () => ({ hardRestart: vi.fn() }));`,
`import { hardRestart } from '../../../src/bus/system';`, `createMockAgent`,
`createMockTelegramApi`). Add a new `describe('cron liveness escalation', ...)` block:

1. **Escalation now goes through hardRestart, not a bare `--continue`.** Build a FastChecker,
   write a `crons.json`-equivalent fixture (check how `readCrons`/`readCronState` are
   sourced/mocked elsewhere in this test file, or directly set the private streak fields —
   `(checker as any).cronLivenessOverdueStreak = 1` then call `(checker as any)
   .checkCronLiveness(now)` a second time / directly call `(checker as any)
   .forceCronLivenessRestart('pre-meeting-brief-page', "cron 'pre-meeting-brief-page' overdue")`
   — assert `hardRestart` was called with `(paths, 'test-agent',
   expect.stringContaining("CRON-LIVENESS-RESTART: cron 'pre-meeting-brief-page' overdue"))`
   BEFORE `agent.sessionRefresh` (call-order via `vi.fn()` mock invocation order or separate
   assertions — same style as `fast-checker.test.ts:456-461`).
2. **Circuit trips after 3 escalations in 15 minutes.** Seed `(checker as any)
   .cronLivenessCircuitRestarts = [now - 14*60_000, now - 10*60_000, now - 5*60_000]`, then call
   `forceCronLivenessRestart(...)` once more — assert `hardRestart` NOT called this time,
   `api.sendMessage` called once (use `createMockTelegramApi()` + pass `telegramApi`/`chatId`
   into the FastChecker constructor, same as the stall-circuit test at
   `fast-checker.test.ts:533-560`), and `(checker as any).cronLivenessCircuitBrokenAt` is set.
3. **Circuit resets after 30 minutes.** Set `cronLivenessCircuitBrokenAt = now - 31*60_000`,
   call the top-of-`checkCronLiveness` reset path (either call `checkCronLiveness(now)` directly
   with a fixture that has no overdue crons, or test the reset condition in isolation) — assert
   `cronLivenessCircuitBrokenAt` is `null` again and `cronLivenessCircuitRestarts` is empty.
4. **Circuit state persists across a fresh FastChecker instance** (proves survival across a
   `--continue`-free `stop()+start()` AND a full daemon restart that recreates the FastChecker).
   Construct one FastChecker, trip its circuit (as in test 2), then construct a SECOND
   FastChecker pointed at the same `paths` (same `stateDir`) — assert the second instance's
   `(checker2 as any).cronLivenessCircuitBrokenAt` is non-null immediately after construction
   (i.e. `loadCronLivenessCircuit()` picked it up), mirroring how `.ctx-circuit.json`/
   `.stall-circuit.json` persistence would be proven.
5. Regression: confirm the existing `stall watchdog` and `context-handoff` describe blocks in
   this file still pass unmodified (they exercise `hardRestart`/`sessionRefresh` mocks that this
   change must not perturb).

## Verify
- `npm run build` clean (strict TS, no `any` beyond the existing `(checker as any)` test-only
  private-field access pattern already used throughout this test file — do not add `any` to
  the production `fast-checker.ts` code itself).
- `npm test` green, including the 4-5 new tests above and all pre-existing
  `cron-liveness.test.ts` + `fast-checker.test.ts` tests.
- No `console.log` in the new code — use `this.log(...)` (the class's existing `LogFn`), same
  as every other method in this file.
