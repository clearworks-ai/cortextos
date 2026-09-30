# Upstream SC-1 contention repair (Task 8 resume)

Written 2026-09-28T20:32:00Z. Worktree `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380`.
Worker `task_1790616896855_81108022`. Cursor session `f53cb1e7-5b12-47b8-9508-57755f24aa88`. Herdr `w4H` / `w4H:t7` / `w4H:p7`.
Canonical `clearworks-ai/cortextos`. Branch `integrate/upstream-6f938380-20260928`.
**Follow-up commit on top of merge `24280d2e`. No amend, no rebase, no push.**

## Merge (intact at gate)

| Ref | SHA |
|---|---|
| HEAD during gate | `24280d2e239eee5d1855aaff089c2b3cb6d467be` |
| First parent | `bba3fefb9e83963d50ea1df8737ff75be347b953` |
| Second parent | `6f9383809f7b87a15e9819f83f9a7f147b202883` |

`git rev-list --parents -n 1 24280d2e239eee5d1855aaff089c2b3cb6d467be` has three tokens.

## Symptom

Release-gate `npm test` (no parent `CTX_*`) failed SC-1 at **9139ms** vs **5000ms** (`/tmp/cortextos-task8-gate-kQqHpr`). Isolated SC-1 2000-cron start was **1674–2281ms**. 5s Linux/product bound kept; `tests/integration/phase5-performance.test.ts` matches merge tree (`git diff HEAD --` empty).

## Root cause (H5)

`CronScheduler.loadCrons()` called `getActiveCronOutcome()` once per enabled cron. Each call takes a file lock, reads/creates the outcome secret, and HMACs. Profile (`npx tsx /tmp/sc1-contention-profile.ts`, CTX pinned to a temp root only inside the harness):

| Path | Time |
|---|---|
| `JSON.parse` 2000 crons | 0.9ms |
| `getActiveCronOutcome` ×2000 empty dir | 1234.7ms |
| `start()` with default `outcomeStateDir` | 1319.4ms |
| `start()` with `outcomeStateDir: ''` | 32.7ms |

~97% of SC-1 startup was per-cron lock/HMAC, not scheduler compute. Full-suite tmp/CPU load multiplied that to 9.1s.

## Fix

`getActiveCronOutcomes()`: one lock, one index/secret read, in-memory lookup per name. `loadCrons()` uses it for the initial pending map; the rare heal loop still calls `getActiveCronOutcome()`. 5s assert unchanged.

After fix:

| Context | 2000-cron `start()` |
|---|---|
| Isolated SC-1 | 100.3ms |
| Same 8-file neighbor vitest load | 87.1ms |

## Pre/post fingerprint (gate `/tmp/cortextos-task8-gate-YLrwtY`)

Parent `CTX_*` key count: **0**. `git diff --cached --check` clean. phase5 file not in the index.

| Fingerprint | Lines | SHA-256 |
|---|---|---|
| worktree names (pre=post) | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| index names (pre=post) | 27 | `863a36b782e7c0e55c6851c2f96d14c942566505830797729131fb3ec1501318` |

Worktree and index drift diffs are empty.

## Task 8 gate (this resume)

Host: darwin arm64, Node v22.22.3, npm 10.9.8, Vitest 4.1.2. Linux Node 20/24 not run here.

| Gate | Exit | Duration | Log SHA-256 |
|---|---|---|---|
| `npm ci` | 0 | 2s | `374528fdac9ad990926f7a627b7584b2ba19687f7f9a42b84f98e6fdfbcce5fd` |
| `npm ci --prefix dashboard` | 0 | 23s | `c46bf7a8eaf2cd1f9f2facafa16b8075b4516df5361730043e24ac5b2bff0a95` |
| `npm run typecheck` | 0 | 3s | `db6d7853e9897f38596c57e7876f9d5e02ed76add17a507d80acf813150b6cfd` |
| `npm run build` | 0 | 0s | `1ee2252785987b55abc8b36f1bc047ae791486ea5af0de0984fca49b9690d766` |
| `npm test` | 0 | 236s | `68f53df77091e4686890133bee4e19063210cf4814b733fa3d4ea0c3dd6803d1` |
| `npm run test:codex` | 0 | 2s | `e8002052c3dfa4630d7fb9ad16b4fbd810cfb0bfa7b6477b957400804c7b6e37` |
| dashboard `tsc --noEmit` | 0 | 4s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| dashboard `npm run build` | 0 | 29s | `c39ac77535a30bc2aab963b06835737558d6840a66d818c80994ccbac2894615` |
| `bash tests/leak-guard.test.sh` | 0 | 66s | `dd36755a50d6d1352203f81f96895354e2df4b543d3bcfd9d1f444de9b72b14a` |
| `node dist/cli.js --help` | 0 | 0s | `fa7f046ff7b577b61f6f168ef18577a26d6fa84d6ddac4a9ef9a57db39ba684c` |
| staged leak-guard | 0 | 1s | `dbe64772dc665ddca874f994efe0bdf1d0d467d9bf58cf58fb6572135a8cad10` |

`npm test` counts: Test Files **328 passed** / 3 skipped (331). Tests **4535 passed** / 28 skipped / 5 todo (4568). Duration **233.30s**. Start `13:25:35`.
`npm run test:codex`: 6 files / 48 tests passed.

## Exclusions held

No shared checkout; no secrets/env values; no live mutate/deploy/restart; no push/PR/main merge; no amend/rebase of `24280d2`.
