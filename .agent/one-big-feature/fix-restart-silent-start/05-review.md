# Adversarial Review — fix-restart-silent-start

**Verdict: PASS**

## Scope
Changed files ONLY: `src/cli/restart.ts`, `tests/unit/cli/restart-command.test.ts`. Matches spec exactly.

## Checks
- Atomic restart IPC: replaced the two-call `stop-agent`+`start-agent` sequence with a single `restart-agent` IPC — kills the stop→start race. Verified `restart-agent` is a real handled IPC type: `IPCRequest` union (src/types/index.ts:784) + daemon handler (src/daemon/ipc-server.ts:616); already used by bus.ts self/hard/soft-restart.
- BUG-036 stop marker preserved: `writeStopMarker(instanceId, agent, 'stopped via cortextos restart')` still called BEFORE the IPC dispatch (prevents false crash-alert during the stop window). Test asserts marker index < restart-agent index.
- Liveness poll: `waitForRestartLiveness` polls the status IPC until a fresh running pid appears, up to `RESTART_VERIFY_TIMEOUT_MS = 10_000` (named const) at `RESTART_VERIFY_INTERVAL_MS = 500`. Race-safe: requires observing the restart window (old pid gone / different pid) before declaring success, so a stale pre-restart running status cannot yield a false pass.
- Truthful failure: on timeout, prints "Start did not confirm within 10s — agent may have failed to spawn." + "Recover with: cortextos start <agent>" and `process.exit(1)`.
- No `any`, no debug `console.log` (only user-facing status lines), no new deps.

## Tests (3 new)
1. never-confirms → exit 1 + recovery hint
2. confirms running within window → success, sends restart-agent, never stop-agent/start-agent
3. writeStopMarker called with correct args BEFORE restart-agent

Result: 7/7 pass (4 original command-shape + 3 new).
