# Upstream catch-up final verification ledger (consolidated)

Written 2026-09-28. Worktree `/Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380`.
Worker `task_1790616896855_81108022`. Cursor session `9bf9d6ba-245a-4662-ace5-dba3653acb0c`.
Herdr workspace `w4H` tab `w4H:t8` pane `w4H:p8`. Canonical `clearworks-ai/cortextos`.
Branch `integrate/upstream-6f938380-20260928`.
**This file is the Task 9 `--body-file`.** Historical ledgers below stay on disk and are not superseded as records.

Candidate SHA is **prospective** until the follow-up commit lands on parent `75eb10a`. Do not amend/rebase `24280d2` or `75eb10a`. No push/PR.

## Lineage (preserved)

| Ref | SHA | Role |
|---|---|---|
| Reviewed merge | `24280d2e239eee5d1855aaff089c2b3cb6d467be` | two-parent merge; parent 2 = `6f938380` |
| First parent of merge | `bba3fefb9e83963d50ea1df8737ff75be347b953` | baseline evidence commit |
| Second parent of merge | `6f9383809f7b87a15e9819f83f9a7f147b202883` | pinned upstream |
| Merge-base | `a15baad45cde344f97468ce1b8fe1d012125a415` | three-way base |
| Candidate parent | `75eb10a152530744b04a62052810bf3b73106c92` | SC-1 batch + first review repairs |
| This follow-up | parent `75eb10a` + this commit (no amend) | new candidate |

`git rev-list --parents -n 1 24280d2e239eee5d1855aaff089c2b3cb6d467be` has three tokens.

## Historical ledgers (keep; not the PR body)

- `docs/pipeline/evidence/2026-09-28-upstream-baseline.md`
- `docs/pipeline/evidence/2026-09-28-upstream-merge-handoff-task4.md`
- `docs/pipeline/evidence/2026-09-28-upstream-merge-handoff-task7.md`
- `docs/pipeline/evidence/2026-09-28-upstream-merge-handoff-pre-gate.md`
- `docs/pipeline/evidence/2026-09-28-upstream-merge-verification.md`
- `docs/pipeline/evidence/2026-09-28-conflict-inventory-reconciliation.md`
- `docs/pipeline/evidence/2026-09-28-upstream-review-repair-handoff.md`
- `docs/pipeline/evidence/2026-09-28-upstream-review-repair-gate-handoff.md`
- `docs/pipeline/evidence/2026-09-28-upstream-sc1-contention-repair.md`

## Review-repair wave on `75eb10a`

1. **High** — `getActiveCronOutcomes` skipped invalid names before the lock. One empty name no longer disables recovery for a valid pending sibling. Red: `invalid cron receipt identity` at `assertRawIdentity`. Green: mixed `''` + `good` returns the pending `good` run.
2. **Medium** — one grouped nonterminal index (agent+cron HMAC key, each populated group sorted once) under the existing lock; requested lookups O(1). Public pick rules unchanged. Populated 2000-cron backlog at the cron-outcome seam: lookup **36ms** after grouping (pre-group seeded lookup **423ms**), still bound **&lt;5000ms**.
3. **Medium** — `scripts/ci-lifecycle-connector-repeat.sh` reviewed manifest (not exhaustive): map-entry race, eviction round4, Hermes force-fresh timing, PTY disposal, `tests/unit/connectors`. Pinned by `tests/unit/scripts/ci-lifecycle-connector-repeat.test.ts`.
4. **Low** — lifecycle + 100x jobs write SHA-tied JSON receipts and upload via `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2). Keys: job, sha, node, platform/repeat, result. No secret/env dumps. No new runtime dependency.
5. **Spec Medium** — this consolidated ledger. Task 9 `--body-file` retargeted here.

## Focused proof (pre-gate)

Host: darwin arm64, Node v22.22.3. `CTX_*` count **0**.

| Check | Result |
|---|---|
| isolation red | throw `invalid cron receipt identity` |
| isolation + 2000-cron + foundation + manifest pin | Test Files **2 passed**. Tests **22 passed**. Duration **4.60s** |
| `npx tsc --noEmit` | exit 0 |
| `bash -n` 100x script + PyYAML `ci.yml`/`leak-guard.yml` | ok |
| `REPEAT=1` manifest smoke | `{"job":"lifecycle-connectors-100x","passed_repeats":1,"repeat":1}` — Test Files **8 passed**. Tests **82 passed** / 1 skipped |

## Task 8 gate

Staged run `/tmp/cortextos-task8-gate-review-repair-2`. Host: darwin arm64, Node v22.22.3, npm 10.9.8, Vitest 4.1.2. Parent `CTX_*` count **0**.
Pre/post worktree names: 0 lines, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Pre/post index names: 8 lines, SHA-256 `a22de68cf7b6c03ca0cc3eb6a6f8beb56383add79d35e7c2b7dd3813853b3a5a`. Porcelain match. `git diff --cached --check` clean.

| Gate | Result | Duration | Log SHA-256 |
|---|---|---|---|
| `npm ci` | pass | 3s | `374528fdac9ad990926f7a627b7584b2ba19687f7f9a42b84f98e6fdfbcce5fd` |
| `npm ci --prefix dashboard` | pass | 21s | `496f1e472bd079536fd49518420824641958eec4029f5ae844f844adefaef799` |
| `npm run typecheck` | pass | 6s | `db6d7853e9897f38596c57e7876f9d5e02ed76add17a507d80acf813150b6cfd` |
| `npm run build` | pass | 1s | `55db7b0808129fc9627a85ce17e7b65bb5b6a740e76f20b2ae632951adbae99f` |
| `npm test` | pass | 202s | `69f18c968b4f37b97ddf24a25431741c30df2634be47f8fc7cd0f72bb2521e08` |
| `npm run test:codex` | pass | 3s | `9408d2602b0ebb4127c2b02dbb72bd4b3cb699c8d3d1ee3b81250046e8be80b4` |
| dashboard `tsc --noEmit` | pass | 3s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| dashboard `npm run build` | pass | 18s | `27b2d979e09b88b117dfbe23c01b9048828334144ac1bad74eced33092a9f386` |
| `bash tests/leak-guard.test.sh` | pass | 55s | `dd36755a50d6d1352203f81f96895354e2df4b543d3bcfd9d1f444de9b72b14a` |
| `node dist/cli.js --help` | pass | 0s | `fa7f046ff7b577b61f6f168ef18577a26d6fa84d6ddac4a9ef9a57db39ba684c` |
| staged leak-guard | pass | — | `dbe64772dc665ddca874f994efe0bdf1d0d467d9bf58cf58fb6572135a8cad10` |

`npm test` counts: Test Files **329 passed** / 3 skipped (332). Tests **4539 passed** / 28 skipped / 5 todo (4572). Duration **200.27s**. Start `13:52:46`.
`npm run test:codex`: 6 files / 48 tests passed.

## Still pending until PR CI (Linux)

Plan acceptance requires Linux **Node 20 and Node 24** lifecycle/connector coverage and the **100×** `lifecycle-connectors-100x` job on the immutable PR SHA. Those are **not** claimed here. Darwin Node 22 focused + Task 8 is local evidence only.

## Exclusions held

No shared checkout; no secrets/env values; no live mutate/deploy/restart; no push/PR/main merge; no amend/rebase of `24280d2` or `75eb10a`.
