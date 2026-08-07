# `/goal` schema-v3 remediation evidence

Date: 2026-08-06 PDT

## Focused acceptance

- `npx vitest run tests/unit/goals tests/unit/pty/codex-app-server-pty-goal.test.ts tests/integration/goal-run-control-plane.test.ts tests/integration/goal-pty-process-boundary.test.ts tests/unit/pty/codex-app-server-pty.test.ts tests/unit/daemon/agent-process-codex-app-server.test.ts`: 10 files, 121 tests passed.
- `npx vitest run tests/e2e/lifecycle-codex.test.ts`: 9 process-protocol fixture regressions passed after extending the child app-server scenario.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

The focused inventory includes two-process claim/reclaim, expired-token and wrong-state rejection, exact manifest preservation, fail-closed current-cycle audit, duplicate/wrong-provenance artifact rejection, blocked-sibling continuation, reviewer-findings restart, child-process app-server spawn/connect/restart recovery, exact thread/turn correlation with adversarial noise, ordinary-queue isolation, periodic recovery, retention on active and terminal records, and bounded cancellable shutdown.

## Repository-full baseline

`npm test` remains opt-in and is not the durable runner's default profile. Latest run from this worktree: 3,117 passed, 74 skipped, 2 failed assertions, 15 failed files.

The 15-file inventory is unrelated to `src/goals` and the goal PTY integration:

- 13 files cannot import dashboard-only dependencies absent from the root install: `next/server`, `better-sqlite3`, or `react`.
- `tests/integration/phase5-e2e-simulation.test.ts` fails its dashboard polling case for the same missing `next/server` dependency.
- `tests/unit/pty/pty-host-dispose.test.ts` fails the CONTROL assertion that bare host `SIGKILL` must orphan a grandchild; the observed grandchild was reaped (`expected true`, received `false`).

`repository-full` now requires a persisted observation from the last 24 hours and no more than five minutes in the future. The observation must match the repository's current `git rev-parse HEAD`, use the exact `npm test` command, and include exit code plus observed failures. Green evidence must match an observed zero exit with no failures; a waiver must match the observed commit, date, command, and failure inventory exactly.
