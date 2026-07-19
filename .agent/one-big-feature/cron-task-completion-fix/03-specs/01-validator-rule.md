# Spec 01 — Validator rule: `cron-task-leak-no-complete`

Target file: `/Users/joshweiss/code/cortextos/src/utils/cron-prompt-validator.ts`
Test file: `/Users/joshweiss/code/cortextos/tests/unit/utils/cron-prompt-validator.test.ts` (extend, do not rewrite)

No other production file changes. `src/bus/crons.ts:199` already calls `validateCronsPrompt` in `writeCrons`; `src/cli/bus.ts:3049` already uses `findBannedCronPrompts` — both pick up the new pattern automatically.

## Change 1 — leak regex constant + pattern entry

Add a module-level exported constant (above `BANNED_CRON_PROMPT_PATTERNS`, current L21):

```ts
export const CRON_TASK_LEAK_PATTERN_ID = 'cron-task-leak-no-complete';

const CRON_TASK_LEAK_RE =
  /^(?=[\s\S]*\bcreate-task\b)(?=[\s\S]*\bupdate-task\b[\s\S]{0,120}\bin_progress\b)(?![\s\S]*\bcomplete-task\b)/;
```

Detection logic in prose: anchored at start of the prompt, three lookaheads over the whole string —
1. positive: the literal token `create-task` appears anywhere (the prompt creates a bus task);
2. positive: the literal token `update-task` appears with `in_progress` within 120 chars after it (the prompt marks that task in_progress — the 120-char window binds the two tokens to the same command; real segments are `update-task $TASK_ID in_progress`, ~25 chars);
3. negative: the literal token `complete-task` appears NOWHERE in the prompt.

All three true → leak. No flags (case-sensitive — these are literal CLI subcommand tokens). No `g` flag (the existing `pattern.re.lastIndex = 0` reset at L92 stays harmless).

Example that MUST match (real larry `heartbeat` prompt from live state):
```
cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; TASK_ID=$(cortextos bus create-task "Cron: heartbeat" --desc "Scheduled cron run" 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; Read HEARTBEAT.md and follow its instructions. ...
```
MUST NOT match: (a) usage-audit shape — same as above plus `cortextos bus complete-task $TASK_ID …` later in the prompt; (b) passive-heartbeat shape — `cortextos bus update-cron-fire heartbeat …; cortextos bus log-event …; Read HEARTBEAT.md …` (no `create-task`).

Append the pattern entry to `BANNED_CRON_PROMPT_PATTERNS` (after the existing `full-human-task-list-telegram` entry, L22-25):

```ts
{
  id: CRON_TASK_LEAK_PATTERN_ID,
  re: CRON_TASK_LEAK_RE,
  hint:
    'Cron prompts must not create a bus task and mark it in_progress without a ' +
    'complete-task in the same prompt — that leaks tasks stuck in_progress. ' +
    'Drop the task bookkeeping (update-cron-fire + log-event already record the fire) ' +
    'or complete the task in the same prompt.',
},
```

## Change 2 — optional `hint` on the pattern interface (message stays byte-compatible for the existing pattern)

Extend the interface (L5-8):

```ts
export interface BannedCronPromptPattern {
  id: string;
  re: RegExp;
  hint?: string;
}
```

Give the EXISTING `full-human-task-list-telegram` entry this hint (exactly the sentence currently hardcoded in the throw at L111):

```ts
hint: 'This prompt was blocked to prevent a known Telegram-spam recurrence.',
```

Do NOT change `BannedCronPromptMatch` (stays `{ name, patternId }` — the existing test at test-file L48-56 asserts `toEqual` on that exact shape). Do NOT change `findBannedCronPrompts`, `loadOverlayPatterns`, `isOverlayPatternEntry` behavior (overlay entries simply never have a hint; if a `hint` string is present in an overlay JSON entry it may be passed through, but validating/typing it is NOT required — ignore unknown overlay fields as today).

## Change 3 — throw site (L103-114) resolves hint per pattern

Replace `validateCronsPrompt` body with:

```ts
export function validateCronsPrompt(crons: CronDefinition[]): void {
  const [match] = findBannedCronPrompts(crons);
  if (!match) {
    return;
  }

  const pattern = allPatterns().find(p => p.id === match.patternId);
  const hint =
    pattern?.hint ?? 'This prompt was blocked to prevent a known bad-cron recurrence.';

  throw new Error(
    `Refusing to write cron "${match.name}": prompt matches banned pattern ` +
      `"${match.patternId}". ${hint} ` +
      `Edit the prompt or update state/cron-banned-patterns.json.`
  );
}
```

Same error type (`Error`), same message shape (`Refusing to write cron "<name>": prompt matches banned pattern "<id>". <sentence> Edit the prompt or update state/cron-banned-patterns.json.`), same call site (`writeCrons`, src/bus/crons.ts:199). For the Telegram pattern the produced message is byte-identical to today's.

## Change 4 — exported predicate (consumed by the migration script, spec 02)

```ts
export function isCronTaskLeakPrompt(prompt: string): boolean {
  return CRON_TASK_LEAK_RE.test(prompt);
}
```

## Tests (extend `tests/unit/utils/cron-prompt-validator.test.ts`)

Match the existing harness exactly: tmpdir `CTX_ROOT`, `vi.resetModules()` in `beforeEach`, `makeCron(prompt, name)` helper, dynamic `importValidator()`. Add a new `describe('cron task-lifecycle leak pattern', …)` with:

1. **leak prompt rejected** — `validateCronsPrompt([makeCron(LEAK_PROMPT)])` throws `/cron-task-leak-no-complete/`, and `findBannedCronPrompts` returns `[{ name: 'heartbeat', patternId: 'cron-task-leak-no-complete' }]`. Use the real larry heartbeat prompt string quoted above as `LEAK_PROMPT`.
2. **create+complete in one block allowed** — prompt: `cortextos bus update-cron-fire usage-audit --interval 1d 2>/dev/null; TASK_ID=$(cortextos bus create-task "Cron: usage-audit" --desc "Scheduled cron run" 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; cortextos bus complete-task $TASK_ID 2>/dev/null; Run the usage audit.` → `validateCronsPrompt` does `not.toThrow()` and `findBannedCronPrompts` returns `[]`.
3. **no-task prompt allowed** — prompt: `cortextos bus update-cron-fire heartbeat --interval 4h 2>/dev/null; cortextos bus log-event cron-fired heartbeat 2>/dev/null; Read HEARTBEAT.md and follow its instructions.` → `not.toThrow()`, `findBannedCronPrompts` returns `[]`.
4. **regression: Telegram floor message unchanged** — `validateCronsPrompt([makeCron('Send the full HUMAN task list via Telegram.')])` throws a message containing `known Telegram-spam recurrence`.

## Acceptance criteria

- [ ] `npm run typecheck` clean; `npm run build` clean.
- [ ] All 4 new cases pass; all 3 pre-existing cases in the file pass UNMODIFIED.
- [ ] `findBannedCronPrompts` match objects still have exactly the keys `name`, `patternId`.
- [ ] `writeCrons` (src/bus/crons.ts) untouched.
- [ ] `CRON_TASK_LEAK_PATTERN_ID` and `isCronTaskLeakPrompt` are exported (spec 02 imports them).
- [ ] No `any`, no `console.log`.
