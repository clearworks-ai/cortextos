# F1 first-action receipt

State: read-only discovery; substantive SPEC authoring not started.

## Authority and tasks

- F1 active: `task_1787559952654_76501014`
- F2 blocked: `task_1787559952756_54351104`
- F3 blocked: `task_1787559952853_90261222`
- F4 blocked: `task_1787559952928_28469237`
- Immutable forensic packet remains `c52988e85f32a3192b31fd66f82bdb7a24112fc2d54e9211459ca7f5115d8ef6`; no byte changed.

## Initial exact-surface probe

Probe roots: `orgs`, `templates`, `community`. Discovery used `rg --files` with exact `/<skill>/SKILL.md` suffix matching; symlink enumeration used `find orgs -type l` restricted to F1 skill names.

| Skill | SKILL.md files observed |
|---|---:|
| task-observer | 1 |
| agent-management | 32 |
| agent-browser | 28 |
| activity-channel | 37 |
| audit-pipeline | 3 |
| audit-assemble-master | 3 |
| source-collection | 3 |
| morning-review | 9 |
| clearpath-content-pipeline | 1 |

Relevant skill symlinks observed: 16.

## Fail-closed discovery finding

`cortextos bus list-agents --format json` currently surfaces `.DS_Store` and `_archive` as enabled agent rows. Therefore its raw enabled count is not a trustworthy target cardinality. F1 must define and validate a canonical agent-identity filter, then reconcile config, runtime state, and exact skill paths before any claim of exhaustive enabled targets.

## Next read-only action

Produce a complete path-level inventory with per-file/tree hashes, symlink targets, runtime classification, and archive/snapshot/worktree exclusions. No candidate validator or SPEC requirement is accepted until that inventory reproduces without unknown or duplicate surfaces.
