# Upstream catch-up baseline

Frozen 2026-09-28T17:50:30Z on `integrate/upstream-6f938380-20260928`.

## SHA ledger

| Ref | SHA | Result |
|---|---|---|
| `HEAD` / first parent | `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` | pin held after `git fetch origin` |
| `origin/main` | `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` | pin held |
| `upstream/main` | `6f9383809f7b87a15e9819f83f9a7f147b202883` | pin held after HTTPS fetch into `refs/remotes/upstream/main` |
| merge-base | `a15baad45cde344f97468ce1b8fe1d012125a415` | pin held |
| plan artifact source | `897653bfd48d0cc639d3f5d1f77406e65c35f140` | copied to `docs/pipeline/plans/2026-09-28-upstream-catchup.md` |

`git fetch` of `upstream` via `git@github.com:` failed (`Permission denied (publickey)`). Fetched `https://github.com/grandamenium/cortextos.git` `+refs/heads/main:refs/remotes/upstream/main` instead. Git config was not changed.

Local-only `main` `c544b9d1646d0b192d1589c19a4b9ef5ee1df186` remains unmerged.

## Environment

- Node: v22.22.3 (plan asks Node 20 + 24 for lifecycle matrix; those binaries are not installed in this worktree host)
- npm: 10.9.8
- Host: darwin arm64
- Worktree: `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380`

## Pre-merge conflict inventory (`git merge-tree --write-tree`)

Live inventory at the pinned SHAs: **44** textual conflicts.

Plan listed **46**. The two extras auto-merge:

- `templates/agent/CLAUDE.md`
- `templates/orchestrator/CLAUDE.md`

Those two will still be reviewed under D-07 after the merge opens. No unexpected extra conflict files.

Exact 44:

```
.gitignore
bus/send-slack.sh
community/catalog.json
community/skills/cortext-self-diagnosis/SKILL.md
community/skills/cortext-self-diagnosis/references/surface-map.md
community/skills/cortext-self-diagnosis/references/symptom-playbooks.md
community/skills/cortext-self-diagnosis/references/test-matrix.md
community/skills/cortext-self-diagnosis/scripts/pr_gate.py
docs/runbook/slack-adapter-setup.md
src/bus/cron-state.ts
src/bus/heartbeat.ts
src/bus/task.ts
src/buzz/relay-client.ts
src/cli/add-agent.ts
src/cli/bus.ts
src/cli/buzz.ts
src/cli/index.ts
src/cli/restart.ts
src/cli/status.ts
src/daemon/agent-manager.ts
src/daemon/agent-process.ts
src/daemon/cron-scheduler.ts
src/daemon/fast-checker.ts
src/daemon/ipc-server.ts
src/pty/opencode-pty.ts
src/slack/api.ts
src/telegram/api.ts
src/telegram/logging.ts
src/telegram/poller.ts
src/types/index.ts
src/utils/atomic.ts
templates/agent/AGENTS.md
templates/orchestrator/AGENTS.md
tests/unit/bus/message.test.ts
tests/unit/bus/task.test.ts
tests/unit/buzz/relay-client.test.ts
tests/unit/cli/add-agent-codex.test.ts
tests/unit/cli/restart-command.test.ts
tests/unit/daemon/agent-manager-inspect-op.test.ts
tests/unit/daemon/agent-manager-map-entry-race.test.ts
tests/unit/daemon/agent-process.test.ts
tests/unit/daemon/cron-scheduler.test.ts
tests/unit/daemon/fast-checker-buzz.test.ts
tests/unit/daemon/fast-checker.test.ts
```

## Gate ledger

| Gate | Result | Counts / notes |
|---|---|---|
| `npm ci` | pass | 144 packages audited |
| `npm ci --prefix dashboard` | pass | 831 packages audited |
| `npm run typecheck` | pass | |
| `npm run build` | pass | tsup target node20 |
| `npm test` | fail (inherited) | Test files 1 failed / 300 passed / 3 skipped. Tests 2 failed / 4159 passed / 27 skipped / 5 todo. Duration 195.73s |
| `npm run test:codex` | pass | 6 files, 48 tests, 1.54s |
| `dashboard` `tsc --noEmit` | pass | |
| `dashboard` `npm run build` | pass | Next.js 16.2.4; inherited Turbopack warnings |
| `leak-guard.sh --tree HEAD` | pass | clean |
| `tests/leak-guard.test.sh` | pass | PASS |

`git status --porcelain` before tests: empty.

## Inherited failures (not absorbed)

Owner: environment/fixture leakage `task_1790567331489_62632638`. Not claimed fixed.

1. `tests/unit/daemon/fast-checker.test.ts` heartbeat watchdog: "two agents with different identities each write under their own context, not a shared/inherited one" — timeout 10000ms at line 937.
2. Same file: "does not start an ambiguously-attributed watchdog when the agent context mismatches the checker paths" — `expect(execMock).not.toHaveBeenCalled()` failed; mock called twice. Failure serialization included inherited process env (secret-shaped). Log shredded after extracting titles.

Tracked fixture mutation after `npm test` (restored, not committed):

- `.cortextOS/state/agents/alice/crons.json` (+1/-1)
- `.cortextOS/state/agents/alice/crons.json.bak` (+1/-1)
- `.cortextOS/state/agents/bob/crons.json` (+1/-1)
- `.cortextOS/state/agents/bob/crons.json.bak` (+1/-1)

Untracked `.data/cortextos-default.db*` appeared; removed. Worktree restored to pinned tree before later gates.

Lifecycle-lock stale-handle `task_1790523877491_88723390` not exercised as a new pass/fail here.

## Decision

Baseline is reproducible at the pinned SHAs. The two `npm test` failures and fixture mutation are inherited and routed to the existing leakage task. Opening the merge transaction is allowed under the execution instruction to continue inherited unrelated failures with bounded evidence.
