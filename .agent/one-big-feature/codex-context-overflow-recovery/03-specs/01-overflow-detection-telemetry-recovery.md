# Spec 01 — structured overflow detection, honest telemetry, bounded recovery

Status: APPROVED by Larry

## Acceptance requirements

1. An app-server `error` is overflow only when the structured nested field `error.codexErrorInfo` equals `contextWindowExceeded` and the event belongs to the active thread.
2. On overflow, atomically persist a marker containing only thread ID, turn ID, reason, and timestamp. Never persist prompt bodies or credentials.
3. `context_status.json` after overflow must use an explicit overflow/unknown or recovering state. If trustworthy positive same-thread usage exists, retain it; otherwise use null, never healthy 0.
4. A later zero-token event for that same overflowed thread must not clear the overflow state or replace retained usage.
5. A zero-token event for a genuinely different/new thread is valid, clears stale overflow state, and may report 0 with its new session ID.
6. FastChecker consumes the marker at most once per incident and invokes the existing `forceContextRestart()` path. The existing persisted 3/15m breaker bounds repeated incidents.
7. `forceContextRestart()` must not synthesize healthy 0 while recovery is in flight.
8. `.force-fresh` remains one-shot: AgentProcess consumes it and starts Codex in fresh mode; no task, memory, model, reasoning, or window mutation occurs.

## Test matrix

- Positive same-thread telemetry → terminal overflow → failed zero update: retained nonzero values + overflow state.
- Terminal overflow without prior trustworthy usage: null/unknown, not 0.
- Non-overflow structured error: no marker/recovery.
- New thread zero after old overflow: accepted as normal 0 for new session.
- Fresh marker: consumed and one `sessionRefresh()` request; next poll does not duplicate.
- `.force-fresh`: unlinked and fresh spawn selected.
- Window regression: 1,050,000 configured / 997,500 effective untouched; `278039+947=278986 => 27.97%` remains green.
