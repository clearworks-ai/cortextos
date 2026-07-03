# Spec 01 — ci-alert-gate

## Goal
A deterministic `cortextos bus ci-alert-gate` command that decides whether a GitHub CI failure is worth surfacing, replacing three fragile prose gates in `comms-check-worker/SKILL.md` that an LLM worker mis-executes. Output is binary: `SURFACE` or `SKIP`.

## Files

### NEW `src/utils/ci-alert-gate.ts`
Export a pure evaluator and a thin gh-gather helper. NO `any`, no `console.log`.

```ts
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | 'NOTFOUND';
export type RunConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | 'stale' | null;
export type CompareStatus = 'behind' | 'identical' | 'ahead' | 'diverged' | null;

export interface CiRun {
  headSha: string;
  status: string;          // 'completed' | 'in_progress' | 'queued' | ...
  conclusion: RunConclusion;
  createdAt: string;       // ISO8601
}

export interface CiAlertInput {
  prState: PrState;
  runs: CiRun[];           // any order; evaluator sorts by createdAt desc
  headSha?: string;        // SHA from the failing email, if known
  compareStatus?: CompareStatus; // gh api compare/main...<headSha>, if headSha known
  ghError?: boolean;       // true if context gathering hit a gh/auth/network error
}

export interface CiAlertDecision {
  surface: boolean;
  reason: string;          // human-readable, e.g. 'skip: newer run succeeded'
}

// PURE — no I/O. Deterministic. Fully unit-tested.
export function evaluateCiAlert(input: CiAlertInput): CiAlertDecision;

// ONLY function that shells out. execFileSync('gh', [...]) per src/bus/catalog.ts pattern.
// Returns a CiAlertInput (sets ghError:true and empty runs on any failure).
export function gatherCiAlertContext(
  repo: string,            // 'owner/repo'
  branch: string,
  opts?: { headSha?: string }
): CiAlertInput;
```

**`evaluateCiAlert` decision order (first match wins → SKIP unless final):**
1. `ghError === true` → `{ surface:false, reason:'skip: gh context unavailable (fail-safe)' }`. FAIL-SAFE toward SKIP by design — repo-health cron is the real CI safety net.
2. `prState === 'MERGED'` → SKIP `'skip: PR merged'`.
3. `prState === 'CLOSED'` → SKIP `'skip: PR closed'`.
4. If `headSha` present and `compareStatus === 'behind' || 'identical'` → SKIP `'skip: head SHA already in main'`.
5. Sort `runs` by `createdAt` descending. Find the newest run.
   - If there are NO runs → SKIP `'skip: no runs found'` (nothing to alert on; fail-safe).
   - If the newest run's `status !== 'completed'` (in_progress/queued) → SKIP `'skip: latest run still in progress'`.
   - Find the newest *completed* run. If its `conclusion === 'success'` (or any non-`failure`/non-`timed_out` terminal conclusion such as `cancelled`/`skipped`/`neutral`) → SKIP `'skip: newer run succeeded'` / `'skip: latest run not a failure'`.
   - Only if the newest completed run's `conclusion` is `failure` or `timed_out` → continue.
6. Reaching here means: PR is OPEN (or NOTFOUND), SHA is not already in main, and the LATEST completed run is a genuine failure → `{ surface:true, reason:'surface: open PR, latest run failed' }`.

Note on `prState === 'NOTFOUND'`: do not SKIP solely on NOTFOUND (a failing run with no PR can still be real) — fall through to the run-based gates. The run gates (newest-run-is-green / no-runs) still protect against stale noise.

**`gatherCiAlertContext` implementation:**
- `prState`: `execFileSync('gh', ['pr','list','--repo',repo,'--state','all','--head',branch,'--json','state','--jq','.[0].state // "NOTFOUND"'])`, trim; map to PrState (uppercase; unknown → 'NOTFOUND').
- `runs`: `execFileSync('gh', ['run','list','--repo',repo,'--branch',branch,'--limit','10','--json','headSha,status,conclusion,createdAt'])`, `JSON.parse`.
- `compareStatus` (only if `opts.headSha`): `execFileSync('gh', ['api',`repos/${repo}/compare/main...${opts.headSha}`,'--jq','.status'])`, trim; map or null.
- Wrap EACH call so any throw (gh missing, auth, network, non-zero exit) sets `ghError = true` and returns immediately with `{ prState:'NOTFOUND', runs:[], headSha:opts?.headSha, ghError:true }`.
- Use `{ encoding:'utf8', stdio:['ignore','pipe','ignore'] }` so gh stderr does not leak to the worker's stdout.

### EDIT `src/cli/bus.ts`
Add near the other read-only sweep commands (e.g. after `reconcile-crons`, ~line 2296). Import `evaluateCiAlert, gatherCiAlertContext` from `../utils/ci-alert-gate`.

```
busCommand
  .command('ci-alert-gate')
  .description('Deterministically decide whether a GitHub CI failure should be surfaced (SURFACE/SKIP)')
  .requiredOption('--repo <owner/repo>', 'GitHub repo, e.g. clearworks-ai/cortextos')
  .requiredOption('--branch <branch>', 'Branch the failing run is on')
  .option('--head-sha <sha>', 'Head SHA from the failing run/email (enables the behind-main gate)')
  .option('--json', 'Emit { surface, reason } as JSON instead of SURFACE/SKIP')
  .action((opts) => {
    const ctx = gatherCiAlertContext(opts.repo, opts.branch, { headSha: opts.headSha });
    const decision = evaluateCiAlert(ctx);
    if (opts.json) { console.log(JSON.stringify(decision)); return; }
    console.log(decision.surface ? 'SURFACE' : 'SKIP');
  });
```
(The `console.log` here is the command's stdout contract — same as `reconcile-crons` printing `CLEAN`. Not a debug log.)

### NEW `tests/unit/utils/ci-alert-gate.test.ts`
Vitest, table-driven over the PURE `evaluateCiAlert` (no gh, no network). Mirror `tests/unit/utils/cron-prompt-validator.test.ts` style. Cover at minimum:

| case | input | expect |
|---|---|---|
| stale failure superseded by green (PR #39 real scenario) | prState OPEN, runs=[{3291433,completed,success,06:01},{1c35662,completed,failure,05:25}], headSha=1c35662, compareStatus=diverged | surface:false |
| PR merged | prState MERGED, any runs | surface:false |
| PR closed | prState CLOSED, any runs | surface:false |
| head SHA behind main | prState OPEN, compareStatus behind, headSha set | surface:false |
| head SHA identical to main | prState OPEN, compareStatus identical | surface:false |
| open PR, latest run failed, SHA ahead | prState OPEN, runs=[{sha,completed,failure,now}], compareStatus ahead | surface:true |
| open PR, latest run in progress | prState OPEN, runs=[{sha,in_progress,null,now},{sha,completed,failure,earlier}] | surface:false |
| no runs | prState OPEN, runs=[] | surface:false |
| gh error fail-safe | ghError:true | surface:false |
| NOTFOUND PR but latest run failed | prState NOTFOUND, runs=[{sha,completed,failure,now}] | surface:true |

Assert on both `surface` and that `reason` is a non-empty string.

## Verify (codexer must run before returning diff)
1. `npm run typecheck` — clean (tsc --noEmit; the CI gate — `npm run build`/tsup does NOT type-check).
2. `npm run build` — clean.
3. `npx vitest run tests/unit/utils/ci-alert-gate.test.ts` — green.

## Out of scope
- SKILL.md edits (Larry-owned .md).
- `send-message` reworded-dedup (separate task_1782975510530_74147799).
- Any change to repo-health cron or Railway alerting.
