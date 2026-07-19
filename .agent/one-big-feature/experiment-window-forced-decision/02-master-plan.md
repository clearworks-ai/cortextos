# 02 — Master Plan: experiment-window-forced-decision

- **Framework:** one-big-feature
- **Plan engine:** Opus
- **Repo:** `/Users/joshweiss/code/cortextos`
- **Verify command:** `npm run build && npm test`

## Problem

`window` on an experiment is a descriptive LABEL (`"24h"`, `"7d"`) — never computed to an expiry. `status=running` experiments can sit indefinitely with zero evaluation (theta-wave found 3 running 15–35 days). This feature adds a forcing function: a periodic daemon sweep that, for every `status=running` experiment across all agents, computes the expiry from `started_at + window`, and takes a graduated, idempotent action:

- **FLAG** (once) when `now > expiredAt` but still within a grace window (default 24h): emit `experiment_window_expired`, message the owning agent, set `window_flagged_at` to suppress re-flagging.
- **AUTO-CLOSE** when `now > expiredAt + grace`: `status=completed`, `decision=discard`, `result_value=null`, append a machine learning note.
- **SKIP** when `parseDurationMs(window)` is `NaN` (unparseable/cron/free-text): log `experiment_window_unparseable`, **never** auto-close.

Everything is idempotent (re-running the sweep is a no-op after the action has been applied) and clock-injectable (tests never touch the wall clock).

## Architecture (mirror the existing task due-sweep — do NOT invent a new loop)

The task overdue-sweep is the proven precedent: pure logic module (`sweepDueTasks` in `src/bus/task.ts`) + daemon caller (`runDueSweep` in `src/daemon/reconcile-trigger.ts:354`) + CLI entry, all idempotent, dry-run-capable, event-emitting, owner-messaging. This feature mirrors that exact shape.

### 1. NEW `src/bus/experiment-sweep.ts` — pure logic

- `export const DEFAULT_EXPERIMENT_GRACE_MS = 24 * 3_600_000;`
- `export interface ExperimentSweepAction { id; agent; agentDir; action: 'flag'|'autoclose'|'skip-unparseable'; window; startedAt; expiredAt; ageMs }`
- `export interface ExperimentSweepOptions { now?: number; graceMs?: number; dryRun?: boolean }`
- `export function sweepExperiments(agentDir: string, agentName: string, opts?: ExperimentSweepOptions): ExperimentSweepAction[]`
  - Lists `status=running` experiments via `listExperiments(agentDir, { status: 'running' })` (`src/bus/experiment.ts:363`).
  - For each: `windowMs = parseDurationMs(window)` (`src/bus/cron-state.ts:108`).
    - `NaN` → action `skip-unparseable` (never mutate).
    - `started_at` missing / `Date.parse` NaN → skip silently (defensive; can't compute expiry, omit from results).
    - `expiredAt = Date.parse(started_at) + windowMs`; `now = opts.now ?? Date.now()`; `ageMs = now - expiredAt`.
    - `now <= expiredAt` → not expired, no action (omit from results).
    - `now > expiredAt` and `now <= expiredAt + grace` → action `flag`, **only if `window_flagged_at` is falsy** (idempotent; already-flagged → omit).
    - `now > expiredAt + grace` → action `autoclose`.
  - Unless `dryRun`: apply each action — `flag` sets `window_flagged_at` and persists via `experiment.ts` helpers; `autoclose` calls `autoCloseExpiredExperiment()` (in `experiment.ts`).
  - Keep this module free of daemon/event imports — **pure logic + file I/O via `experiment.ts` helpers only**. Injectable `now` so tests never touch the wall clock.

### 2. EDIT `src/bus/experiment.ts`

- Additive optional field on `Experiment` (`:8–28`): `window_flagged_at?: string | null;` — additive-only; existing history JSON without it must still parse (optional, no reader requires it).
- New exported `autoCloseExpiredExperiment(agentDir, id, reason)`:
  - Guards `status === 'running'` (throw otherwise, mirroring the guard at `:261`).
  - Sets `completed_at`, `decision = 'discard'`, `result_value = null`, appends `reason` to `learning`.
  - Reuses `evaluateExperiment`'s side-effect parity (`:305–355`): `saveExperiment`, append `results.tsv`, append `learnings.md`, delete `active.json`.
- Export the internal write/loader helpers `experiment-sweep.ts` needs (`loadExperiment`, `saveExperiment`) rather than duplicating I/O in the sweep module.

### 3. EDIT `src/daemon/reconcile-trigger.ts` (+ `src/bus/reconcile.ts`)

- Expose `dir` on `DeclaredAgent`: already computed at `:116` (`const dir = join(agentsBase, name)`) but not pushed into the object at `:122–130`; add `dir` there. Add `dir?: string` to the `DeclaredAgent` interface in `src/bus/reconcile.ts:42`.
- Add private `runExperimentSweep(declaredAgents: DeclaredAgent[])` mirroring `runDueSweep` (`:354`): iterate agents, `sweepExperiments(agentDir, agentName, { dryRun: false })` per `agentDir`, emit `logEvent(paths, emitAgent, emitOrg, 'experiment', <type>, 'warning', meta)` with types `experiment_window_expired` / `experiment_autoclosed` / `experiment_window_unparseable`. On `flag`, best-effort message the owning agent (`sendMessage` wrapped in try/catch, never throw).
- Call it from `runOnce` in its own swallow-and-log try/catch right after `runDueSweep` (~`:299`).

### 4. EDIT `src/cli/bus.ts`

- New command `bus sweep-experiments [--apply] [--grace <dur>] [--dry-run]` near the experiment commands (~`:1307`). Dry-run is the default; `--apply` performs mutations. Prints an actions table.

### 5. NEW `tests/experiment-sweep.test.ts`

Mirror the `tests/sprint3-experiments.test.ts` harness (temp `agentDir`, `beforeEach`/`afterEach`). 6 cases, injectable `now`.

## Files touched

- NEW `src/bus/experiment-sweep.ts`
- EDIT `src/bus/experiment.ts` (additive field + `autoCloseExpiredExperiment` + export `loadExperiment`/`saveExperiment`)
- EDIT `src/bus/reconcile.ts` (add `dir?: string` to `DeclaredAgent`)
- EDIT `src/daemon/reconcile-trigger.ts` (expose `dir`, `runExperimentSweep`, wire into `runOnce`)
- EDIT `src/cli/bus.ts` (`sweep-experiments` command)
- NEW `tests/experiment-sweep.test.ts` (6 cases)

## Acceptance criteria

1. **Flag once + idempotent** — a `running` experiment past its window but within grace produces a `flag` action, sets `window_flagged_at`, emits `experiment_window_expired`, and messages the owner; a second sweep (still within grace, `window_flagged_at` already set) produces NO further flag action, emits nothing, sends no message.
2. **Auto-close fields + idempotent** — a `running` experiment past `expiredAt + grace` is auto-closed: `status='completed'`, `decision='discard'`, `result_value=null`, `completed_at` set, and the machine learning note appended; the experiment then reads as `completed`, so a second sweep produces no action (running-only filter).
3. **Unparseable skip** — an experiment whose `window` yields `parseDurationMs === NaN` produces a `skip-unparseable` action, emits `experiment_window_unparseable`, and is NEVER mutated (still `running`, no `window_flagged_at`, no auto-close).
4. **Not-expired untouched** — a `running` experiment whose `started_at + window` is in the future (`now <= expiredAt`) produces no action and is not mutated.
5. **Proposed + completed untouched** — `status='proposed'` and `status='completed'` experiments are ignored entirely by the sweep (running-only), regardless of window/age.
6. **CLI dry-run vs apply** — `bus sweep-experiments` (default / `--dry-run`) computes and prints the actions table but mutates nothing on disk; `bus sweep-experiments --apply` performs the flag/auto-close mutations.
7. **Injectable clock** — `sweepExperiments` uses `opts.now ?? Date.now()`; all tests drive `now` explicitly and never touch the wall clock.

## Guardrails

- Additive-only to the Experiment JSON — existing history must still parse.
- No `any`. No `console.log` in committed code (`console.error` for swallowed daemon errors is fine).
- `npm run build` clean + `npm test` green including the 6 new tests.
