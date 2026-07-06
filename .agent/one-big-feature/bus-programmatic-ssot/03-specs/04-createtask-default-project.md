# Spec 04 — create-task defaults a project (no more (unassigned)) — bus-programmatic-ssot #8

## Why
Josh: "make default." 185 pending build tasks have empty `project` because agents call
`create-task` without `--project`, bypassing the gate hook. Result: one giant `(unassigned)`
bucket in `bus list-tasks --by-project`. Fix: when `--project` is omitted, DERIVE one so every
new task self-files under a named bucket. Explicit `--project` and the gate's `ensure-epic-task`
slug always win — this only changes the empty case.

## Repo
`~/code/cortextos` — framework=one-big-feature, slug=bus-programmatic-ssot.

## Scope — codexer, ONE behavioral change + tests
`src/bus/task.ts` `createTask` only (plus its tests). Do NOT touch CLI, other functions.

### Current behavior (task.ts ~line 77)
```
const project = requestedProject === '' && SYSTEM_TASK_CREATOR_RE.test(agentName)
  ? 'system'
  : requestedProject;
```
System spawners already forward-tag `project='system'`. Everything else with an empty project
stays empty → `(unassigned)`.

### New behavior
Extend the empty-project fallback so a NON-system creator with no explicit project defaults to its
own agent name:
```
let project = requestedProject;
if (requestedProject === '') {
  project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
}
```
- Explicit `requestedProject` (any non-empty) → unchanged, always wins.
- System spawner + empty → `'system'` (unchanged).
- Any other agent + empty → `<agentName>` (NEW — was `''`).

### Classification must stay correct
`classifyTask` returns `system` only for `project==='system'` / system-creator / `human-tasks`.
A task with `project='larry'` is still `build`. Assert this in a test so the default does NOT
silently reclassify real tasks as system/human.

## Tests (in tests/unit/bus/task.test.ts)
1. `createTask` with no project + ordinary agent (`'larry'`) → stored `project==='larry'`.
2. `createTask` with explicit `project:'my-epic'` → stays `'my-epic'` (default does not override).
3. System spawner (e.g. `'comms-check-123'`) + no project → still `'system'` (regression guard).
4. Defaulted task (`project==='larry'`) still `classifyTask === 'build'` (no misclassification).

## Constraints
TS strict, no `any`, no `console.log` in lib. No storage-model field added — `project` exists.
No change to createTask's signature or return. Reuse existing SYSTEM_TASK_CREATOR_RE.

## Out of scope
Backfilling the existing 185 (they keep empty project; reaper handles stale). CLI flag changes.

## Deliverable
Diff (task.ts + task.test.ts) back to Larry. No commit, no push.
