# Spec — Configured Model Is an App-Server Launch Argument

**Status:** APPROVED by Larry

Modify only `CodexAppServerPTY.startAppServer()`, the outbound sender guard, and their focused unit tests.

- Resolve the configured model and reasoning effort without mutating configuration.
- Call the existing `spawnFn` so the observed binary argv is `codex app-server -c model="<configured-model>" -c model_reasoning_effort="<configured-effort>" --enable goals --listen <socket>`.
- Mock host spawning and assert the exact argv for configured and default model/effort values. The test must inspect the spawn call, not a thread request or a generated telemetry record.
- Preserve material configuration-incident messages even when they mention a controlled operation. Add a regression using: `Runtime configuration incident: the live Codex app-server argv omitted -c model and model_reasoning_effort; I have not restarted the runtime because the installed artifact is stale.` Routine authorization disclaimers must remain blocked.
- Do not restart an agent, create a canary, change configurations, or alter any other dirty source.
