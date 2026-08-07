# Codex context-overflow recovery — master plan

Status: APPROVED by Larry

## Objective

Turn a terminal Codex `contextWindowExceeded` event into one bounded force-fresh recovery while keeping telemetry honest across the failed old thread and legitimate zero-token new thread.

## Implementation

1. Classify the exact structured overflow error in `CodexAppServerPTY` and persist a small atomic overflow marker plus an overflow/unknown `context_status.json` payload that preserves last trustworthy same-thread usage.
2. Make same-thread zero-token updates after overflow preserve the last trustworthy usage and overflow state. Allow zero for a different/new thread and mark it normal.
3. Teach FastChecker to consume a fresh structured overflow marker before percentage-based checks and call the existing bounded `forceContextRestart()` path. Do not scan generic conversation text.
4. On recovery, write recovering/unknown telemetry rather than a healthy synthetic 0. The first token event from the new thread becomes authoritative, including a legitimate zero.
5. Add adapter, monitor, and agent-process tests for failed-zero preservation, exact overflow classification, marker consumption/deduplication, `.force-fresh` consumption, and normal new-thread zero.

## Non-goals

- No changes to model, reasoning effort, configured context window, effective context window, task state, memory, heartbeat semantics, or provider retry policy.
- No generic recovery for unrelated app-server errors.
- No unbounded restart loop; existing persisted circuit breaker remains authoritative.

## Verification

- Focused Vitest suites for Codex PTY, context monitor, and agent process.
- Full `npm test`, `npm run typecheck`, `npm run build`, and diff-check.
- Rebuild existing daemon, trigger a controlled synthetic overflow marker against Larry, prove marker consumed, `.force-fresh` consumed, thread ID changes, service responds, and telemetry reports the new thread without a false healthy old-thread zero.
