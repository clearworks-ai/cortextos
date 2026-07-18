# 01 — Research: `cortextos restart <agent>` silent start-failure

**Task:** task_1784303702525_73457745
**Incident:** 2026-07-17T15:53Z — `cortextos restart frank2`: stop half worked, start half
silently no-op'd. CLI printed `Starting frank2` (success), but agent absent from `status` ~30s
across multiple checks. Explicit `cortextos start frank2` brought it up in 6s.

## Root cause (source-read)

`cortextos restart` = `src/cli/restart.ts`. It sends **two separate fire-and-forget IPC calls**:

1. `stop-agent` IPC → `src/daemon/ipc-server.ts:600` calls `inspectAgentOp('stop')`, fires async
   `stopAgent()` with only `.catch(console.error)`, returns `{success:true, data:'Stopping X'}`
   **on dispatch — before `stopAgent()` removes the agent from `this.agents`.**
2. restart.ts (line 37) sees `stopResponse.success` and **immediately** sends `start-agent` IPC.
3. `start-agent` IPC → `ipc-server.ts:578` calls `inspectAgentOp('start')`, fires async
   `startAgent()` with only `.catch(console.error)`, returns `{success:true, data:'Starting X'}`
   **on dispatch — the real spawn runs async and its failure goes to daemon stdout, never back
   to the CLI.**

Two silent failure modes result, both reported as success to the operator:
- **Race:** async `stopAgent()` still in flight when start arrives → either `inspectAgentOp('start')`
  dedups (DEDUPED), or `startAgent()` spawns into a half-torn-down state.
- **Silent spawn failure:** stop completed, start dispatched `success:'Starting X'`, but the async
  `startAgent()` PTY spawn failed — `.catch(console.error)` swallows it to daemon stdout.

The atomic `restartAgent()` (`agent-manager.ts:1070`) already does the correct sequential
`stopAgent → await → startAgent`, avoiding the race. But the CLI does **not** use it, and even it
returns before confirming the agent reached a *running* state (`restart-agent` IPC is also
fire-and-forget, `ipc-server.ts:621`).

## Core defect
Every start/stop/restart IPC op returns success **on dispatch**, never confirming the agent
actually reached a running state. `restart` therefore cannot detect a failed start.

## Constraints
- Preserve `writeStopMarker()` crash-alert suppression (BUG-036) in the stop phase.
- Don't change the async fire-and-forget IPC contract for other callers — fix at the `restart`
  CLI layer with post-start liveness verification (+ prefer the atomic path to kill the race).
