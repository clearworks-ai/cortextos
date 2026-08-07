# Master Plan — Codex App-Server Configured Model Launch

## Status

APPROVED by Larry — 2026-08-06

## Scope

`CodexAppServerPTY.startAppServer()` currently runs `codex app-server --enable goals --listen …` without the agent's configured `model`. The runtime label and token telemetry preserve the configuration but the actual process can select its default model.

## Change

Build the spawn argv from `this._config.model` with the runtime default `gpt-5-codex` only when it is absent:

```text
codex -c model=<effective-model> app-server --enable goals --listen <socket>
```

The `-c` and `model=<value>` entries must be distinct argv arguments so host-spawn does not depend on shell quoting. No environment variable, thread payload, or telemetry field substitutes for this launch argument.

## Acceptance

1. A configured model produces the exact argv prefix `['-c', 'model=<configured>', 'app-server']`.
2. An unset model uses the documented default `gpt-5-codex` in that same argv form.
3. Socket, retry, kill-during-spawn, goal enablement, and token telemetry behavior remain unchanged.
4. Focused PTY tests, typecheck, full test suite, and diff check are run; no restart/canary/deploy/push/merge occurs.

## Files

- `src/pty/codex-app-server-pty.ts`
- `tests/unit/pty/codex-app-server-pty.test.ts`
