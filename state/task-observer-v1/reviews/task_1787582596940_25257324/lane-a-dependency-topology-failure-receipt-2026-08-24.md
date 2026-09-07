# Lane A dependency-topology failure receipt

Disposition: FAIL-CLOSED and byte-frozen. This is not a repair PASS, combined-validation authority, commit authority, or S0 authority.

## Authority and writer

- Adoption manifest SHA-256: `1dea6a625307f641fe6b1b198d531cbec14c52341637e47ddddd9f432db4390b`
- Worktree: `/Users/joshweiss/code/cortextos-worktrees/dependency-topology-adoption-20260824`
- Branch: `repair/dependency-topology-adoption-20260824`
- Base/HEAD: `15defb1307df39f2df77522e70737c46dac52079`
- Sole writer: `dependency_topology_adopter`; session `01a0343a-71eb-7391-8b65-eb2edb949e31`; Herdr state `done`; descendants `0`.
- Runtime: Node `v22.22.3`; npm `10.9.8`.

## Frozen two-file candidate

| Path | Pre SHA-256 | Post SHA-256 | Pre bytes | Post bytes | Mode |
|---|---|---|---:|---:|---|
| `package.json` | `445fdb947bd7614e3ca9bb3703fe9add38ddaee72ee877c2dc0e4a28c90d1426` | `635eb988b07efec0b4fe63fa400030abc00ae869eeae179001d9688655101d38` | 1865 | 1904 | 0600 |
| `package-lock.json` | `d02496cc048beb14fa25cf39490c620f8d925153a8afd2272ef9a989d4eb771e` | `fd08cc58431ab6be7036d3ec1511615978a259667d4c495b8a388a4debc7932e` | 115417 | 510819 | 0600 |

- Binary diff SHA-256: `fd9958b2a83ec8aaf7a825befc66d0c2b0286626bc86eb8d0cc6a323a5ce55a5`
- Diff numstat: `package.json +3/-0`; `package-lock.json +13239/-2181`.
- `git diff --check`: exit `0`.
- Modified paths: exactly the two allowlisted files; staged paths `0`; index locks `0`; untracked test side effects `0`.

## Lock topology and passing prerequisites

- Candidate adds root workspace ownership for `dashboard` and regenerates only the root lock.
- `dashboard/package-lock.json` remained byte-exact: SHA-256 `04a7ee87a4bd48071be9c305c2b3ef5ed648e6b731b23e1ab36c730926a549e0`, 459186 bytes, mode 0600.
- `npm ci`: exit `0`.
- Node `require.resolve` succeeded for `next/server`, `react`, `react-dom/server`, and `better-sqlite3`.
- `npm run build`: exit `0`.

## Mandatory focused gate failure

Command:

```text
npx vitest run tests/integration/phase4-dashboard-backtest.test.ts tests/integration/phase4-performance.test.ts tests/integration/phase5-user-journeys.test.ts dashboard/src/lib/__tests__/clients.test.ts dashboard/src/lib/__tests__/cost-parser-codex.test.ts dashboard/src/lib/__tests__/cost-parser.test.ts dashboard/src/lib/__tests__/sync.test.ts dashboard/src/components/tasks/__tests__/kanban-board.test.ts dashboard/src/app/api/comms/__tests__/routes.test.ts dashboard/src/app/api/workflows/health/__tests__/health-route.test.ts 'dashboard/src/app/api/tasks/[id]/__tests__/route.test.ts' dashboard/src/app/api/workflows/crons/__tests__/executions-export.test.ts dashboard/src/app/api/workflows/crons/__tests__/fire-route.test.ts tests/integration/phase5-e2e-simulation.test.ts
```

Result: exit `1`; test files `9 failed | 5 passed (14)`; tests `1 failed | 82 passed (83)`; duration `5.64s`.

Vitest still could not resolve `next/server` in these eight suites despite successful Node resolution:

1. `tests/integration/phase4-dashboard-backtest.test.ts`
2. `tests/integration/phase4-performance.test.ts`
3. `tests/integration/phase5-user-journeys.test.ts`
4. `dashboard/src/app/api/comms/__tests__/routes.test.ts`
5. `dashboard/src/app/api/workflows/health/__tests__/health-route.test.ts`
6. `dashboard/src/app/api/tasks/[id]/__tests__/route.test.ts`
7. `dashboard/src/app/api/workflows/crons/__tests__/executions-export.test.ts`
8. `dashboard/src/app/api/workflows/crons/__tests__/fire-route.test.ts`

The ninth failed file was `tests/integration/phase5-e2e-simulation.test.ts`; Scenario 7 failed resolving `next/server` at line 1233. The `better-sqlite3` and React-dependent focused suites passed under the workspace lock topology.

Because the focused gate failed, root `npm test`, `npm --prefix dashboard test`, and second-`npm ci` stability were not run.

## Side-effect conservation and stop proof

- `.cortextOS` pre/final digest: `26fb81323e74bf78eff71a9296ba03b6db567e7e1f6c3b24b92d717f4c434de9`; files `3`, directories `5`, exact.
- Removed test-created `.data/cortextos-default.db`, `-shm`, and `-wal`; final survival check absent.
- No staging, commit, push, merge, deploy, S0 mutation, receipt-in-worktree, or descendant.
- Herdr writer state is `done`; candidate is frozen, uncommitted, and not validation-ready.
