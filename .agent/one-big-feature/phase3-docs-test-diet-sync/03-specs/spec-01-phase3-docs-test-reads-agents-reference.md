# Spec: phase3-docs.test.ts must read AGENTS-REFERENCE.md alongside AGENTS.md

## Problem

PR#159 CI (`Unit Tests`) fails on `tests/integration/phase3-docs.test.ts`. 16 assertions
fail for `templates/agent/AGENTS.md` and `templates/orchestrator/AGENTS.md` — e.g.
"contains get-cron-log command", "contains '## External Persistent Crons' section
header", "mentions .crons-migrated marker file".

This is NOT a content regression. The 2026-07-26 fleet "boot-floor diet" (per project
memory `feedback_claude_md_floor_cut_is_reference_diet_not_global_dedup`) deliberately
moved this low-frequency detail out of `templates/agent/AGENTS.md` and
`templates/orchestrator/AGENTS.md` into sibling `templates/agent/AGENTS-REFERENCE.md`
and `templates/orchestrator/AGENTS-REFERENCE.md` files, to cut boot-time token load.
`templates/agent/AGENTS.md` correctly cross-references it: "Full details: read
AGENTS-REFERENCE.md §external-persistent-crons when needed - do NOT read at boot."

`templates/analyst/AGENTS.md` was NOT part of that diet and still has everything inline
— it has no `AGENTS-REFERENCE.md` sibling and still passes today.

The test was never updated after the diet landed, so it's asserting a doc layout that
was intentionally changed. Confirmed via `git show HEAD:templates/agent/AGENTS-REFERENCE.md`
— all the missing strings (`get-cron-log`, `.crons-migrated`, `## External Persistent
Crons`, etc.) exist there verbatim.

## Fix

In `tests/integration/phase3-docs.test.ts`:

1. Near the top, alongside the existing `TEMPLATE_AGENTS_MD` / `TEMPLATE_NAMES` arrays,
   add a helper that reads a template's `AGENTS.md` content and, if a sibling
   `AGENTS-REFERENCE.md` exists next to it (same directory, replace the filename),
   appends its content too:

   ```ts
   function readTemplateDocs(agentsMdPath: string): string {
     const referencePath = agentsMdPath.replace(/AGENTS\.md$/, 'AGENTS-REFERENCE.md');
     return readRequired(agentsMdPath) + (existsSync(referencePath) ? read(referencePath) : '');
   }
   ```

   (`read` and `readRequired` already exist in the file — reuse them, don't duplicate.)

2. In the `describe('3.1 — templates/*/AGENTS.md External Persistent Crons section', ...)`
   block, every `it(...)` currently does:
   ```ts
   content = readRequired(filePath);
   ```
   Change each of these call sites to:
   ```ts
   content = readTemplateDocs(filePath);
   ```
   Do NOT change the very first `it('file exists', ...)` block — that one specifically
   checks `AGENTS.md` exists on its own and should keep calling `readRequired(filePath)`
   directly (AGENTS.md must always exist standalone; AGENTS-REFERENCE.md is optional).

3. Leave every other `describe` block in this file untouched (the "no stale cronlist
   pattern" checks, `CRONS_MIGRATION_GUIDE.md` checks, etc.) — this fix is scoped only
   to the 3.1 block's content-source, nothing else in the file's contract changes.

## Acceptance

- `npx vitest run tests/integration/phase3-docs.test.ts` — all tests pass.
- `npm test` (full suite) — no new failures introduced elsewhere.
- `npm run build` — clean (this is a test-only change, should be a no-op for build).
- Do not touch any file under `templates/` or `src/` — this fix is scoped to the one
  test file.
