# Upstream catch-up handoff (pre Task 8 gate)

Written 2026-09-28. Open `--no-ff --no-commit` merge. Merge not committed. Merge not aborted. **Stop before Task 8 full gate and before the merge commit.**

Worker: `task_1790616896855_81108022`.

## Parents

| Item | Value |
|---|---|
| Worktree | `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380` |
| Git dir | `/Users/joshweiss/code/cortextos/.git/worktrees/upstream-integration-6f938380` |
| Branch | `integrate/upstream-6f938380-20260928` |
| `HEAD` (ours) | `bba3fefb9e83963d50ea1df8737ff75be347b953` |
| `HEAD^` / origin/main pin | `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` |
| `MERGE_HEAD` (theirs) | `6f9383809f7b87a15e9819f83f9a7f147b202883` |
| Merge base | `a15baad45cde344f97468ce1b8fe1d012125a415` |
| `MERGE_MODE` | `no-ff` |
| Local-only `main` | excluded (`c544b9d1646d0b192d1589c19a4b9ef5ee1df186`) |

## 24 conflict paths — resolved, stage 0

`git ls-files -u` empty. Each of the original 24 has exactly one stage-0 index entry. `git grep` has **0** `<<<<<<<` / `>>>>>>>`.

Cached diff vs `HEAD` lists **160** paths. Seven of the 24 match `HEAD` exactly (keep-ours / D-06–D-07), so they do not appear in `git diff --cached --name-only`:

- `bus/send-slack.sh`
- `docs/runbook/slack-adapter-setup.md`
- `src/daemon/cron-scheduler.ts`
- `src/daemon/ipc-server.ts`
- `src/pty/opencode-pty.ts`
- `tests/unit/bus/task.test.ts`
- `tests/unit/daemon/cron-scheduler.test.ts`

The other 17 are in the 160-path cached set. Re-`git add` of all 24 this turn did not change product blobs.

Worktree after fixture restore: **0 unstaged**, **0 untracked**.

## Focused failures (closed this merge; not re-run this stop)

Original five Hermes force-fresh titles — all green in `/tmp/t5-repair2.txt` after D-06 probe + consume-after-success in `src/daemon/agent-process.ts`:

1. honors the `.force-fresh` marker even when Hermes `state.db` exists
2. does NOT consume `.force-fresh` when `pty.spawn()` FAILS
3. does NOT consume `.force-fresh` when the PTY exits DURING spawn
4. TIMING: still consumes the marker when it is UNCHANGED across spawn
5. TOCTOU: a request landing at the exact unlink instant survives (atomic rename-reserve)

Parse blockers closed: `tests/unit/daemon/agent-process.test.ts` (missing `it`/`describe` closers), `tests/unit/daemon/fast-checker.test.ts` (missing `it` closer; upstream FastChecker describes moved under `describe('FastChecker')`; exclusive DEDUPED / futile-baseline / unsupervised re-queue tests dropped per D-08 vs fork Task 4.1 + supervised NOT_RUNNING).

## Exact focused results (already collected; this stop did not re-run them)

| Gate | Log | Result |
|---|---|---|
| `npx tsc --noEmit --pretty false` after repairs | — | exit 0 |
| Repair: `agent-process.test.ts`, `fast-checker.test.ts`, `agent-process-hermes.test.ts`, `lifecycle-legacy-compat.test.ts` | `/tmp/t5-repair2.txt` | **4 files / 182 tests passed** (75.71s) |
| Task 5 glob (daemon/PTY/dormancy + lifecycle-legacy-compat) | `/tmp/t5-suite.txt` | **37 files passed, 1 file failed (38). Tests 635 passed, 1 failed (636)** (72.67s) |
| Telegram + connectors after splitHtml / poller abort / test dedupe | `/tmp/t6-tg.txt` | **12 files / 149 tests passed** (15.64s) |
| `add-agent-codex.test.ts` + `restart-command.test.ts` after skill-count 25 + `waitForAgentSettled` mock | `/tmp/t7-cli.txt` | **2 files / 17 tests passed** (871ms) |
| Staged leak-guard | — | `leak-guard: clean` |
| `npm ci` / dashboard `npm ci` / `npm run typecheck` / `npm run build` | Task 8 start | all exit 0 **before** interrupted `npm test` |

### Residual from Task 5 focused glob (not a 24-path hunk)

`tests/unit/pty/pty-host-dispose.test.ts` → `CONTROL — the old semantics (bare SIGKILL on the host) orphans the grandchild`: expected `orphaned === true`, got `false` on Darwin Node v22.22.3. CONTROL characterization of *old* host-only SIGKILL; kernel/node-pty here kills the grandchild. **Not** lifecycle-lock `task_1790523877491_88723390`. **Not** env/fixture `task_1790567331489_62632638`. Linux Node 20/24 100× runner not run.

### Not run / interrupted

Full `npm test` was interrupted (~11:40; partial `/tmp/t8-npm-test.txt`). **No pass/fail count.** `npm run test:codex`, dashboard `tsc`/`build`, `bash tests/leak-guard.test.sh`, `node dist/cli.js --help` **not run**.

## Fixtures / data (this stop)

Restored from `HEAD` (exit 0):

- `.cortextOS/state/agents/alice/crons.json`
- `.cortextOS/state/agents/alice/crons.json.bak`
- `.cortextOS/state/agents/bob/crons.json`
- `.cortextOS/state/agents/bob/crons.json.bak`

Removed untracked generated `.data/`. Leakage class still owned by `task_1790567331489_62632638` (not claimed fixed).

## Exact Task 8 command (plan; **do not run from this stop**)

Fingerprint:

```bash
git diff --name-only > /tmp/pre-test-worktree.txt
git diff --cached --name-only > /tmp/pre-test-index.txt
```

Release gate:

```bash
npm ci
npm ci --prefix dashboard
npm run typecheck
npm run build
npm test
npm run test:codex
(cd dashboard && npx tsc --noEmit && npm run build)
bash tests/leak-guard.test.sh
node dist/cli.js --help
```

Staged payload (before any merge commit):

```bash
git diff --cached --name-only --diff-filter=ACMR -z | \
  xargs -0 .github/scripts/leak-guard.sh
```

Then write `docs/pipeline/evidence/2026-09-28-upstream-merge-verification.md` and:

```bash
git add -f docs/pipeline/evidence/2026-09-28-upstream-merge-verification.md
git commit -m "merge(upstream): reconcile through 6f938380"
test "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = 3
test "$(git rev-parse HEAD^2)" = 6f9383809f7b87a15e9819f83f9a7f147b202883
bash .github/scripts/leak-guard.sh --tree HEAD
```

Required parents of that commit: `bba3fefb9e83963d50ea1df8737ff75be347b953` and `6f9383809f7b87a15e9819f83f9a7f147b202883`.

## Exclusions

No Task 8 re-run, no merge commit, no push/PR, no `--abort`, no other worktree, no live deploy/restart. Lifecycle-lock and env/fixture remediation stay with `task_1790523877491_88723390` and `task_1790567331489_62632638`.
