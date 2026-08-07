# Codex context-overflow recovery — research

Status: COMPLETE

## Verbatim scope

> Josh authorized the durable fix. Claim task task_1786065927206_04316625: repair the Codex context-overflow wedge and false 0% telemetry. Your prior thread 019fd975… repeatedly hit contextWindowExceeded while failed zero-token events overwrote context_status to 0%; fresh heartbeat hid the wedge. You are now on fresh thread 019fd9d1… with 2.62% telemetry. Implement bounded automatic force-fresh recovery plus honest overflow/unknown accounting, tests, typecheck/build, and live daemon proof. Preserve 1050000 configured / 997500 effective, tasks, and memory; no model/reasoning/window changes. Send exact root cause, files, tests, and post-build recovery evidence.

## Source findings

- `src/pty/codex-app-server-pty.ts:704-789`: structured app-server `error` notifications are logged and reject the turn but are not classified. The live error is `error.codexErrorInfo === "contextWindowExceeded"`, `willRetry:false`, and carries thread/turn IDs.
- `src/pty/codex-app-server-pty.ts:872-909`: every `thread/tokenUsage/updated` writes its `last` usage directly. A failed-turn zero therefore replaces the last trustworthy nonzero status with healthy-looking 0%.
- `src/daemon/fast-checker.ts:1177-1449`: overflow recovery is gated on high telemetry plus generic PTY phrases. Once the failed zero write lands, corroboration is false and the retained thread wedges indefinitely.
- `src/daemon/fast-checker.ts:1456-1552`: `forceContextRestart()` already provides persisted three-in-15-minute circuit breaking, writes `.force-fresh`, and calls `sessionRefresh()`.
- `src/daemon/agent-process.ts:1028-1089`: `.force-fresh` is consumed once and makes Codex start in `fresh` mode; `CodexAppServerPTY.startOrResumeThread()` then calls `thread/start` instead of resuming the poisoned thread.

## Live evidence

- Old thread: `019fd975-8066-79d3-a3f5-a0bb5d7a22e1`.
- Exact errors repeat across turns in `stdout.log` with `codexErrorInfo:"contextWindowExceeded"`.
- Fresh recovery thread: `019fd9d1-4f52-7d40-b345-116e686ecd65`.
- Required windows remain configured 1,050,000 / effective 997,500.
