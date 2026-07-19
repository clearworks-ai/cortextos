# 03 — Build Spec: experiment-window-forced-decision

**Repo:** `/Users/joshweiss/code/cortextos` · **Framework:** one-big-feature · **Plan engine:** Opus
**Verify:** `npm run build && npm test` (must be clean + green, including 6 new tests)

Implement strictly from this spec. All file:line anchors reference the current tree.

---

## Concept

For every `status='running'` experiment across all agents, compute:

```
windowMs  = parseDurationMs(experiment.window)          // src/bus/cron-state.ts:108
expiredAt = Date.parse(experiment.started_at) + windowMs
now       = opts.now ?? Date.now()
ageMs     = now - expiredAt
```

Graduated, idempotent action:

| Condition | Action |
|---|---|
| `parseDurationMs(window)` is `NaN` | `skip-unparseable` — never mutate; daemon logs `experiment_window_unparseable` |
| `started_at` missing OR `Date.parse` NaN | omit (defensive skip; can't compute expiry) |
| `now <= expiredAt` | not expired — omit (no action) |
| `now > expiredAt` AND `now <= expiredAt + grace` AND `!window_flagged_at` | `flag` |
| `now > expiredAt + grace` | `autoclose` |

Grace default = `DEFAULT_EXPERIMENT_GRACE_MS = 24 * 3_600_000`.

---

## File 1 — NEW `src/bus/experiment-sweep.ts` (pure logic)

Imports allowed: `listExperiments`, `loadExperiment`, `saveExperiment`, `autoCloseExpiredExperiment`, type `Experiment` from `./experiment.js`; `parseDurationMs` from `./cron-state.js`. **NO** daemon or event imports.

```ts
export const DEFAULT_EXPERIMENT_GRACE_MS = 24 * 3_600_000;

export interface ExperimentSweepAction {
  id: string;
  agent: string;
  agentDir: string;
  action: 'flag' | 'autoclose' | 'skip-unparseable';
  window: string;
  startedAt: string | null;
  expiredAt: number | null;   // null only for skip-unparseable
  ageMs: number;              // 0 for skip-unparseable
}

export interface ExperimentSweepOptions {
  now?: number;
  graceMs?: number;
  dryRun?: boolean;
}

export function sweepExperiments(
  agentDir: string,
  agentName: string,
  opts?: ExperimentSweepOptions,
): ExperimentSweepAction[];
```

Logic:

1. `const now = opts?.now ?? Date.now();`
2. `const graceMs = opts?.graceMs ?? DEFAULT_EXPERIMENT_GRACE_MS;`
3. `const running = listExperiments(agentDir, { status: 'running' });`
4. For each `exp`:
   - `const windowMs = parseDurationMs(exp.window);`
   - If `Number.isNaN(windowMs)` → push `{ ..., action: 'skip-unparseable', window: exp.window, startedAt: exp.started_at, expiredAt: null, ageMs: 0 }`; **continue** (never mutate even when not dryRun).
   - If `!exp.started_at` → continue (omit).
   - `const started = Date.parse(exp.started_at);` if `Number.isNaN(started)` → continue (omit).
   - `const expiredAt = started + windowMs;` `const ageMs = now - expiredAt;`
   - If `now <= expiredAt` → continue (not expired, omit).
   - If `now <= expiredAt + graceMs`:
     - If `exp.window_flagged_at` is truthy → continue (already flagged; idempotent, omit).
     - Else push `{ ..., action: 'flag', ..., expiredAt, ageMs }`.
   - Else (`now > expiredAt + graceMs`) push `{ ..., action: 'autoclose', ..., expiredAt, ageMs }`.
5. Unless `opts?.dryRun` is true, apply each collected action:
   - `flag`: `const e = loadExperiment(agentDir, action.id); e.window_flagged_at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'); saveExperiment(agentDir, e);`
   - `autoclose`: `autoCloseExpiredExperiment(agentDir, action.id, <reason string below>);`
   - `skip-unparseable`: no mutation.
6. Return the actions array (including skip-unparseable rows, so callers can log them).

**Auto-close reason string (EXACT):**
```
Auto-closed: window <window> expired <ageHrs>h ago without evaluation (forced-decision sweep).
```
Where `<window>` = `exp.window` and `<ageHrs>` = `Math.round(ageMs / 3_600_000)`. Build this string in the sweep and pass it as the `reason` arg to `autoCloseExpiredExperiment`.

---

## File 2 — EDIT `src/bus/experiment.ts`

**2a. Additive field** on `interface Experiment` (currently `:8–28`). Append after `changes_description`:
```ts
  window_flagged_at?: string | null;
```
Optional — additive-only. Do NOT add it to the object literal in `createExperiment` (`:164–184`); absence must parse fine for existing history.

**2b. Export I/O helpers** so the sweep module reuses them (no duplicate I/O). Add `export` to `loadExperiment` (`:106`) and `saveExperiment` (`:114`).

**2c. New exported function** `autoCloseExpiredExperiment`:
```ts
export function autoCloseExpiredExperiment(
  agentDir: string,
  experimentId: string,
  reason: string,
): Experiment;
```
Body (mirror `evaluateExperiment` `:253–357` for side-effect parity):
- `const experiment = loadExperiment(agentDir, experimentId);`
- Guard: `if (experiment.status !== 'running') throw new Error(\`Experiment ${experimentId} is '${experiment.status}', expected 'running'\`);` (mirror `:261`).
- Set: `experiment.status = 'completed'; experiment.completed_at = nowISO(); experiment.decision = 'discard'; experiment.result_value = null;`
- Learning append: `experiment.learning = experiment.learning ? \`${experiment.learning} — ${reason}\` : reason;`
- `saveExperiment(agentDir, experiment);`
- Append `results.tsv` (mirror `:308–328`): create header if missing; row uses `measured_value` = empty string (no measurement), `baseline` = `String(experiment.baseline_value)`, `decision` = `'discard'`, timestamp = `experiment.completed_at`.
- Append `learnings.md` (mirror `:331–345`): header `## ${experiment.id} (discard)`, Metric, Hypothesis, `- **Learning:** ${experiment.learning}`.
- Delete `active.json` (mirror `:347–355`).
- `return experiment;`

Use the existing `nowISO`, `historyDir`, `ensureDir`, `appendFileSync`, `existsSync`, `unlinkSync` already in the file. Do NOT introduce `any`.

---

## File 3 — EDIT `src/bus/reconcile.ts`

Add to `interface DeclaredAgent` (`:42`):
```ts
  /** Absolute path to this agent's dir (orgs/<org>/agents/<name>). */
  dir?: string;
```

---

## File 4 — EDIT `src/daemon/reconcile-trigger.ts`

**4a.** In `gatherDeclaredAgents`, the local `dir` is already computed at `:116`. Add `dir` to the pushed object (`:122–130`), e.g. after `name`: include `dir,`.

**4b.** Import at top: add `sweepExperiments, type ExperimentSweepAction` from `../bus/experiment-sweep.js`, and `sendMessage` from `../bus/message.js`.

**4c.** New private method (mirror `runDueSweep` `:354`):
```ts
private runExperimentSweep(declaredAgents: DeclaredAgent[]): void {
  const emitAgent = this.options.emitAgent ?? 'daemon';
  const emitOrg = this.options.emitOrg ?? this.org;
  const paths = resolvePaths(emitAgent, this.instanceId, emitOrg);

  for (const agent of declaredAgents) {
    const agentDir = agent.dir;
    if (!agentDir) continue;
    let actions: ExperimentSweepAction[];
    try {
      actions = sweepExperiments(agentDir, agent.name, { dryRun: false });
    } catch (err) {
      console.error(`[reconcile-trigger] experiment sweep failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const action of actions) {
      const meta = {
        experiment_id: action.id,
        agent: action.agent,
        window: action.window,
        expired_at: action.expiredAt,
        age_ms: action.ageMs,
      };
      if (action.action === 'flag') {
        logEvent(paths, emitAgent, emitOrg, 'experiment', 'experiment_window_expired', 'warning', meta);
        try {
          const toPaths = resolvePaths(action.agent, this.instanceId, emitOrg);
          sendMessage(toPaths, emitAgent, action.agent, 'normal',
            `Experiment ${action.id} (window ${action.window}) expired ${Math.round(action.ageMs / 3_600_000)}h ago and is unevaluated. Evaluate or it auto-closes as discard after the grace window.`);
        } catch (err) {
          console.error(`[reconcile-trigger] experiment flag message failed for ${action.agent}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (action.action === 'autoclose') {
        logEvent(paths, emitAgent, emitOrg, 'experiment', 'experiment_autoclosed', 'warning', meta);
      } else {
        logEvent(paths, emitAgent, emitOrg, 'experiment', 'experiment_window_unparseable', 'warning', meta);
      }
    }
  }
}
```

**4d.** Wire into `runOnce` right after the `runDueSweep` try/catch (~`:299`), in its own swallow-and-log try/catch:
```ts
try {
  this.runExperimentSweep(declaredAgents);
} catch (err) {
  console.error(`[reconcile-trigger] experiment sweep failed: ${err instanceof Error ? err.message : String(err)}`);
}
```
(`declaredAgents` is already in scope from `:268`.)

---

## File 5 — EDIT `src/cli/bus.ts`

Add near the experiment commands (~`:1307`). Dry-run is the DEFAULT; only `--apply` mutates. `sendMessage` is already imported (`:6`); `parseDurationMs` may need importing from `../bus/cron-state.js` for `--grace`.

```ts
busCommand
  .command('sweep-experiments')
  .description('Sweep running experiments for expired windows (flag/auto-close)')
  .option('--apply', 'Apply mutations (flag / auto-close). Default is dry-run.', false)
  .option('--grace <dur>', 'Grace window after expiry before auto-close (e.g. 24h)')
  .option('--dry-run', 'Compute + print actions without mutating (default).', false)
  .action((opts: { apply?: boolean; grace?: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const graceMs = opts.grace ? parseDurationMs(opts.grace) : undefined;
    const dryRun = !opts.apply;   // apply wins; default dry-run
    const actions = sweepExperiments(agentDir, env.agentName, { graceMs, dryRun });
    // print an actions table: id | action | window | ageHrs
    for (const a of actions) {
      console.log(`${a.id}\t${a.action}\t${a.window}\t${Math.round(a.ageMs / 3_600_000)}h`);
    }
    console.log(`${actions.length} action(s)${dryRun ? ' (dry-run — nothing mutated)' : ''}`);
  });
```
Import `sweepExperiments` from `../bus/experiment-sweep.js`. If `--grace` yields `NaN`, treat as undefined (fall back to default). Use `console.log` here only inside CLI action output — that is the established pattern in this file for command output. (The no-`console.log` rule targets library/daemon code, not CLI print output; match the surrounding `evaluate-experiment` command which uses `console.log`.)

---

## Tests — NEW `tests/experiment-sweep.test.ts`

Mirror `tests/sprint3-experiments.test.ts` (temp `agentDir` under `tmpdir()`, `mkdirSync(join(dir,'experiments','history'),{recursive:true})` in `beforeEach`, `rmSync` in `afterEach`). Use `createExperiment` + `runExperiment` to set up, then hand-edit the persisted JSON's `started_at` (write directly to `experiments/history/<id>.json`) to place expiry relative to a fixed injected `now`. Drive `now` explicitly in every case.

Enumerate exactly these 6 cases:

1. **flag + idempotent** — running exp, `started_at` set so `now` is past `expiredAt` but within grace. First `sweepExperiments(dir, agent, { now, dryRun:false })` → one action `action:'flag'`; reload JSON → `window_flagged_at` is set. Second sweep with the same `now` → returns `[]` (no flag), and `window_flagged_at` unchanged.
2. **autoclose + idempotent + fields** — running exp, `now > expiredAt + grace`. Sweep → one `action:'autoclose'`; reload → `status==='completed'`, `decision==='discard'`, `result_value===null`, `completed_at` truthy, `learning` contains `"Auto-closed"` and the window label. Second sweep → `[]` (now completed, filtered out).
3. **skip-unparseable** — running exp with `window:'0 8 * * *'` (or `'weekly'`). Sweep (`dryRun:false`) → one `action:'skip-unparseable'`; reload → still `status==='running'`, no `window_flagged_at`, `decision` unchanged (not auto-closed).
4. **not-yet-expired** — running exp with `started_at` such that `now < expiredAt`. Sweep → `[]`; reload → unchanged (`status==='running'`, no `window_flagged_at`).
5. **proposed/completed ignored** — one `proposed` exp (never run) and one `completed` exp (run+evaluate), both with old `started_at`/window. Sweep → `[]`; neither mutated.
6. **dryRun mutates nothing** — running exp past `expiredAt + grace` (would autoclose). `sweepExperiments(dir, agent, { now, dryRun:true })` → returns one `action:'autoclose'` (computed), but reload → still `status==='running'`, no field changes on disk.

---

## Guardrails (enforced in adversarial review)

- **Additive-only** to Experiment JSON — existing history without `window_flagged_at` must parse. Verify by running against a JSON that lacks the field.
- **No `any`.** No `console.log` in library/daemon code (`console.error` for swallowed daemon errors OK; CLI command output uses `console.log` per existing pattern in `src/cli/bus.ts`).
- **Injectable clock** — `sweepExperiments` uses `opts.now ?? Date.now()`; tests never touch the wall clock.
- **Idempotent** — flag suppressed by `window_flagged_at`; autoclose flips status out of `running` so re-sweep is a no-op; skip-unparseable never mutates.
- **Never auto-close on unparseable window.**
- `npm run build` clean + `npm test` green including all 6 new tests.
