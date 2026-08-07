# Codex one-million-token window plan

## Accepted evidence

- Every fresh enabled Codex app-server process reports a live `modelContextWindow` of `258400` through its token-usage notification.
- The installed `codex app-server generate-json-schema` output includes a recognized `model_context_window` configuration field.
- Current launch argv supplies `model` and `model_reasoning_effort`, but not `model_context_window`.
- cortextOS records the live notification value in `context_status.json`; it deliberately takes that value ahead of its fallback `codex_context_cap` setting.

## Required implementation/configuration packet

1. Add a `codex_context_cap: 1000000` field to each explicitly selected Codex agent configuration. Do not change any agent's `model` or `reasoning_effort`.
2. Change `CodexAppServerPTY.startAppServer()` to add the exact per-agent launch argument `-c model_context_window=<codex_context_cap>` when the field is present.
3. Add an argv-level regression proving the value reaches the Codex binary and that omitted configuration preserves current behavior.
4. Build and run focused PTY/config tests. Do not infer success from the argv or schema alone.

## Acceptance sequence after separate approval

1. Restart one designated agent only.
2. Capture its fresh app-server argv plus `thread/tokenUsage/updated.modelContextWindow` / written `context_status.json`.
3. Accept the configuration only if the runtime reports `1000000` (not merely if the argv contains the field).
4. If it remains `258400` or Codex rejects the setting, revert the canary configuration and report that the installed/provider runtime does not accept the requested window; no fleet rollout.
5. Only after a successful canary, request authorization for per-agent rollout and verify each runtime independently.
