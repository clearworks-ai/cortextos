# Codex context-full DEADLOCK fix — Staging Receipt (2026-08-10)

**Branch:** `larry/codex-context-full-handoff-fix` (base `origin/main` @ e8c0bc58)
**Incident:** `incident_codex_thread_context_full_false_zero_telemetry_2026-08-10` (6th attempt — architectural fix)
**Staging instance:** `cortextos-staging` (pinned `CTX_INSTANCE_ID=cortextos-staging`, `CTX_ROOT=~/.cortextos/cortextos-staging`, `CTX_FRAMEWORK_ROOT=~/.cortextos/cortextos-staging-fw`, empty creds — cannot touch prod or message anyone)
**Date:** 2026-08-11T00:11Z

## What was proven

The real shipped `CodexAppServerPTY` (src/pty/codex-app-server-pty.ts) was driven against the PINNED staging instance dir, writing/reading REAL files on disk (no fs mocks), via:

```
CTX_INSTANCE_ID=cortextos-staging \
  node_modules/.bin/vitest run tests/staging/codex-context-full-staging-verify.test.ts
# → Test Files 1 passed (1) | Tests 4 passed (4)
```

Artifacts land under `~/.cortextos/cortextos-staging/state/tlab-codex/`.

### Behavior A — resume yields REAL context_status usage (deadlock-breaker)

A resumed FULL thread structurally cannot emit `thread/tokenUsage/updated` before it
fails every turn on "ran out of room" — the codex v2 protocol has NO per-thread
usage-read request (confirmed against `codex app-server generate-json-schema`:
`account/usage/read` is account-level daily buckets; `thread/read`/`Turn` carry no
window occupancy). The fix pulls usage from the app-server-owned rollout JSONL
`token_count` event (path returned on the `thread/resume` response).

Resumed a thread whose rollout JSONL shows 180k/200k occupancy. On-disk result:

```json
// state/tlab-codex/context_status.json  (Behavior A)
{"used_percentage":90,"context_window_size":200000,"exceeds_200k_tokens":false,
 "current_usage":{"input_tokens":165000,"output_tokens":5000,"cache_read_input_tokens":10000,"cache_creation_input_tokens":0},
 "session_id":"resumed-full-thread","measurement_source":"resume_rollout",
 "written_at":"2026-08-11T00:11:17.295Z"}
```

`used_percentage: 90` (TRUE occupancy) — NOT the restart-reset `0` that caused the
deadlock. `measurement_source: resume_rollout` is the flag the FastChecker uses to
bypass the fresh-thread spike-grace so the NORMAL proactive `[CONTEXT HANDOFF
REQUIRED]` fires immediately at threshold (agent writes durable memory + handoff doc
+ `cortextos bus hard-restart --handoff-doc` — the good path).

### Behavior B — context-window turn error → hard-restart/handoff (not a swallow, not a blank thread)

Injected the exact app-server error string on a full thread. On-disk result:

```
# state/tlab-codex/.force-fresh
CONTEXT-FORCE-RESTART: Codex context-window turn failure: Codex ran out of room in the model's context window. Start a new thread

# state/tlab-codex/.restart-planned
CONTEXT-FORCE-RESTART: Codex context-window turn failure: Codex ran out of room in the model's context window. Start a new thread

# state/tlab-codex/.handoff-doc-path
/Users/joshweiss/.cortextos/cortextos-staging-fw/orgs/clearworksai/agents/tlab-codex/memory/handoffs/handoff-staging.md

# state/tlab-codex/context_status.json  (bridge reset so the new session does not re-fire)
{"used_percentage":0,"exceeds_200k_tokens":false,"written_at":"2026-08-11T00:11:17.606Z"}
```

Routes through the SAME `planContextHardRestart` marker contract the fast-checker
uses. The `.handoff-doc-path` points at the most-recent handoff doc on disk, so the
fresh thread re-injects mission continuity (no live LLM turn required — a full thread
cannot turn) — NEVER a blank thread. The app-server pty is killed so the restart
goes to a FRESH `thread/start`.

- Non-context error (`MCP transport closed`) → NO `.force-fresh`, NO kill (no false restart).
- Loop guard: 4 context-window failures in 5min → exactly 2 recoveries fired (persisted `codex-context-recoveries.json`, cap 2).

## Result

**PASS** — both deadlock-breaker (A) and safety-net (B) behaviors verified end-to-end
against the real shipped code on the pinned staging instance, with the good
mission-anchor/handoff continuity preserved (never a blank thread).

## Seam

Staging drives the pty class + on-disk marker contract directly (the deterministic,
load-safe surface). It does not spin the full staging daemon+agent lifecycle (fleet is
load-sensitive; a real resumed-full-thread requires a genuinely context-exhausted
codex thread). The daemon wiring (`AgentProcess.setContextRecoveryHandler` →
`sessionRefresh()`, and FastChecker's `resume_rollout` grace bypass) is covered by the
unit suites `tests/unit/daemon/agent-process-codex-app-server.test.ts` and
`tests/unit/daemon/fast-checker.test.ts` (all green).
