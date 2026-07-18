# Spec 01 — worker-deny-fast (execute verbatim)

**Repo:** `/Users/joshweiss/code/cortextos`
**Constraints:** TypeScript strict, no `any`, no `console.log`, minimal diff, touch ONLY the two files below (`src/hooks/hook-permission-telegram.ts` + the new test file). All line numbers verified 2026-07-17 on branch `fix/fleet-bus-daemon-bugfixes`.

---

## Change 1 — `src/hooks/hook-permission-telegram.ts` — add exported `isWorkerSession()` helper

Insert immediately after `readCronActive` (which ends at line 68 with `}`), before the `emitCronPermissionDeniedEvent` docblock at line 70:

```ts

/**
 * Worker-session detection. Worker PTYs (comms-check, transcript-scanner,
 * meeting-brief pages, etc.) launch with CTX_WORKER=1 (set in
 * src/pty/agent-pty.ts). They have no human attached — identical to cron in
 * that nobody can approve — so permission prompts must deny-fast instead of
 * forwarding a live Approve/Deny to Telegram and hanging 30 minutes.
 */
export function isWorkerSession(): boolean {
  return process.env.CTX_WORKER === '1';
}
```

---

## Change 2 — `src/hooks/hook-permission-telegram.ts` — add worker deny-fast in `main()`

The cron deny-fast block ends at line 152 (`  }`). Line 154 begins
`  // Build human-readable summary`. Insert the following block BETWEEN them
(after line 152, before line 154):

```ts

  // Deny-fast for worker-session permission requests (see isWorkerSession).
  if (isWorkerSession()) {
    outputDecision(
      'deny',
      'auto-denied: worker-session (CTX_WORKER=1), no human present — refactor to a --skip-permissions worker',
    );
    return;
  }
```

The cron check (lines 139-152) stays FIRST and UNCHANGED — a worker running a
cron is still cron-attributed and must emit the cron bus event. Do NOT add a bus
event for the worker path. Do NOT modify any other part of `main()` or any other
function.

---

## Change 3 — `src/hooks/hook-permission-telegram.ts` — guard the module entry point

The bottom of the file currently is:

```ts
main().catch((err) => {
  process.stderr.write(`hook-permission-telegram error: ${err}\n`);
  outputDecision('deny', `Hook error: ${err}`);
});
```

Replace it with:

```ts
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hook-permission-telegram error: ${err}\n`);
    outputDecision('deny', `Hook error: ${err}`);
  });
}
```

**Rationale:** Production invokes the hook as a fresh spawned process
(`cortextos bus hook-permission-telegram` → `runHook()` in `src/cli/bus.ts:2217`
does `spawnSync(process.execPath, [hookPath])` with the compiled hook file as the
process entry point). Therefore `require.main === module` is TRUE in production,
so the guard runs `main()` exactly as before — behavior in production is
unchanged. The guard only prevents `main()` from firing when the module is
imported by a unit test. This matches the identical guard already used in the
sibling `src/hooks/hook-planmode-telegram.ts:167`.

---

## Change 4 — `tests/unit/hooks/hook-permission-telegram.test.ts` (NEW FILE)

With the `require.main === module` guard from Change 3 in place, importing the
module no longer triggers `main()`, so no `process.stdin` stub is needed. A plain
`import { isWorkerSession } from '../../../src/hooks/hook-permission-telegram'`
is clean.

`isWorkerSession` is a pure env-predicate; only it is exercised. Match the vitest
style of `tests/unit/daemon/fast-checker.test.ts`.

Write this file EXACTLY:

```ts
import { describe, it, expect, afterEach } from 'vitest';

// Change 3 added a `require.main === module` guard around main(), so importing
// this module does not run main(). isWorkerSession is a pure env predicate and
// is the only thing under test here.
import { isWorkerSession } from '../../../src/hooks/hook-permission-telegram';

describe('isWorkerSession', () => {
  const original = process.env.CTX_WORKER;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CTX_WORKER;
    } else {
      process.env.CTX_WORKER = original;
    }
  });

  it('returns true when CTX_WORKER is exactly "1"', () => {
    process.env.CTX_WORKER = '1';
    expect(isWorkerSession()).toBe(true);
  });

  it('returns false when CTX_WORKER is unset', () => {
    delete process.env.CTX_WORKER;
    expect(isWorkerSession()).toBe(false);
  });

  it('returns false when CTX_WORKER is "0"', () => {
    process.env.CTX_WORKER = '0';
    expect(isWorkerSession()).toBe(false);
  });

  it('returns false for any other value', () => {
    process.env.CTX_WORKER = 'true';
    expect(isWorkerSession()).toBe(false);
    process.env.CTX_WORKER = 'yes';
    expect(isWorkerSession()).toBe(false);
    process.env.CTX_WORKER = '';
    expect(isWorkerSession()).toBe(false);
  });
});
```

---

## Verification gates

1. `npm run build` — clean strict compile (no `any`, no new errors).
2. `npm test` — full suite green.
3. `npx vitest run tests/unit/hooks/hook-permission-telegram.test.ts` — green.
4. `grep -n "console.log\|: any" src/hooks/hook-permission-telegram.ts` — no new hits.

## Out of scope

Cron deny-fast path (unchanged), any bus event for the worker path,
`src/pty/agent-pty.ts` (read-only reference), any other formatter/hook,
observability.
