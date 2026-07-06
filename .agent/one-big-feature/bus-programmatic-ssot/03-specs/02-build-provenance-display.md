# Spec 02 — Build task provenance display (origin + project)

**Josh (verbatim, 2026-07-06):** "the build should show what. they are part of where they came from, part of a certain project, etc"

**Repo:** `~/code/cortextos`. Framework: one-big-feature. Slug: `bus-programmatic-ssot`. Extends PR #80 branch `feat/bus-task-categorization`.

## Intent
Classification tells you a task is `build`, but not WHERE it came from or WHICH epic it belongs to. Build rows should surface provenance:
- **From** = `created_by` (which agent/spawner opened it).
- **Project** = `project` field (the epic/slug it belongs to).

## Deliverables (codexer, .ts on the SAME branch)

### 1. `src/cli/bus.ts` list-tasks text output
Add two columns between `[class]` and Title: **Project** and **From** (`created_by`).
- Project column: show `project` or `-` when empty. Truncate/pad ~16.
- From column: show `created_by` or `-`. Truncate/pad ~16.
- Keep existing Status/Pri/ID/Assignee. If the row gets too wide for phone reading, drop the **ID** column (least useful in a scan) — keep Class, Status, Project, From, Assignee, Title.
- Header updated to match.

### 2. `src/cli/bus.ts` — `--by-project` grouping flag
`bus list-tasks --real-build --by-project` groups rows under a `▸ <project> (<count>)` header line, sorted by project name, tasks with empty project under `▸ (unassigned) (<count>)`. This directly answers "what are we building, by project."
- When `--by-project` is off, behavior unchanged.
- Group only affects text output; json output unchanged (already carries project + created_by on every row).

### 3. json output
Already includes `project` and `created_by` (full task object). No change needed — confirm the computed `class` field from spec 01 is still present.

## Tests (`tests/unit/cli/bus-list-tasks-class.test.ts` — extend)
- text output includes the `created_by` value and `project` value for a build task.
- `--by-project` emits a `▸ <project>` header and groups the row under it.

## Note (drives next roadmap item)
Most build tasks currently have empty `project` — the epic isn't populated at creation. Fully populating it is the OBF/M2C1 **auto-open hooks** (spec 03, next): when a framework creates a task it sets `project=<slug>`, so every build task carries its epic automatically. This display spec makes that gap visible now.

## Constraints
TS strict, no `any`, match existing bus.ts CLI patterns. Display-only + one flag — no storage/schema change.
