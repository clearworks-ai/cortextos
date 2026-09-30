# Upstream catch-up handoff (stop after Task 4)

Written 2026-09-28 during an open `--no-ff --no-commit` merge. Merge not committed. Merge not aborted.

## Open merge state

| Item | Value |
|---|---|
| Worktree | `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380` |
| Branch | `integrate/upstream-6f938380-20260928` |
| `HEAD` (ours / first parent candidate) | `bba3fefb9e83963d50ea1df8737ff75be347b953` (`docs(upstream): freeze catch-up baseline`) |
| `MERGE_HEAD` (theirs / pinned upstream) | `6f9383809f7b87a15e9819f83f9a7f147b202883` |
| Pin origin/main (pre-baseline) | `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` |
| Merge base | `a15baad45cde344f97468ce1b8fe1d012125a415` |
| Merge transaction | open (`MERGE_HEAD` present). No merge commit. |
| Unmerged paths | **24** |
| Conflict markers in those 24 | **11 test files still have `<<<<<<< HEAD`**. **13 runtime/docs files have 0 markers** but are still unmerged (keep-both / shim writes not `git add`ed). |

`src/cli/bus.ts` is `MM` (staged Task 4 union, then unstaged closer-brace repair). Do not discard the worktree side.

## Remaining unmerged files (24)

### Task 5 runtime (markers gone, not staged)

- `src/daemon/agent-manager.ts` (UU)
- `src/daemon/agent-process.ts` (UU)
- `src/daemon/cron-scheduler.ts` (UU)
- `src/daemon/fast-checker.ts` (UU)
- `src/daemon/ipc-server.ts` (UU)
- `src/pty/opencode-pty.ts` (UU)

Naive keep-both concatenation was applied in-worktree. Index still has both stages. **Do not `git add` until `tsc` is clean and D-06 matrix rows are checked.** Concatenation can duplicate declarations.

### Task 6 connectors (markers gone, not staged)

- `bus/send-slack.sh` (AA)
- `docs/runbook/slack-adapter-setup.md` (AA)
- `src/buzz/relay-client.ts` (AA)
- `src/slack/api.ts` (AA) — worktree = `MERGE_HEAD` copy
- `src/telegram/api.ts` (UU) — worktree = upstream 2-line shim
- `src/telegram/logging.ts` (UU) — shim
- `src/telegram/poller.ts` (UU) — shim

Connector implementation lives in auto-merged `src/connectors/**`. Fork `HEAD` `src/telegram/api.ts` NUL/code-span hardening is **not** in `src/connectors/telegram/api.ts` (Happy Eyeballs is). Port before calling Telegram done.

### Task 7 tests (markers remain)

- `tests/unit/bus/message.test.ts` (1 hunk)
- `tests/unit/bus/task.test.ts` (2)
- `tests/unit/buzz/relay-client.test.ts` (1)
- `tests/unit/cli/add-agent-codex.test.ts` (3)
- `tests/unit/cli/restart-command.test.ts` (1)
- `tests/unit/daemon/agent-manager-inspect-op.test.ts` (1)
- `tests/unit/daemon/agent-manager-map-entry-race.test.ts` (1)
- `tests/unit/daemon/agent-process.test.ts` (1)
- `tests/unit/daemon/cron-scheduler.test.ts` (2)
- `tests/unit/daemon/fast-checker-buzz.test.ts` (3)
- `tests/unit/daemon/fast-checker.test.ts` (3)

## Completed decisions / edits

### Task 1 (committed)

- Pins held after `git fetch origin` + HTTPS fetch of `grandamenium/cortextos` into `refs/remotes/upstream/main` (SSH to upstream denied; git config unchanged).
- Plan copied from `897653bfd48d0cc639d3f5d1f77406e65c35f140` to `docs/pipeline/plans/2026-09-28-upstream-catchup.md`.
- Evidence: `docs/pipeline/evidence/2026-09-28-upstream-baseline.md`.
- Commit: `bba3fefb` `docs(upstream): freeze catch-up baseline`.

### Task 2

- `git merge --no-ff --no-commit 6f9383809f7b87a15e9819f83f9a7f147b202883` opened.
- Live unmerged set was **44**, not plan **46**. Auto-merged (D-07 still applies): `templates/agent/CLAUDE.md`, `templates/orchestrator/CLAUDE.md`. No extra unexpected conflicts. Run continued.

### Task 3 (staged, not a merge commit)

- `.gitignore`: union (keep fork pycache ignores + upstream leakage-fixture globs).
- `community/catalog.json`: keep fork `cortext-self-diagnosis` 1.1.0 entry.
- `community/skills/cortext-self-diagnosis/**`: `--ours` (richer fork).
- `templates/{agent,orchestrator}/AGENTS.md`: D-07 keep lazy `AGENTS-REFERENCE.md`; quote `date -u +'%H:%M UTC'`.
- `package.json`: auto-merged `schemas/` + `ajv`; lockfile regenerated.
- Copied `templates/agent/.claude/skills/comms-check-worker/SKILL.md` → `templates/agent-opencode/plugins/cortextos-agent-skills/skills/comms-check-worker/SKILL.md` (parity gap `comms-check-worker`).

### Task 4 (sources resolved; bus.ts closer repair unstaged)

- `src/types/index.ts`: ours + append `TrustLevel` / `VALID_TRUST_LEVELS` / `TeamMember`.
- `src/utils/atomic.ts`: union fs imports (symlink-aware + `atomicWriteDurableSync` fsync).
- `src/bus/heartbeat.ts`: both `enabled-agents-io` and `withFileLockSync`.
- `src/bus/cron-state.ts`: fork per-file lock dir + `keepBak` + atomic write.
- `src/bus/task.ts`: keep fork forced-complete, priority arrays, class/openOnly.
- `src/cli/add-agent.ts`, `restart.ts`, `status.ts`: keep ours (optional instance; serialized restart; supervised status).
- `src/cli/buzz.ts`: add upstream native `WebSocket` guard.
- `src/cli/index.ts`: instance + slack + lifecycle + `CORTEXTOS_VERSION`.
- `src/cli/bus.ts`: keep fork list-tasks/table/heartbeat try/catch; skip duplicate `fmtTs`/`signalCronReload`; keep fork scope-guard/memory-lint/memory-correctness **and** upstream send-slack / slack-test-send / slack-discover-channels. Then patched cut-off `memory-lint` / `memory-correctness` closers (worktree vs index: `MM`).

### Partial Task 5/6 worktree writes (not staged)

- Keep-both hunk concat: daemon + `opencode-pty` + `buzz/relay-client` + `send-slack.sh` + slack runbook.
- `git show MERGE_HEAD` onto telegram shims and `src/slack/api.ts`.

Do not treat keep-both as D-06 acceptance. Review/compile before add.

## Test results

| Gate | When | Result |
|---|---|---|
| `npm ci` / dashboard `npm ci` | Task 1 | pass |
| `npm run typecheck` / `npm run build` | Task 1 on pinned fork | pass |
| `npm test` | Task 1 | **fail inherited**: 2 tests in `tests/unit/daemon/fast-checker.test.ts` (timeout 937; `execMock` not-called 978). Secret-shaped env dump in assertion; log shredded. Owner: `task_1790567331489_62632638`. Not claimed fixed. |
| Tracked fixture mutation | after Task 1 `npm test` | alice/bob `crons.json` + `.bak` (+1/-1 each). Restored. Same leakage task. |
| `npm run test:codex` | Task 1 | pass (6 files / 48 tests) |
| dashboard `tsc` + `npm run build` | Task 1 | pass |
| leak-guard tree + `tests/leak-guard.test.sh` | Task 1 | pass |
| template vitest | Task 3, before opencode skill copy | 2 failed: `comms-check-worker` missing from opencode. Copy done; **not re-run**. |
| dashboard `tsc` mid-merge | Task 3 | failed: markers in then-unmerged `src/types/index.ts` |
| `npx tsc --noEmit` after Task 4 sources, before keep-both | | 212 lines, almost all remaining conflict markers; `src/cli/bus.ts(5429): '}' expected` (later closer-patched in worktree) |
| Task 4/5 targeted vitest | | **not run** |
| Node 20 / 24 lifecycle matrix | | **not run** (host Node v22.22.3 only) |

Lifecycle-lock `task_1790523877491_88723390` not accepted here.

## Cancelled command (no effects)

After the keep-both / shim writes, the next command (intended follow-up: typecheck and/or `git add` of daemon union) was **cancelled**. It did not run. Effects: none. Still 24 unmerged paths; no merge commit; no `--abort`; no push.

## Next Task 5 action

Plan Task 5 seam M-03. First command, in this worktree only:

```bash
npx tsc --noEmit --pretty false 2>&1 | rg 'src/daemon/|src/pty/opencode-pty'
```

Then repair keep-both concatenation against D-06 (dead-map restart, disabled no-resurrection, duplicate-start idempotency, force-fresh consume-after-spawn, OpenCode exit-0 wedge, confirmed-dead stale reap, dormancy, death-confirmed stop, exact poller/connector teardown). Do not wholesale ours/theirs. Do not `git add` daemon files until that slice typechecks. Then:

```bash
npx vitest run \
  tests/unit/daemon/agent-manager*.test.ts \
  tests/unit/daemon/agent-process*.test.ts \
  tests/unit/daemon/cron-scheduler.test.ts \
  tests/unit/daemon/fast-checker*.test.ts \
  tests/unit/pty/*.test.ts \
  tests/unit/utils/dormancy.test.ts
```

Task 6/7 files stay unmerged until their slices. No push, no PR, no main merge.
