# Upstream catch-up merge verification (Task 8)

Written 2026-09-28T19:13:00Z on worktree `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380`.
Worker: `task_1790616896855_81108022`. Canonical remote: `https://github.com/clearworks-ai/cortextos.git` (`origin`/`fork`).
No push, no PR, no deploy, no shared-checkout mutation, no `merge --abort`.

## SHA ledger

| Ref | SHA | Result |
|---|---|---|
| First parent candidate `HEAD` | `bba3fefb9e83963d50ea1df8737ff75be347b953` | pin held (`docs(upstream): freeze catch-up baseline`) |
| `HEAD^` / origin/main pin | `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` | pin held |
| Second parent `MERGE_HEAD` | `6f9383809f7b87a15e9819f83f9a7f147b202883` | pin held |
| Merge base | `a15baad45cde344f97468ce1b8fe1d012125a415` | pin held |
| Local-only `main` | `c544b9d1646d0b192d1589c19a4b9ef5ee1df186` | **excluded** (`merge-base --is-ancestor` exit 1) |
| Unmerged paths before commit | 0 | held |

## Environment

- Node: v22.22.3 (plan asked Node 20 + 24 Linux lifecycle matrix; those binaries are not on this Darwin host)
- npm: 10.9.8
- Host: darwin arm64
- Vitest: 4.1.2
- tsup: 8.5.1, target node20
- Next.js: 16.2.4 (Turbopack); inherited workspace-root warning

## Pre-gate residue

At read-only reproduce: unstaged alice/bob `crons.json` + `.bak` vs `HEAD`; git listed untracked `.data/cortextos-default.db*`.

Before mutation: cron fixtures already matched `HEAD` (no-op `git restore --source=HEAD` of the four tracked files). Worktree-root `.data` was already absent (no `rm`). After later test runs, root `.data` was validated (`pwd -P` = this worktree `.data`, not a symlink, not `/Users/joshweiss/cortextos`) and removed. `dashboard/.data` is gitignored (`dashboard/.gitignore:45:.data/`) and was not removed.

Process-wide `CTX_ROOT` was **not** used for the release-gate `npm test`. A first contaminated run with a shared temp `CTX_ROOT` produced extra lock-contention timeouts; those are not the release-gate counts.

## Pre-test fingerprint (release-gate)

| Fingerprint | Lines | SHA-256 |
|---|---|---|
| `/tmp/pre-test-worktree.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `/tmp/pre-test-index.txt` | 164 | `51bc25dd7c1a34b05f8b53e35c826928ffbaffe77f6da4bea13f0cae0a79c335` |

Index = 160 pre-gate staged paths + `docs/pipeline/evidence/2026-09-28-upstream-merge-handoff-pre-gate.md` + 3 Task-8 test-contract files that were previously unmodified vs `HEAD` (`lifecycle-boundary`, `lifecycle-isolation`, `state-atomicity`). Porcelain: 99 `A`, 65 `M`. `git diff --cached --check` clean.

Post-gate (before this file): worktree unstaged 0, untracked 0, cron fixtures match `HEAD`, root `.data` absent. Sorted staged names equal pre-test index.

## Gate ledger

| Gate | Result | Counts / duration | Log SHA-256 |
|---|---|---|---|
| `npm ci` | pass | 148 added / 149 audited; real 2.57s | `82afbbb9697204612bfc5e42e69af887095792c634114a7b52832e3b9e7327c1` |
| `npm ci --prefix dashboard` | pass | 830 added / 831 audited; real 23.86s | `a55494a0473b5cae44850c45cdb90b9f48edae678941dfb075f0f6b008221f5b` |
| `npm run typecheck` | pass | real 3.04s | `f192aeb7c9862853968e70962e9bcf3dc47f6fe9e950e0e358871db4773846d0` |
| `npm run build` | pass | tsup success 255ms; real 0.95s | `49c85bd785266d88f3c06beac639fa09948fc823a4d591c1ec0980f24e4a83eb` |
| `npm test` (release-gate, no process `CTX_ROOT`) | classified | Test Files 6 failed / 320 passed / 3 skipped (329). Tests 17 failed / 4507 passed / 27 skipped / 5 todo (4556). Duration 447.63s; real 448.85s. See classification. | `ca41dfa240a83fb9d658c12ba7d278d8a1865af09bcb890436408da724435e0e` |
| `npm run test:codex` | pass | 6 files, 48 tests; real 4.94s | `3342e7cbfa9f3c1ff97725237646e586623ed705947ca91e39e2f1d5891e2be7` |
| dashboard `tsc --noEmit` | pass | real 12.94s | `f53c8714c25c0851009b331ae78629d0ad5042d6a0d2706d19254fd3b8d27962` |
| dashboard `npm run build` | pass | Next.js 16.2.4; real 27.48s | `52b82adca79d37e3db6d867c8fe4f0ec0ac0cc29ed21f020a6a9a4b51dcc2851` |
| `bash tests/leak-guard.test.sh` | pass | `leak-guard.test: PASS`; real 68.61s | `d85175e65d62e86eadbaa7b7ce2eac739e2b60466e9ad2f55d83cbfbdf3c61d5` |
| `node dist/cli.js --help` | pass | usage printed; real included in 69s combined step | `7edf2d06305bcb520408d5323a9e480f585fa15f5643fb6baf01e7bb915c37f1` |

Contaminated first `npm test` (shared `CTX_ROOT`, not the release-gate): Test Files 9 failed / 317 passed / 3 skipped; Tests 16 failed / 4508 passed / 27 skipped / 5 todo; real 227.06s. SHA-256 `7b915feae7152d46e8b3cc478e24237b45a6519e854556be49cb0446ecbc992f`. Used only to find merge-caused assertion failures.

## Merge-caused failures fixed in this worktree

Contract rerun (no process `CTX_ROOT`): 5 files / 57 tests passed / 2 todo. Log SHA-256 `9b323f91658d6885c84ad7873bc9f8fa7668f923869cd650241bd859af16af3d`. real 10.93s.

| Failure | Cause | Fix |
|---|---|---|
| `lifecycle-boundary` spawn allowlist | D-04 moved `spawn` from `src/telegram/transcribe.ts` to `src/connectors/telegram/transcribe.ts` | Allowlist path updated |
| `lifecycle-isolation` lock export freeze | D-05 `acquireLock`/`releaseLock` now take/return `LockHandle` | Freeze updated to merged signatures. **Not** stale-handle identity `task_1790523877491_88723390` |
| `lock-release-callers` roster | `withFileLockSync` and `withFileLockAsync` both `releaseLock(handle)` | Expected list includes two `src/utils/lock.ts:handle` |
| `cron-state` stateDir lock assert | Upstream test expected `withFileLockSync(stateDir)`; fork/D-05 uses `.locks/cron-state` | Assert per-file lock dir |
| `state-atomicity` send-telegram `Unauthorized` | D-04 Happy Eyeballs uses `node:https`, bypassing the test fetch preload | Test env `CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS=0` (supported opt-out). Dedup TOCTOU still proven |

## `npm test` classification (release-gate, 17 failures)

### Inherited — do not claim fixed (`task_1790567331489_62632638`)

Fail in isolation **and** full suite:

1. `fast-checker` heartbeat watchdog — `two agents with different identities each write under their own context, not a shared/inherited one` (timeout 10000ms)
2. `fast-checker` heartbeat watchdog — `does not start an ambiguously-attributed watchdog when the agent context mismatches the checker paths` (timeout 10000ms)

Same two titles as Task 1 baseline. Isolation 4-file rerun: Test Files 1 failed / 3 passed; Tests 2 failed / 179 passed. Log SHA-256 `de8ae22e6895862e16d3b1244c88a49580bc55f43731a4ffd981ffb339c3b8c7`.

### CONTROL characterization — not a merge regression

`tests/unit/pty/pty-host-dispose.test.ts` > `CONTROL — the old semantics (bare SIGKILL on the host) orphans the grandchild`

- Assert: `expect(orphaned).toBe(true)` received `false` on the release-gate full suite (same as Task 5 `/tmp/t5-suite.txt`).
- Isolation 4-file rerun: this file passed (CONTROL did not fire).
- Classification: Darwin/Node v22.22.3 grandchild-reaping characterization. Old host-only SIGKILL did **not** leave a grandchild alive on this host in the full suite / Task 5; it did in one focused rerun. Plan Node 20/24 Linux 100× runner was not executed.
- **Not** lifecycle-lock `task_1790523877491_88723390`. **Not** env/fixture `task_1790567331489_62632638`.

### Full-suite Darwin load — pass in isolation; not merge-hunk defects

| Test | Full-suite | Isolation |
|---|---|---|
| `event-cron-foundation` 2,100 intervening receipts | timeout 10000ms | pass (same 4-file rerun) |
| `provider-shadow-ingress` 2,100 intervening receipts | timeout 10000ms | pass (same 4-file rerun) |
| extra `fast-checker` watchdog timers / observation / 5000-entry cap | timeouts 10s/30s | pass except the two inherited titles |
| `phase2-backtesting` 3 scenarios | timeouts 180s/60s/60s | **22/22 pass** with `phase5-performance` (real 302.93s). Log SHA-256 `45681614b0acc548d864883234c122cd4ee09f2bac544f3290628500756afeaf` |
| `phase5-performance` 1000/2000-cron startup `<5000ms` | 6364ms / 6324ms | pass in that same 22-test isolation |

These are host-load / full-suite contention on Darwin Node 22. Linux CI remains the plan's immutable PR gate. Not absorbed into lock or fixture remediation tasks.

## Remaining blockers (not this merge commit)

1. Env/fixture leakage `task_1790567331489_62632638` — two fast-checker identity tests; cron `updated_at` mutation after `npm test` (restored, not staged).
2. Lifecycle-lock stale-handle identity `task_1790523877491_88723390` — not claimed fixed; lock signature freeze only records D-05.
3. Node 20/24 Linux 100× lifecycle/connector matrix — not run (host has Node 22 only).
4. Task 9: reviewify, push, PR, CI on Linux — out of Task 8 scope.

## Exclusions held

No `/Users/joshweiss/cortextos` edits; no other worktrees; no `--abort`; no `c544b9d`; no env-value reproduction in this ledger; no deploy/restart/live state/push/PR/main merge.
