# F1 inventory cardinality reconciliation

Status: read-only evidence checkpoint. This is not the F1 SPEC and does not authorize implementation, staging, installation, or activation.

## Discovery boundary

- Root: `/Users/joshweiss/code/cortextos`
- File roots: `orgs`, `templates`, `community`
- Exact suffix: `/<covered-skill>/SKILL.md`
- Covered skills: `task-observer`, `agent-management`, `agent-browser`, `activity-channel`, `audit-pipeline`, `audit-assemble-master`, `source-collection`, `morning-review`, `clearpath-content-pipeline`
- Required file traversal: `rg --files -uu`. A normal or merely `--hidden` scan is invalid because Git-ignored plugin copies disappear.
- Link traversal: `find <roots> -type l`, filtered by exact covered-skill basename, with both literal `readlink` target and resolved `realpath` captured.

## Reproduced file counts

| Skill | Exact `SKILL.md` surfaces |
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
| **Machine-summed total** | **117** |

The earlier F1 first-action receipt states `119`, but its own nine grouped counts sum to `117`. A fresh unignored scan independently returns `117`. Therefore `119` is not an accepted evidence cardinality unless two additional exact paths are produced. Aggregate count must always be derived from the enumerated rows.

## Reproduced symlink counts

- Total relevant skill symlinks: **16**
- Task Observer activation symlinks: **13**, all resolving to `/Users/joshweiss/code/cortextos/community/skills/task-observer`
- Disabled OpenCode compatibility symlinks: **3** (`activity-channel`, `agent-browser`, `agent-management`), all resolving inside the disabled `opencode` agent tree
- No dangling relevant symlink observed in this pass

The 16-link count is cross-skill. It must not be described as 16 Task Observer activations.

## Task Observer activation consumers

`auditmaster-codex`, `codexer`, `crm-codex`, `frank2-codex`, `knox-codex`, `larry-codex`, `maven-codex`, legacy `maven`, legacy `muse`, `pa-codex`, `sage-codex`, `scout-codex`, and `ophir-codex`.

## Fail-closed implications

1. Any inventory tool that omits `-uu` is `INVALID_INPUT`, not PASS.
2. Headline total must equal the machine sum of grouped counts and the number of emitted file rows.
3. Symlink totals must be partitioned by activation role and runtime status; a cross-skill total cannot stand in for Task Observer activation count.
4. `_archive` and `.DS_Store` are invalid runtime identities and cannot contribute enabled-agent cardinality.
5. The next evidence artifact must emit one row per all 117 file surfaces and all 16 symlinks, then bind each exact surface to a recursive path/type/mode/bytes/SHA-or-target tree.
