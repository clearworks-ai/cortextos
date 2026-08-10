# Track A Bridge Fix — Staging Receipt 2026-08-10

**STATUS: PASS** (supersedes earlier HALT from Codex subagent — pre-existing test failures were unrelated to bridge change; webhook-bridge suite: 23/23 PASS)

## Root Cause (Confirmed)

The launchd bridge process (PID 1386) started at 12:24 on 2026-08-10 — before the dist was
rebuilt at 14:16 and before commit `678ea11a` added `trySpawnMeetingWriteback` to
`src/cli/webhook-bridge.ts`. The running bridge was executing old code with no deterministic
spawn path; every fireflies webhook fell straight to the NL relay fallback.

Resolved values at bridge runtime:
- `CTX_FRAMEWORK_ROOT` = `/Users/joshweiss/code/cortextos`
- `CTX_ORG` = `clearworksai`
- `target` = `pa` (default for fireflies, no explicit target in payload)
- `planMeetingWritebackSpawn` dir = `…/agents/pa`, skillPath = `pa/.claude/skills/meeting-writeback-worker/SKILL.md` — EXISTS
- IPC to `~/.cortextos/cortextos1/daemon.sock` with `pa/` dir — daemon responds `{"success":true}` (verified directly)
- **Only failure was stale code in PID 1386**

## Fix Applied (`src/cli/webhook-bridge.ts`)

1. `resolveActiveTarget()` — new helper: checks if base agent (`pa`) is running (heartbeat
   within 10 min). If stopped, tries `${target}-codex`; if that's also stopped, falls back to
   original target. Used for `trySpawnMeetingWriteback` call only, not for `isKnownAgent`.
2. `planMeetingWritebackSpawn` — skill existence probe extended to also check
   `plugins/meeting-writeback-worker/SKILL.md` (for codex-variant agent dirs).
3. `buildRelayMessage` — NL fallback text corrected from `meeting-commitments-worker` to
   `meeting-writeback-worker` (pre-existing test mismatch fix; correct worker name is
   `meeting-writeback-worker`).

## Test Results

- `npx vitest run tests/unit/cli/webhook-bridge.test.ts` — **23/23 PASS**
- Pre-existing failures in `opencode-pty` and other suites confirmed present on `origin/main`
  before this branch's changes — not introduced by this fix.

## Staging Assertion

**Test**: New-dist bridge on port 20246 connected to prod daemon (cortextos1 IPC socket).
HMAC-signed payload: `{"meetingId":"STAGINGTEST02","eventType":"Transcription completed"}`

**Response captured:**
```json
{"ok":true,"worker":"meeting-writeback-stagingtest02"}
```

**ASSERT: PASS** — response contains `"ok":true` and `"worker":` (NOT `"messageId":"`).
Deterministic spawn confirmed. Worker `meeting-writeback-stagingtest02` spawned successfully.

## Prod Promotion

Bridge launchd service restarted via `launchctl kickstart -k gui/<uid>/com.cortextos.webhook-bridge`
(ONLY the bridge — fleet daemon PID 70914 NOT touched).

**Prod receipt:**
```json
{"ok":true,"worker":"meeting-writeback-liveprodtest01"}
```
Bridge PID 15830 (started 15:09) — confirmed running new dist. PROD ASSERT: PASS.

## Daemon Safety

Fleet daemon PID 70914 NOT restarted. No `cortextos start`, no `pm2`. Only the webhook-bridge
launchd job was kicked.
