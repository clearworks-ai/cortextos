# Spec 01 — Harden heartbeat-watchdog execFile at fast-checker.ts:240

Slug: `watchdog-execfile-path-hardening`
Target repo: `/Users/joshweiss/code/cortextos`
Scope: `src/daemon/fast-checker.ts` (1 call site) + `tests/unit/daemon/fast-checker.test.ts`. Nothing else.

## Target

`src/daemon/fast-checker.ts:240` — inside the `setInterval` heartbeat watchdog (lines 238-243).

### BEFORE (current, line 240-242)

```ts
execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
  if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
});
```

### AFTER (verbatim — mirror of `src/bus/hooks.ts:307-336` `emitHookBusEvent()`)

```ts
const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
if (frameworkRoot) {
  const cliPath = join(frameworkRoot, 'dist', 'cli.js');
  execFile(process.execPath, [cliPath, 'bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], { timeout: 5_000 }, (err) => { if (err) this.log(`Heartbeat watchdog error: ${err.message}`); });
} else {
  // legacy PATH fallback (unit-test / CTX_FRAMEWORK_ROOT unset)
  execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => { if (err) this.log(`Heartbeat watchdog error: ${err.message}`); });
}
```

## Import check

- `join` **is already imported** at `src/daemon/fast-checker.ts:3` (`import { join } from 'path';`) — verified 2026-07-20. If missing at implementation time, add `import { join } from 'path'`. `execFile` is already imported (line 2).
- `CTX_FRAMEWORK_ROOT` is set by the daemon at startup (same env hooks.ts relies on). No new env plumbing.

## Unit tests

File: `tests/unit/daemon/fast-checker.test.ts` — extend the existing `describe('heartbeat watchdog')` block (currently lines 1104-1153). `vi.mock('child_process', () => ({ execFile: vi.fn() }))` already exists at line 3; fake timers already used (`vi.useFakeTimers()` in the block's beforeEach).

Required assertions:

1. **CTX_FRAMEWORK_ROOT set** (e.g. `process.env.CTX_FRAMEWORK_ROOT = '/tmp/fw-root'` before `checker.start()`; restore after):
   - After `await vi.advanceTimersByTimeAsync(50 * 60 * 1000)`, `execFile` was called with:
     - first arg `process.execPath` (NOT bare `'cortextos'`),
     - args array whose first element is `join('/tmp/fw-root', 'dist', 'cli.js')` followed by `'bus'`, `'update-heartbeat'`, and a string containing `[watchdog] my-agent alive — idle session`,
     - an options object matching `{ timeout: 5_000 }` (e.g. `expect.objectContaining({ timeout: 5_000 })`),
     - a callback (`expect.any(Function)`).
   - `expect(execFile).not.toHaveBeenCalledWith('cortextos', ...)` — no bare `'cortextos'` call in this branch.
2. **CTX_FRAMEWORK_ROOT unset** (`delete process.env.CTX_FRAMEWORK_ROOT` before `checker.start()`):
   - `execFile` called with `'cortextos'`, `expect.arrayContaining(['bus', 'update-heartbeat', expect.stringContaining('[watchdog] my-agent alive — idle session')])`, `expect.any(Function)` — i.e. the current line 1114-1118 assertion shape.
3. Env hygiene: capture the original `process.env.CTX_FRAMEWORK_ROOT` in `beforeEach` and restore it in `afterEach` so the two branch tests (and the pre-existing stop/bootstrap tests) are deterministic regardless of the runner's environment. Update the pre-existing three tests in the block if their bare-`'cortextos'` expectations depend on env state.

## Acceptance criteria

- [ ] `npm run build` — TypeScript compiles clean.
- [ ] `npm test` — all tests green (including the updated/new heartbeat-watchdog tests).
- [ ] With `CTX_FRAMEWORK_ROOT` set, the watchdog spawns `process.execPath` + `<root>/dist/cli.js` — **no bare `'cortextos'` in that branch**.
- [ ] With `CTX_FRAMEWORK_ROOT` unset, behavior is unchanged (bare `'cortextos'` fallback).
- [ ] Error handling unchanged in both branches: `(err) => { if (err) this.log(\`Heartbeat watchdog error: ${err.message}\`); }`.
- [ ] Diff touches only `src/daemon/fast-checker.ts` and `tests/unit/daemon/fast-checker.test.ts`.
