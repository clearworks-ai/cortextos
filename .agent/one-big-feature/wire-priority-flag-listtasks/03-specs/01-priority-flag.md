# Spec 01 — `--priority` option on `list-tasks`

**File:** `src/cli/bus.ts` — the `.command('list-tasks')` block (starts line 470).

## Change 1 — add the option
Alongside the existing `.option(...)` lines (471-478), add:
```ts
.option('--priority <p>', 'Filter by priority: urgent | high | normal | low')
```
Place it logically near `--status` (both are per-task field filters).

## Change 2 — widen the action signature
The `.action((opts: { ... })` type (line 479) must include `priority?: string`.

## Change 3 — forward into the filter
In the `listTasks(paths, { ... })` call (lines 487-492), add:
```ts
priority: opts.priority as Priority | undefined,
```
`Priority` is already imported paths in `src/bus/task.ts`; in `src/cli/bus.ts` import it from
`../types/index.js` if not already imported (check existing imports first — do NOT duplicate).
`listTasks` filter at `src/bus/task.ts:714` already applies `filters.priority`.

## Tests — `tests/unit/cli/` (match existing bus list-tasks test style)
- `list-tasks --priority urgent` → only urgent-priority tasks returned.
- No `--priority` → unchanged (all priorities present in output).

## Constraints
- No `any`. No `console.log` added. Match surrounding commander `.option` style exactly.
- Do NOT touch `listTasks` logic — filter already exists.
- ~2 source lines + 1 signature field + test.
