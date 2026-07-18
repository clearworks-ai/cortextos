# Spec 01 — restart liveness verification + race fix

**File:** `src/cli/restart.ts` (+ test)
**Owner:** codexer

## Problem (verbatim root cause)
`cortextos restart <agent>` sends two separate fire-and-forget IPC calls (stop-agent then
start-agent). Both IPC handlers return `success` on *dispatch* (`ipc-server.ts:592/608`) while the
real `startAgent()`/`stopAgent()` run async with only `.catch(console.error)`. Result: (a) start can
race the still-in-flight stop, and (b) a silently failed spawn is still reported to the CLI as
`Starting X`. Operator sees success; agent is absent ~30s. Incident 2026-07-17T15:53Z on frank2.

## Required behavior
1. Eliminate the stop→start race. Preferred: replace the two `stop-agent`+`start-agent` IPC calls
   with the single atomic `restart-agent` IPC (daemon runs `AgentManager.restartAgent()` =
   `stopAgent → await → startAgent`). Keep the existing `writeStopMarker(instanceId, agent, ...)`
   call in restart.ts BEFORE the IPC send so the SessionEnd crash-alert hook does not fire a false
   `🚨 CRASH` during the stop window (BUG-036 pattern — do not remove it).
   - If the `restart-agent` IPC returns `{success:false}` (e.g. NOT_FOUND), print the error and
     `process.exit(1)` as today.
2. After the restart IPC returns success, VERIFY the agent actually reached a running state:
   - Poll the `status` IPC (`ipc.send({ type: 'status' })`) on a short interval (~500ms) up to a
     bounded timeout (default ~10s; make it a named const, e.g. `RESTART_VERIFY_TIMEOUT_MS`).
   - The agent is "up" when it appears in the status list with a live pid / running state (match how
     existing CLI status code reads `AgentStatus` — reuse the same shape, do not invent fields).
   - On confirmed running: print `${agent} restarted` (or similar truthful success) and exit 0.
   - On timeout without the agent running: print
     `  Start did not confirm within Ns — agent may have failed to spawn.` and
     `  Recover with: cortextos start ${agent}` then `process.exit(1)`.
3. Do not change the fire-and-forget behavior of `start`/`stop`/`restart` IPC for other callers
   (soft-restart-all, self-restart, hard-restart, enable). Scope the liveness poll to this CLI only.

## Acceptance / tests
Add a unit test (match existing `tests/` CLI conventions; mock `IPCClient`):
- restart where status never shows the agent running → process exits non-zero AND prints the
  recovery hint (assert on the error path; use a small/injectable timeout so the test is fast).
- restart where status shows the agent running within the window → success path, no error.
- Assert `writeStopMarker` is still invoked before the restart IPC.

## Constraints (Clearworks non-negotiables)
- TypeScript strict, no `any`, no `console.log` added for debugging (use existing console.error/log
  patterns already in restart.ts for user-facing CLI output — those are intended CLI output, keep style).
- No new runtime deps.
- `npm run build` must compile clean; `npm test` green.

## Do NOT
- Do not touch `agent-manager.ts` restartAgent internals unless strictly needed to expose liveness
  (prefer polling the existing `status` IPC from the CLI).
- Do not remove the BUG-036 stop-marker.
- Do not widen scope to the daemon-process restart.
