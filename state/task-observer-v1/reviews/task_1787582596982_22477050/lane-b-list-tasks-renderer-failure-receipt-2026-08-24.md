# Lane B list-tasks renderer failure receipt

Disposition: FAIL-CLOSED and byte-frozen. This is not a renderer PASS, combined-validation authority, commit authority, or S0 authority.

## Authority and writer

- Adoption manifest SHA-256: `7163fe25bff1f54b6db88e6a2b346a47b2fac70eaea5a80cc620e2abbeaf862f`
- Worktree: `/Users/joshweiss/code/cortextos-worktrees/list-tasks-renderer-adoption-20260824`
- Branch: `repair/list-tasks-renderer-adoption-20260824`
- Base/HEAD: `15defb1307df39f2df77522e70737c46dac52079`
- Sole writer: `list_tasks_renderer_adopter`; session `01a0343a-7e28-7161-990d-04aaf15a2a26`; Herdr state `done`; descendants `0`.
- Runtime: Node `v22.22.3`; npm `10.9.8`.

## Provisioning conservation

Exactly one authorized `npm ci` ran: exit `0`, 143 packages added to ignored `node_modules/` only. These tracked prerequisites remained exact:

- `package.json`: `445fdb947bd7614e3ca9bb3703fe9add38ddaee72ee877c2dc0e4a28c90d1426`, 1865 bytes, mode 0600.
- `package-lock.json`: `d02496cc048beb14fa25cf39490c620f8d925153a8afd2272ef9a989d4eb771e`, 115417 bytes, mode 0600.
- `dashboard/package-lock.json`: `04a7ee87a4bd48071be9c305c2b3ef5ed648e6b731b23e1ab36c730926a549e0`, 459186 bytes, mode 0600.
- Nonignored untracked artifacts: none.

## Behavioral RED

`npx vitest run tests/unit/cli/bus-list-tasks-class.test.ts` reached collection and exited `1`: `1` failed, `4` passed. The failure was the default text renderer omitting `[build]`.

## Frozen two-file candidate

| Path | Pre SHA-256 | Post SHA-256 | Pre bytes | Post bytes | Mode |
|---|---|---|---:|---:|---|
| `src/cli/bus.ts` | `66928d377fde4789d6940bc8ccef6f83dbfc2956b0a3d26da9554a94b6b7c70c` | `a892c8a22ced661561bce88ece0ad803ac7466bfb80f8ca1adf306f8f69740a9` | 221009 | 221673 | 0600 |
| `tests/unit/cli/bus-list-tasks-class.test.ts` | `046d32f878a4c891df5388229d3e67ad2c4240bd53afdc29a61f7898f1f7cfd3` | `25a5f2a5321e15fce040fff669798d2d52dd6ca121f79623a467cac467497584` | 6380 | 6403 | 0600 |

- Binary diff SHA-256: `21135eb8b79a122c91a07ac004ee4eab8b6666ef8e637ccb68081141e1a4ee85`
- Diff: `18` insertions, `7` deletions across exactly two allowlisted files.
- `git diff --check`: exit `0`.
- Staged paths `0`; nonignored untracked paths `0`; out-of-allowlist tracked changes `0`.

## Validation and mandatory gate failure

1. `npx vitest run tests/unit/cli/bus-list-tasks-class.test.ts`: exit `0`; `5/5` tests passed.
2. `npx vitest run tests/unit/cli/task-table.test.ts tests/unit/cli/bus-list-tasks-class.test.ts`: exit `1`; `1` file failed, `1` passed; `1` test failed, `9` passed.

The unchanged full-ID regression requires the task ID to be followed by two-or-more spaces and the assignee. The candidate inserted Project/From columns between ID and assignee, violating that invariant. Per gate, the writer stopped without fix-forward.

Not run after failure: three-file focused suite, typecheck, build, or full suite.

## Side-effect conservation and stop proof

- Only ignored `node_modules/` was created during prerequisite provisioning.
- No staging, commit, push, merge, deploy, S0 mutation, receipt-in-worktree, full-suite run, or descendant.
- Herdr writer state is `done`; candidate is frozen, uncommitted, and not validation-ready.
