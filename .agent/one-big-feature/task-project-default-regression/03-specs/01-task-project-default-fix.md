# Spec 01 — createTask project-default fix (land PR#82's fix at PR#218's hoisted site)

Branch: `fix/task-project-default-regression`

## Change 1 — `src/bus/task.ts`

In `createTask()`, find this block (currently ~line 733-737, right after
`validatePriority(priority);` and before the `effectiveDueDate` due-date block
— PR#218 hoisted it here):

```ts
  validatePriority(priority);
  // Hoisted above the due-date block so cron-creator tasks classify as system
  // for the class-aware default too; reused for the task object below.
  const project = requestedProject === '' && SYSTEM_TASK_CREATOR_RE.test(agentName)
    ? 'system'
    : requestedProject;
```

Replace the `const project = ...` ternary with the original 2026-07-06 fix
logic (from never-merged PR#82, commit `34e4948`), keeping PR#218's comment and
hoisted position:

```ts
  validatePriority(priority);
  // Hoisted above the due-date block so cron-creator tasks classify as system
  // for the class-aware default too; reused for the task object below.
  let project = requestedProject;
  if (requestedProject === '') {
    project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
  }
```

Semantics: explicit `--project` always wins. When unset, system-spawned tasks
(matching `SYSTEM_TASK_CREATOR_RE`) still tag `project: 'system'` (unchanged
behavior). Every other agent now defaults to `project: <agentName>` instead of
`project: ''`.

Do not touch anything else in `createTask()` — the due-date block, task object
construction, and locking/audit code below are all PR#218/unrelated work and
must stay byte-identical.

## Change 2 — `tests/unit/bus/task.test.ts`

### 2a. Update one existing assertion
In the `'creates task with correct JSON format'` test (~line 78-106), the task
is created via `createTask(paths, 'paul', 'acme', 'Build landing page', {...})`
with no explicit `project`. Update:
```ts
// before
expect(content.project).toBe('');

// after
expect(content.project).toBe('paul');
```

### 2b. Restore the 3 original PR#82 regression tests
Add these 3 tests inside the `describe('createTask', ...)` block (after the
existing `'creates someday tasks without changing their derived class'` test,
~line 123):

```ts
    it('defaults an ordinary agent task project to the agent name when unset', () => {
      const taskId = createTask(paths, 'larry', 'acme', 'Build task');
      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.project).toBe('larry');
    });

    it('preserves an explicit project when provided', () => {
      const taskId = createTask(paths, 'larry', 'acme', 'Build task', { project: 'my-epic' });
      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.project).toBe('my-epic');
    });

    it('keeps a defaulted agent-name project classified as build', () => {
      const taskId = createTask(paths, 'larry', 'acme', 'Build task');
      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.project).toBe('larry');
      expect(classifyTask(content)).toBe('build');
    });
```

`classifyTask` is already imported in this test file (used elsewhere, e.g. line
122) — no new import needed.

## Out of scope / do not touch
- `tests/unit/bus/task.test.ts` lines 108-177 (`'auto-tags system-spawned tasks
  when project is unset'`, the `computeDefaultDueDate — class-aware caps`
  block, the `createTask — class-aware default due dates` block) — all pass
  unchanged against the fixed logic; do not edit them.
- Any `project: ''` in hand-built mock `Task` objects elsewhere in the test
  file (e.g. ~line 911, 1068, 1798) — unrelated to `createTask()`'s defaulting
  logic, not affected by this fix.
- `src/cli/bus.ts` (`(unassigned)` display logic) — no change needed; it
  already renders whatever `project` string it's given.

## Acceptance
- `npm run build` clean
- `npm run typecheck` clean (separate from build — tsup does not typecheck)
- `npm test` — full suite green, including the 3 restored tests and the
  updated assertion
- Live repro flips: re-run the reproduction script (`createTask(paths, 'larry',
  'acme', 'Test task, no explicit project')` against a fresh `dist` build) and
  confirm `content.project === 'larry'` (was `''` before the fix)
- Diff touches only `src/bus/task.ts` and `tests/unit/bus/task.test.ts` — no
  other files
