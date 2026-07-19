# Spec 02 — Migration script: strip task-leak bookkeeping from live cron prompts

Target file (NEW): `/Users/joshweiss/code/cortextos/scripts/migrate-cron-task-leak.ts`
Test file (NEW): `/Users/joshweiss/code/cortextos/tests/unit/scripts/migrate-cron-task-leak.test.ts`
Convention source: `scripts/migrate-runtime-field.ts` + `tests/unit/scripts/migrate-runtime-field.test.ts` (same header-comment style, exported pure functions + `runMigration`, tsx CLI entrypoint, `--root` override). Divergence from that script, LOCKED by design: **default is dry-run; `--apply` is required to write** (it touches live fleet runtime state).

## Imports

```ts
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync } from '../src/utils/atomic.js';
import { isCronTaskLeakPrompt } from '../src/utils/cron-prompt-validator.js';
```

(tsx and vitest both resolve the `.js` specifiers to the `.ts` sources — same pattern the test suite already uses. Reusing `isCronTaskLeakPrompt` keeps detection in lockstep with the validator — never re-implement the leak regex here.)

## Discovery — `findCronsFiles`

```ts
export function findCronsFiles(rootsDir: string): string[]
```

- `rootsDir` default: `join(homedir(), '.cortextos')`.
- For each immediate subdirectory `<sub>` of `rootsDir` (live: `cortextos1`, `default`; skip non-directories), look in `join(rootsDir, sub, '.cortextOS', 'state', 'agents')`. If that dir exists, collect `join(agentsDir, <agent>, 'crons.json')` for every agent subdirectory where the file exists and is a regular file.
- Return sorted absolute paths. Missing dirs → skipped silently. (Path constants: `CRONS_DIRECTORY = '.cortextOS/state/agents'`, `CRONS_FILENAME = 'crons.json'` — src/bus/crons-schema.ts:21,28. Hardcoding the literals here is fine; the script sweeps multiple roots so it cannot use the CTX_ROOT-based `cronsFilePath`/`writeCrons` from src/bus/crons.ts.)

## Strip logic — `stripTaskLeakBookkeeping`

```ts
export interface StripResult {
  prompt: string;        // resulting prompt (== input when changed === false)
  changed: boolean;
  manualReview: boolean; // true → residue detected, DO NOT write this cron
}

export function stripTaskLeakBookkeeping(prompt: string): StripResult
```

Behavior:
1. If `!isCronTaskLeakPrompt(prompt)` → `{ prompt, changed: false, manualReview: false }`. **Never touch non-leaky prompts** (usage-audit, passive-heartbeat, anything else).
2. Remove the bookkeeping segment with this regex (global, replace every occurrence with a single space `' '`):

```ts
const BOOKKEEPING_SEGMENT_RE =
  /\s*TASK_ID=\$\(\s*cortextos bus create-task\s+("[^"]*"|'[^']*')(?:\s+--desc\s+("[^"]*"|'[^']*'))?[^)]*\)\s*;\s*cortextos bus update-task \$TASK_ID in_progress[^;]*(?:;|$)\s*/g;
```

Prose: match (optionally-surrounding whitespace plus) `TASK_ID=$(cortextos bus create-task` + a single- OR double-quoted title + optional `--desc` with a single- or double-quoted value + any trailing chars up to the closing `)` (e.g. ` 2>/dev/null`) + `;` + `cortextos bus update-task $TASK_ID in_progress` + everything up to and including the next `;` (or end of string). Both live quoting variants must strip — double: `create-task "Cron: heartbeat" --desc "Scheduled cron run" 2>/dev/null`, single: `create-task 'Cron: news-intelligence' --desc 'Daily ICP-relevant news digest' 2>/dev/null`.

3. After replacement: `result = result.replace(/ {2,}/g, ' ').trim()` (collapse doubled spaces at the junction only — do not touch newlines).
4. **Residue safety check**: if the result still contains `$TASK_ID`, `create-task`, or `cortextos bus update-task` → return `{ prompt: <ORIGINAL unmodified prompt>, changed: false, manualReview: true }`. The runner reports it and leaves the cron alone.
5. Otherwise → `{ prompt: result, changed: true, manualReview: false }`.

Worked example — input (real larry `heartbeat`):
```
cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; TASK_ID=$(cortextos bus create-task "Cron: heartbeat" --desc "Scheduled cron run" 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; Read HEARTBEAT.md and follow its instructions. Update heartbeat, check inbox, run fleet health check across all 3 repos.
```
output:
```
cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; Read HEARTBEAT.md and follow its instructions. Update heartbeat, check inbox, run fleet health check across all 3 repos.
```
`update-cron-fire`, natural-language instructions, and any `log-event` lines stay intact.

Idempotency follows structurally: a stripped prompt no longer matches `isCronTaskLeakPrompt` → step 1 short-circuits on the second run.

## Runner — `runMigration`

```ts
export interface MigrationOptions { rootsDir: string; dryRun: boolean; }

export interface FileChange {
  path: string;
  crons: { name: string; before: string; after: string }[];
}

export interface MigrationReport {
  filesScanned: number;
  leaksFound: number;
  stripped: number;
  changes: FileChange[];
  manualReview: { path: string; cron: string }[];
}

export function runMigration(opts: MigrationOptions): MigrationReport
```

Per crons.json file:
1. `JSON.parse(readFileSync(path, 'utf-8'))` — envelope `{ updated_at: string; crons: { name; prompt; … }[] }` (disk format per src/bus/crons.ts:29-33). Unparseable or non-envelope file → skip with a warning line to stderr, count in `filesScanned`, never write.
2. Map each cron through `stripTaskLeakBookkeeping(cron.prompt)`; count leaks (`changed || manualReview`), collect changes/manualReview entries. Preserve every other cron field untouched (spread: `{ ...cron, prompt: result.prompt }`).
3. If ≥1 cron changed AND `!dryRun`: set `envelope.updated_at = new Date().toISOString()` and write with `atomicWriteSync(path, JSON.stringify(envelope, null, 2), /* keepBak= */ true)` — atomic tmp+rename plus a `crons.json.bak` rollback point (src/utils/atomic.ts). Do NOT route through `writeCrons` (CTX_ROOT-bound, single-root; the direct atomic write is the multi-root path).
4. Dry-run: identical scan/report, zero writes.

## CLI entrypoint (bottom of file, matching migrate-runtime-field.ts)

- Args: `--apply` (write; absent → dry-run), `--root <path>` (override rootsDir; default `~/.cortextos`).
- Output: one line per planned/applied change — `[dry-run|apply] <path> :: <cron name>` plus the removed segment; final summary line with `filesScanned / leaksFound / stripped / manualReview count`. Dry-run mode ends with an explicit `Dry run — no files written. Re-run with --apply to write.`
- Exit 0 on success (including 0 leaks); exit 1 if any file failed to parse or any manualReview entry exists (operator must look).
- Guard the entrypoint so importing the module from tests does not execute it (same pattern migrate-runtime-field.ts uses for its `main()` invocation — mirror it exactly).

## Tests — `tests/unit/scripts/migrate-cron-task-leak.test.ts`

Style: mirror `tests/unit/scripts/migrate-runtime-field.test.ts` — `mkdtempSync` root in `beforeEach`, `rmSync` in `afterEach`, a `seed(sub, agent, crons)` helper that writes `join(root, sub, '.cortextOS', 'state', 'agents', agent, 'crons.json')` with the `{ updated_at, crons }` envelope, static imports of `runMigration`, `stripTaskLeakBookkeeping`, `findCronsFiles` from `../../../scripts/migrate-cron-task-leak`.

Fixture crons (use the exact worked-example strings above):
- `heartbeat` — leaky (double-quoted segment).
- `news-intelligence` — leaky (single-quoted segment).
- `usage-audit` — good: create + in_progress + `complete-task` in one block.
- `passive` — no task bookkeeping at all.

Cases (enumerated):
1. **strips leaky, preserves the rest** — `runMigration({ rootsDir: root, dryRun: false })`: `heartbeat` prompt equals the exact expected stripped string; `news-intelligence` stripped (no `TASK_ID`/`create-task`/`in_progress` remain); `usage-audit` and `passive` prompts byte-identical to seeded; report `leaksFound === 2`, `stripped === 2`.
2. **dry-run writes nothing** — `dryRun: true`: report shows the 2 planned strips; file content on disk byte-identical to seeded; no `crons.json.bak` created.
3. **idempotent** — apply twice: second report `leaksFound === 0`, `stripped === 0`; file content identical between runs.
4. **backup written on apply** — after apply, `crons.json.bak` exists and parses to the ORIGINAL (leaky) crons.
5. **non-cron fields survive** — seeded cron extra fields (`schedule`, `enabled`, `created_at`) unchanged after apply.
6. **residue → manualReview, untouched** — seed a cron whose prompt has the bookkeeping segment PLUS a second stray `cortextos bus update-task $TASK_ID in_progress` later in the prompt; after apply, its prompt is unchanged on disk and report `manualReview` contains `{ path, cron }`.
7. **findCronsFiles sweeps both roots** — seed under `cortextos1/` and `default/`; returns both paths, sorted; ignores a stray plain file in `rootsDir`.

## Acceptance criteria

- [ ] `npm run typecheck` + `npm run build` clean; all 7 test cases pass.
- [ ] Detection is `isCronTaskLeakPrompt` from spec 01 — no duplicated leak regex.
- [ ] Default invocation (`npx tsx scripts/migrate-cron-task-leak.ts`) writes NOTHING.
- [ ] `--apply` writes via `atomicWriteSync(…, true)` only for files with ≥1 stripped cron; non-leaky crons and non-leaky files byte-untouched.
- [ ] Idempotent; residue cases never written, reported, exit code 1.
- [ ] No `any`, no `console.log` in src/ (script CLI output via `process.stdout.write`/`console.error` is acceptable only if migrate-runtime-field.ts does the same — match its output mechanism exactly).
