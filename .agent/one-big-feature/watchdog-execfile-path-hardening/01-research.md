# 01 — Research: watchdog-execfile-path-hardening

Slug: `watchdog-execfile-path-hardening`
Origin: sage weekly audit finding **LOW#2** (severity LOW)
Date: 2026-07-20

## Problem

`src/daemon/fast-checker.ts:240` — the idle-session heartbeat watchdog (fires every 50 min, timer set at lines 235-243) calls:

```ts
execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
  if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
});
```

Bare `'cortextos'` relies on PATH resolution at spawn time.

## Root cause (ENOENT / PATH)

When the daemon runs under a service manager (PM2) with a minimal PATH that lacks the npm-link target, the spawn fails **ENOENT**. The failure is only `this.log`'d — the heartbeat is **silently dropped**. There is no retry and no escalation; the fleet's heartbeat record for an idle session simply goes stale.

## Existing canonical precedent: `emitHookBusEvent()`

`src/bus/hooks.ts:307-336` solved this EXACT problem for hook audit events. Its comment (lines 309-315) explicitly describes the ENOENT-under-PM2 failure and — notably — claims it uses the "same pattern as fast-checker.ts heartbeat watchdog." That comment is aspirational/stale: **fast-checker diverged and still uses bare `'cortostos'`→`'cortextos'` PATH lookup** while hooks.ts was hardened. The hardened pattern:

```ts
const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
if (frameworkRoot) {
  const cliPath = join(frameworkRoot, 'dist', 'cli.js');
  execFile(process.execPath, [cliPath, 'bus', ...], { timeout: 5_000 }, cb);
} else {
  execFile('cortextos', ['bus', ...], cb); // legacy PATH fallback (unit tests / CTX_FRAMEWORK_ROOT unset)
}
```

`process.execPath` is the running node binary (always resolvable, no PATH needed) and `CTX_FRAMEWORK_ROOT` is set by the daemon at startup — the same env var hooks.ts already relies on.

## Why fast-checker diverged

The hooks.ts hardening was written referencing fast-checker as the source pattern, but the fast-checker call site was never actually updated. Result: two call sites intended to be identical, one hardened, one not.

## Blast radius

- Silent heartbeat loss for **idle daemon sessions under PM2** (or any minimal-PATH service manager). Watchdog fires every 50 min; every fire is dropped, so idle agents look dead/stale to fleet-health tooling with no error surfaced beyond the fast-checker log.
- Severity LOW: heartbeats also flow through active-session paths; only the idle-session watchdog path is affected.

## Verified source facts (read 2026-07-20)

- `fast-checker.ts` already imports `execFile` (line 2) and `join` (line 3) — **no import change needed**.
- Existing watchdog unit tests: `tests/unit/daemon/fast-checker.test.ts:1104-1153` (`describe('heartbeat watchdog')`), vitest with `vi.mock('child_process', () => ({ execFile: vi.fn() }))` at line 3. Current assertions expect bare `'cortextos'` and a bare callback (no options object) — they must be updated alongside the fix.
