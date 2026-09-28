# Upstream catch-up handoff (stop mid Task 7 / before Task 8)

Written 2026-09-28 during an open `--no-ff --no-commit` merge. Merge not committed. Merge not aborted. No `git add` of remaining unmerged paths. No push/PR.

Continuation of `task_1790616896855_81108022` after Tasks 5–7 worktree edits. Stopped before restaging, full Task 8 gate, and merge commit.

## Open merge / index state

| Item | Value |
|---|---|
| Worktree | `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380` |
| Git dir | `/Users/joshweiss/code/cortextos/.git/worktrees/upstream-integration-6f938380` |
| Branch | `integrate/upstream-6f938380-20260928` |
| `HEAD` (ours / first parent candidate) | `bba3fefb9e83963d50ea1df8737ff75be347b953` (`docs(upstream): freeze catch-up baseline`) |
| `HEAD^` / origin/main pin | `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` |
| `MERGE_HEAD` (theirs / pinned upstream) | `6f9383809f7b87a15e9819f83f9a7f147b202883` |
| Merge base | `a15baad45cde344f97468ce1b8fe1d012125a415` |
| `MERGE_MODE` | `no-ff` |
| Merge transaction | open (`MERGE_HEAD` present). No merge commit. |
| Unmerged paths | **24** (index still has both stages) |
| Conflict markers in those 24 | **0** (`<<<<<<< HEAD` count is zero on every unmerged path) |
| Local-only `main` | still excluded (`c544b9d1646d0b192d1589c19a4b9ef5ee1df186`) |

`src/cli/bus.ts` remains **`MM`** (Task 4 staged union + unstaged closer-brace repair). Keep the worktree side.

Also **`MM`**: `src/types/index.ts` (Task 5 added `AgentConfig.connector`), `src/utils/lock.ts` (`withFileLockAsync` now releases a `LockHandle`).

Also unstaged (not unmerged): `src/cli/slack.ts`, `src/slack/dispatcher.ts`, `tests/unit/slack/api.test.ts`. `src/connectors/telegram/api.ts` is **`AM`** (index add + worktree NUL/editMessageText port).

## Remaining unmerged files (24) — edited in worktree, not staged

### Task 5 runtime (UU)

- `src/daemon/agent-manager.ts`
- `src/daemon/agent-process.ts`
- `src/daemon/cron-scheduler.ts`
- `src/daemon/fast-checker.ts`
- `src/daemon/ipc-server.ts`
- `src/pty/opencode-pty.ts`

Keep-both concatenation was **discarded**. Files restored from `HEAD`, then MessageConnector wired in. **Do not `git add` until D-06 Hermes force-fresh tests are green** (see failures below). `cron-scheduler.ts` / `ipc-server.ts` / `opencode-pty.ts` match fork intent (receipts, REQUIRES_RESUME / lifecycle IPC, confirmed-dead stale reap).

### Task 6 connectors (AA/UU)

- `bus/send-slack.sh` (AA) — worktree = `HEAD` (agent `slack test-send --as`)
- `docs/runbook/slack-adapter-setup.md` (AA) — worktree = `HEAD`
- `src/buzz/relay-client.ts` (AA) — `HEAD` + native `WebSocket` guard + `pendingAuthChallenge.reject` on close
- `src/slack/api.ts` (AA) — union (not wholesale theirs)
- `src/telegram/api.ts` (UU) — still 2-line shim to `connectors/telegram/api.js`
- `src/telegram/logging.ts` (UU) — shim
- `src/telegram/poller.ts` (UU) — shim

Fork org-level Slack Socket Mode (`SlackSocketModeClient` + `dispatchSlackMessage`) kept. Upstream per-agent `SlackSocketListener` not adopted as the daemon owner.

### Task 7 tests (UU/AA) — markers gone, parse/union incomplete

- `tests/unit/bus/message.test.ts` (UU)
- `tests/unit/bus/task.test.ts` (UU)
- `tests/unit/buzz/relay-client.test.ts` (AA)
- `tests/unit/cli/add-agent-codex.test.ts` (UU)
- `tests/unit/cli/restart-command.test.ts` (UU)
- `tests/unit/daemon/agent-manager-inspect-op.test.ts` (UU)
- `tests/unit/daemon/agent-manager-map-entry-race.test.ts` (AA)
- `tests/unit/daemon/agent-process.test.ts` (UU) — **parse EOF** (see below)
- `tests/unit/daemon/cron-scheduler.test.ts` (UU)
- `tests/unit/daemon/fast-checker-buzz.test.ts` (AA)
- `tests/unit/daemon/fast-checker.test.ts` (UU) — **parse EOF** (see below)

## Source semantic decisions (this continuation)

Inherited D-01–D-09 unchanged. Lifecycle-lock `task_1790523877491_88723390` and env/fixture `task_1790567331489_62632638` **not claimed fixed**.

| Decision | Choice |
|---|---|
| D-06 base | Restore `HEAD` daemon/PTY; do not accept keep-both concat. |
| D-06 + D-04 Telegram | `config.connector === 'none'` → `NullConnector`. Else build `TelegramConnector` first, `rawTelegramApi()` for legacy poller/handle (one shared API). `setConnector` on `AgentProcess`; optional `connector` on `FastChecker`; `stopPolling()` on poller/checker teardown. Keep constructing `TelegramPoller` in the daemon (connector `startPolling` unused, matching upstream PR1). |
| D-04 Slack topology | Keep fork org-level singleton socket + dispatcher. Do not switch `startAgent` to per-agent `SlackSocketListener`. |
| D-06 cron/IPC/PTY | Keep fork `cron-scheduler` receipts/abort, fork IPC resume/mode/`probeAvailability`, fork opencode confirmed-dead stale reap. |
| Slack API | Union: `postMessage(PostMessageRequest)` (fork CLI) **and** `postMessage(channel, text, identity?)` (persona gate + SSN redact). `getUserInfo` returns `{ handle, displayName, id, name, real_name }`. `listChannels(memberOnly = true)` upstream default; fork pagination test calls `listChannels(false)`. |
| Telegram HTML | Port fork NUL/code-span `markdownToHtml` + 5-arg `editMessageText` into `src/connectors/telegram/api.ts`; keep upstream Happy Eyeballs. |
| Buzz | Fork client + upstream Node-`WebSocket` missing guard + reject waiter on socket close (reconnect hang). |
| `send-slack.sh` / Slack runbook | Keep fork (identity `--as` wrapper). Upstream `bus send-slack` already lives in CLI. |
| `AgentConfig.connector` | Added `'telegram' \| 'none'` (was missing from Task 4 types). |
| `withFileLockAsync` | Release `LockHandle` from `acquireLock`, matching `withFileLockSync`. Compile union only — **not** the stale-handle identity remediation. |
| D-08 tests | Strip markers by union. `task.test.ts`: keep ours (priority filters + fleet health). `message.test.ts`: both import sets (deduped). `add-agent-codex`: both `comms-check-worker` and `cortext-self-diagnosis` contains. `restart-command`: IPC mocks first, then `requestSerializedRestart` **and** disable-resurrection tests. `inspect-op`: live `process.pid` + `checker.stop`. `map-entry-race` / buzz mock: `setConnector` / `injectMessageDetailed`. `cron-scheduler` tests: keep ours outcome mocks. `fast-checker-buzz`: detailed inject **and** Telegram-before-Buzz order. |
| Hermes force-fresh (open) | Fork `shouldContinue` still lets Hermes `state.db` win over `.force-fresh`. Auto-merged hermes tests require marker-first `fresh` + consume-after-spawn. **Not resolved this turn.** |

## TypeScript

Last full `src/` check: `npx tsc --noEmit --pretty false` → **exit 0**, empty `/tmp/tsc-src.txt` (no diagnostics). `tsconfig.json` excludes `tests/`.

Prior filtered daemon/PTY check after restore+connector wiring was also clean. Three earlier errors (`agent-manager` Slack user-info shape, `telegram-streamer` 5-arg `editMessageText`, `cli/slack` `is_member`, `lock.ts` `releaseLock(dir)`) were fixed in worktree before this tsc.

## Focused Task 5 vitest (`/tmp/t5-vitest.txt`)

Command (temp `CTX_ROOT`; output must not dump inherited env): `npx vitest run tests/unit/daemon/agent-manager*.test.ts tests/unit/daemon/agent-process*.test.ts tests/unit/daemon/cron-scheduler.test.ts tests/unit/daemon/fast-checker*.test.ts tests/unit/pty/*.test.ts tests/unit/utils/dormancy.test.ts`

Summary: **3 files failed, 34 passed (37). Tests: 5 failed, 460 passed (465).** Duration 13.28s.

Two **suite transform** failures (not in the 5-test count):

1. `tests/unit/daemon/agent-process.test.ts` — oxc `Expected '}' but found EOF` at line 1148 (opened ~1126). Cause: duplicate death-confirmed `describe` deleted with an off-by-one splice after D-08 concat.
2. `tests/unit/daemon/fast-checker.test.ts` — same EOF at line 2799 (opened describe at 2081). Cause: D-08 both-sides concat of the large third hunk left an unclosed `describe`.

**Exact five failed tests** (all `tests/unit/daemon/agent-process-hermes.test.ts` > `AgentProcess - Hermes runtime: shouldContinue`). Assertion payloads included continue-mode prompt text; that body is omitted here (not env, still not reproduced):

1. `honors the .force-fresh marker even when Hermes state.db exists` — `mockPty.spawn` called with `'continue'`, expected `'fresh'`; `mockHermesDbExists` was consulted.
2. `does NOT consume .force-fresh when pty.spawn() FAILS` — same `'continue'` vs `'fresh'` (marker never selected mode).
3. `does NOT consume .force-fresh when the PTY exits DURING spawn` — same `'continue'` vs `'fresh'`.
4. `TIMING: still consumes the marker when it is UNCHANGED across spawn` — `state.marker` still `{ ino: 100, mtimeMs: 1000, size: 10 }`, expected `null`.
5. `TOCTOU: a request landing at the exact unlink instant survives (atomic rename-reserve)` — `adversaryFired` was `false` (interleave never ran).

Root cause for 1–5: fork `shouldContinue` returns Hermes `hermesDbExists()` **before** treating a reserved `.force-fresh` as `continueSession: false`. Consume-after-spawn / rename-reserve identity is therefore never exercised on this path.

## Fixture restoration evidence

After the vitest run, tracked `.cortextOS/state/agents/{alice,bob}/crons.json` (+ `.bak`) were dirty (same leakage class as `task_1790567331489_62632638`). Restore: `git restore --source=HEAD -- .cortextOS/state/agents/alice/crons.json .cortextOS/state/agents/bob/crons.json` (and `git checkout --` of those paths).

Now: `git diff --exit-code -- .cortextOS/state/agents/alice/crons.json .cortextOS/state/agents/bob/crons.json` succeeds (match `HEAD`). `.bak` copies still exist on disk as ignored local leftovers from the run (mtime 11:12); they are not in `git status --porcelain`. Do not treat that as closing the fixture-remediation task.

## Next repair command

This worktree only. Do not `git add` unmerged paths. Do not abort. Do not print env.

1. Close the two test-file braces (`agent-process.test.ts`, `fast-checker.test.ts`) so oxc parses — restore `HEAD` test file and re-apply only the union additions if concat is still unclosed.
2. Honor D-06 matrix row **force-fresh consume-after-spawn for Hermes**: marker-first `fresh` even when `state.db` exists; consume only after successful spawn (fork `importFreshRequest` / `restoreFreshRequest` or upstream probe+`deleteForceFreshMarker` — pick the contract the hermes tests already pin). That is **not** the lifecycle-lock task.
3. Re-run focused tests with a throwaway root, then restore any leaked `crons.json`:

```bash
export CTX_ROOT="$(mktemp -d)"
npx vitest run \
  tests/unit/daemon/agent-process.test.ts \
  tests/unit/daemon/fast-checker.test.ts \
  tests/unit/daemon/agent-process-hermes.test.ts \
  --reporter=dot
git restore --source=HEAD -- \
  .cortextOS/state/agents/alice/crons.json \
  .cortextOS/state/agents/bob/crons.json
rm -rf "$CTX_ROOT"
```

Then finish remaining Task 6/7 staging (still no merge commit), then Task 8 gate. No push/PR, no main, no deploy.

## Exclusions (still binding)

No shared checkout or other worktree changes; no `merge --abort`; no cherry-picks; no local-main-only specs; no live state/deploy/restart; no push/PR; no direct `main`; no final merge commit until Task 8; do not mask lifecycle-lock or environment/fixture remediation tasks.
