# S0 Cortext full-suite base-control ledger

Status: diagnostic only; S0 candidate remains frozen and uncommitted. This is not a success receipt or promotion authority.

## Authority and isolation

- S0 adoption v2 SHA-256: `75185b1681ff78cd80abb5e79a322eb9ecf68057fa62995653ab238c1303671d`
- Candidate Cortext HEAD: `15defb1307df39f2df77522e70737c46dac52079`
- Candidate Briefs HEAD: `5b521f2e4f0ec8655643b16641f41202705d7d6b`
- Base control: fresh detached disposable Cortext worktree at exactly `15defb1307df39f2df77522e70737c46dac52079`, containing no S0 bytes.
- Control preparation matched the candidate's pre-test build state: `npm ci` (including the repository postinstall) and `npm run build` passed, then the identical mandatory command `npm test` ran once to its natural exit.
- Control exit: `1`. Because `vitest run` failed, the chained `npm run test:node` did not run.

## Terminal base-control result

Reporter summary:

```text
Test Files  15 failed | 245 passed | 3 skipped (263)
Tests       2 failed | 3477 passed | 74 skipped (3553)
Duration    102.58s
Exit        1
```

Failed suites / zero-collected files (13):

1. `tests/integration/phase4-dashboard-backtest.test.ts` — `next/server` unavailable.
2. `tests/integration/phase4-performance.test.ts` — `next/server` unavailable.
3. `tests/integration/phase5-user-journeys.test.ts` — `next/server` unavailable.
4. `dashboard/src/lib/__tests__/clients.test.ts` — `better-sqlite3` unavailable.
5. `dashboard/src/lib/__tests__/cost-parser-codex.test.ts` — `better-sqlite3` unavailable; 17 skipped before suite failure.
6. `dashboard/src/lib/__tests__/cost-parser.test.ts` — `better-sqlite3` unavailable; 13 skipped before suite failure.
7. `dashboard/src/lib/__tests__/sync.test.ts` — `better-sqlite3` unavailable; 17 skipped before suite failure.
8. `dashboard/src/components/tasks/__tests__/kanban-board.test.ts` — `react` unavailable.
9. `dashboard/src/app/api/comms/__tests__/routes.test.ts` — `next/server` unavailable.
10. `dashboard/src/app/api/workflows/health/__tests__/health-route.test.ts` — `next/server` unavailable.
11. `dashboard/src/app/api/tasks/[id]/__tests__/route.test.ts` — `next/server` unavailable.
12. `dashboard/src/app/api/workflows/crons/__tests__/executions-export.test.ts` — `next/server` unavailable.
13. `dashboard/src/app/api/workflows/crons/__tests__/fire-route.test.ts` — `next/server` unavailable.

Failed tests (2):

1. `tests/integration/phase5-e2e-simulation.test.ts > Scenario 7: Dashboard polling accuracy throughout simulation > dashboard /api/workflows/crons and /api/workflows/health reflect accurate state at every poll` — dynamic import of `next/server` failed at line 1233.
2. `tests/unit/cli/bus-list-tasks-class.test.ts > bus list-tasks classification flags > prefixes text rows with the computed class tag` — assertion at line 71 expected `true`, received `false`.

The built control's pty gates passed (`[pty-leak-gate] before=0 after=0 delta=0 threshold=4`), excluding the two setup-induced failures seen in an earlier invalid control that had omitted the repository postinstall/build. That invalid control is not used in this comparison.

## Candidate-versus-base comparison

The S0 candidate run was fail-closed and terminated before the final reporter summary, after the complete observed failure/zero-collected set had appeared. Its observed set was exactly the same 13 failed suites and 2 failed tests listed above. No candidate-only failure was observed; set difference in both directions is empty. The two S0 focused tests had already passed `2/2`, and the S0 validator had passed `23` schemas, `25` golden fixtures, and `53` governed negatives.

Candidate run evidence is preserved in the sole writer transcript:

`/Users/joshweiss/.codex/sessions/2026/08/24/rollout-2026-08-24T07-05-30-01a03417-32a6-7c20-88e3-aff303139b97.jsonl`

## Test-state restoration

Both candidate and control runs changed only these test fixture paths outside the S0 allowlist:

- tracked `.cortextOS/state/agents/alice/crons.json`
- tracked `.cortextOS/state/agents/alice/crons.json.bak`
- untracked `.cortextOS/state/agents/bob/crons.json`

Canonical pretest/restored hashes:

- `alice/crons.json`: `90344d4a0d66c0c70828a4d077790e19f873e776ea498cd2ad4808c6e6b2d552`
- `alice/crons.json.bak`: `435f36371c1d4d8f97f621e3c46f40037d2fca4487917c371345492985c710bc`
- `bob/`: absent before and absent after.

Built-control transient hashes before restoration:

- `alice/crons.json`: `dbcf80d6b26d30ce5459c0250c0d8bfbfc2dbd3778f81bb75eb150e6807aa205`
- `alice/crons.json.bak`: `89f02a3242a095599cef2730366838ff547a02623e4a8736c5722f1f3da882c8`
- `bob/crons.json`: `0e6cd4c3619a5962d7ef33ff056522f9e5869410075f24393e030f1851fcc93c`

Restoration proof: the two tracked files rehashed to the canonical values, `bob/` was absent, `git status --short` was empty, and the disposable worktree was removed. No npm/vitest process remained.

## S0 allowlist conservation

- Cortext candidate: `66` changed files, `0` outside the `67`-path v2 allowlist, `0` staged. The sole absent allowlisted path is the deliberately uncreated success receipt `state/receipts/meeting-intelligence-s0-adoption.json`.
- Briefs candidate: `76` changed files, `0` outside the `77`-path v2 allowlist, `0` staged. The sole absent allowlisted path is the deliberately uncreated success receipt `docs/receipts/meeting-intelligence-s0-adoption.json`.
- Exact copied-byte conservation: Cortext contracts `61/61`; Briefs contracts `61/61`; Briefs product/spec artifacts `10/10`; SHA/byte/mode mismatches `0`.
- Both worktrees remain uncommitted and frozen. Final equality, privacy/runtime-reachability, and success receipts remain not run/not created.
