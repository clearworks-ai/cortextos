# Upstream review-repair handoff (context boundary — no gate, no commit)

Written 2026-09-28T19:41:00Z. Worktree `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380`.
Worker `task_1790616896855_81108022`. Branch `integrate/upstream-6f938380-20260928`. Canonical `clearworks-ai/cortextos`.
**No full gate. No commit. No push.** No focused check still running at this write.

## Merge (intact)

| Ref | SHA |
|---|---|
| HEAD | `24280d2e239eee5d1855aaff089c2b3cb6d467be` |
| First parent | `bba3fefb9e83963d50ea1df8737ff75be347b953` |
| Second parent | `6f9383809f7b87a15e9819f83f9a7f147b202883` |

`git rev-list --parents -n 1 HEAD` = three tokens. Uncommitted repair is **on top of** this merge. Do not amend/rebase it.

## Review fixes in the worktree

1. **Slack persona gate.** Object-form `postMessage` allowlists `channel`/`text`/`thread_ts`/`blocks` only. CLI `runTestSend` uses `resolveGatedDisplayIdentity` + 3-arg gated path. Payload tests: CEO/icons never appear in the posted body.
2. **FastChecker env.** `buildHeartbeatWatchdogEnv` + `HEARTBEAT_WATCHDOG_ENV_KEYS`; no `...process.env`. Unit tests assert exact keys and secret-shaped **key absence** (no credential values in expect()).
3. **Test roots.** Setup pins tmp `CTX_ROOT` + `CTX_INSTANCE_ID=vitest`. Vitest globalSetup/teardown fail on porcelain / tracked `.cortextOS` / repo-root `.data` drift.
4. **CI.** `lifecycle-connectors` Node 20+24 Linux. `lifecycle-connectors-100x` Node 24, `scripts/ci-lifecycle-connector-repeat.sh` (map-entry-race + connectors × 100). Counts-only receipts.
5. **44 vs 46.** Plan + `docs/pipeline/evidence/2026-09-28-conflict-inventory-reconciliation.{md,json}`: live unmerged 44; two CLAUDE.md auto-merged under D-07; 24 = 44−20 after Tasks 3–4.

## Changed files

Modified:

- `.github/workflows/ci.yml`
- `docs/pipeline/plans/2026-09-28-upstream-catchup.md`
- `src/cli/slack.ts`
- `src/daemon/fast-checker.ts`
- `src/slack/api.ts`
- `tests/setup/clear-ctx-env.ts`
- `tests/unit/cli/slack.test.ts`
- `tests/unit/daemon/fast-checker.test.ts`
- `tests/unit/slack/api.test.ts`
- `tests/unit/slack/persona-gate.test.ts`
- `vitest.config.ts`

Untracked:

- `scripts/ci-lifecycle-connector-repeat.sh`
- `tests/setup/worktree-guard-setup.ts`
- `tests/setup/worktree-guard-teardown.ts`
- `tests/unit/daemon/heartbeat-watchdog-env.test.ts`
- `tests/unit/test-isolation/` (`ctx-root-pin.test.ts`)

Ignored (`docs/` gitignore; `git add -f` at commit):

- `docs/pipeline/evidence/2026-09-28-conflict-inventory-reconciliation.md`
- `docs/pipeline/evidence/2026-09-28-conflict-inventory-reconciliation.json`
- `docs/pipeline/evidence/2026-09-28-upstream-review-repair-handoff.md` (this file)

## Focused typecheck / tests

Host: darwin arm64, Node v22.22.3. Linux Node 20/24 **not** run.

`npx tsc --noEmit --pretty false` — exit **0**, empty stdout (this session, ~6s with vitest after).

```bash
npx vitest run \
  tests/unit/slack/api.test.ts \
  tests/unit/slack/persona-gate.test.ts \
  tests/unit/cli/slack.test.ts \
  tests/unit/daemon/heartbeat-watchdog-env.test.ts \
  tests/unit/test-isolation/ctx-root-pin.test.ts \
  --reporter=verbose
```

Exit **0**. Test Files **5 passed / 5**. Tests **30 passed / 30**. Duration **939ms**. Start `12:40:19`. Porcelain after this run: same as below (no extra dirt).

```bash
npx vitest run tests/unit/daemon/fast-checker.test.ts -t "heartbeat watchdog" --reporter=verbose
```

**Finished, failed.** Terminal `842065`: pid 88619, `exit_code: 1`, `elapsed_ms: 34451`, ended `2026-09-28T19:38:37.688Z`. Status `failed` (not still running). Two FAILs (inherited titles; not claimed fixed):

1. `two agents with different identities each write under their own context, not a shared/inherited one`
2. `does not start an ambiguously-attributed watchdog when the agent context mismatches the checker paths` — `expect(execMock).not.toHaveBeenCalled()` but mock called 2 times (line 978).

Allowlist unit file (3/3 in the 30) is the env-gate proof. Do not paste watchdog assertion `env` objects (they include allowlisted PATH/HOME; still not for this ledger).

## `git status --porcelain` at this write

```
 M .github/workflows/ci.yml
 M docs/pipeline/plans/2026-09-28-upstream-catchup.md
 M src/cli/slack.ts
 M src/daemon/fast-checker.ts
 M src/slack/api.ts
 M tests/setup/clear-ctx-env.ts
 M tests/unit/cli/slack.test.ts
 M tests/unit/daemon/fast-checker.test.ts
 M tests/unit/slack/api.test.ts
 M tests/unit/slack/persona-gate.test.ts
 M vitest.config.ts
?? scripts/ci-lifecycle-connector-repeat.sh
?? tests/setup/worktree-guard-setup.ts
?? tests/setup/worktree-guard-teardown.ts
?? tests/unit/daemon/heartbeat-watchdog-env.test.ts
?? tests/unit/test-isolation/
```

Index empty. HEAD `24280d2e…`.

## Remaining full-gate commands (do not run from this stop)

Stage including `git add -f docs/pipeline/**`, then:

```bash
git diff --name-only > /tmp/pre-test-worktree.txt
git diff --cached --name-only > /tmp/pre-test-index.txt
npm ci
npm ci --prefix dashboard
npm run typecheck
npm run build
npm test
npm run test:codex
(cd dashboard && npx tsc --noEmit && npm run build)
bash tests/leak-guard.test.sh
node dist/cli.js --help
git status --porcelain
```

Then a **new** follow-up commit (not amend). Re-check `HEAD^1`/`HEAD^2`. `bash .github/scripts/leak-guard.sh --tree HEAD`. No push unless authorized.

## Risks

- Full `npm test` isolation unproven.
- Watchdog *file* still red (2 inherited titles); fake-timer poll storm.
- 100× CI is Node 24 + race/connectors only.
- `docs/` ignored until `git add -f`.
- Watchdog FAIL diagnostics still print allowlisted env **values** (PATH/HOME/USER) — not tokens, but noisy; keep out of committed ledgers.
