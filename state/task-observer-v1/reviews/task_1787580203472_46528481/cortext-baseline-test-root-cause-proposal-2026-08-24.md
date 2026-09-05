# Cortext pinned-base test root-cause and repair proposal

Status: read-only diagnostic proposal from fresh detached HEAD `15defb1307df39f2df77522e70737c46dac52079`. No repository edits were made; the clean disposable worktree was removed.

## Finding

The failures do not share one cause.

1. The missing-runtime-dependency failures share one setup/configuration boundary: root `npm test` lets root Vitest collect dashboard and dashboard-importing integration tests, while root `npm ci` installs only the root package. `next`, `react`, `react-dom`, and `better-sqlite3` are owned only by `dashboard/package.json` and `dashboard/package-lock.json`; the root package declares no workspace and none of those dependencies. This accounts for the 13 failed/zero-collected suites and the `phase5-e2e-simulation` scenario's `next/server` failure.
2. `bus-list-tasks-class` is independent. `list-tasks` decorates rows with `class`, but the default non-`--by-project` path calls `formatTaskTable`, whose header and rows omit the class field. The `--by-project` renderer already includes it. The failing assertion therefore detects a real renderer inconsistency, not dependency setup.

## Minimal proposed repair A: dependency/test topology

Preferred fix: make the root package the npm workspace owner of `dashboard`, so one root `npm ci` installs the dependencies for every suite root Vitest intentionally collects. Do not duplicate dashboard runtime dependencies as root dev dependencies.

Exact proposed allowlist:

- MODIFY `package.json` — add `workspaces: ["dashboard"]`; keep the existing test command and dependency ownership otherwise unchanged.
- MODIFY `package-lock.json` — regenerate from the pinned npm version so it contains the dashboard workspace and its exact dependency graph.
- Optional only if npm proves the nested lock cannot remain authoritative without drift: MODIFY `dashboard/package-lock.json`; otherwise it is excluded.

Required tests/evidence:

1. Fresh disposable clone/worktree: `npm ci` from the root.
2. Assert resolution from root for `next/server`, `react`, `react-dom/server`, and `better-sqlite3`.
3. `npm run build`.
4. Focused dependency-affected files: the 13 failed suites plus `tests/integration/phase5-e2e-simulation.test.ts`.
5. `npm test` must reach `npm run test:node` and exit `0`; report exact file/test totals.
6. `npm --prefix dashboard test` to prove the dashboard-owned invocation remains green.
7. `npm ci` a second time with a clean index and prove both lockfiles (if both retained) are unchanged.

Rejected minimal-looking alternative: copying `next`, `react`, `react-dom`, and `better-sqlite3` into root devDependencies. It makes the immediate resolver errors disappear but duplicates ownership/version drift rather than repairing the collection/install topology.

## Minimal proposed repair B: default list-tasks renderer

Exact proposed allowlist:

- MODIFY `src/cli/bus.ts` — make `formatTaskTable` accept decorated tasks and render a `Class` column/tag consistently with the grouped renderer, without truncating IDs or altering JSON output.
- MODIFY `tests/unit/cli/bus-list-tasks-class.test.ts` — strengthen the existing default-text assertion to verify `[build]`, project/agent visibility as intended, and preserve the existing JSON, priority, and grouped-renderer cases.

Required tests/evidence:

1. `npx vitest run tests/unit/cli/bus-list-tasks-class.test.ts`.
2. Existing table-format coverage for full task IDs and column separation.
3. Focused `list-tasks` CLI tests covering default text, `--by-project`, `--format json`, `--class`, and priority filters.
4. `npm run typecheck` and `npm run build`.
5. Full `npm test` only after repair A establishes the dependency topology; otherwise the unrelated baseline dependency failures remain expected.

## Scope boundary

The two repairs can be independently reviewed and implemented. Repair A is setup/configuration; repair B is a localized renderer defect. Neither requires or authorizes any S0 candidate change, receipt creation, equality rerun, deployment, or promotion.
