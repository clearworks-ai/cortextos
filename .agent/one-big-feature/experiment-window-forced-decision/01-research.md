# 01 — Research: experiment-window-forced-decision

## Trigger
Josh directive (task_1784334618044_64195460, 2026-07-18): theta-wave found 3 experiments ran 15–35 days with zero evaluation despite the `evaluate-experiment` CLI existing. Need a forcing function: force a decision (evaluate/close) at or before each experiment's stated window (24h/7d) expires — auto-flag/auto-close stale-past-window experiments instead of letting `status=running` sit indefinitely.

## Codebase terrain (verified by direct read)
- **Experiment model** — `src/bus/experiment.ts:8–28`. `interface Experiment` fields relevant here: `window: string` (free text, e.g. "24h"/"7d" — a LABEL, not a computed expiry), `status: 'proposed'|'running'|'completed'`, `started_at: string|null` (ISO, set on run), `created_at`, `completed_at`, `decision: 'keep'|'discard'|null`, `result_value: number|null`, `learning`.
- **Storage** — per-agent JSON files at `{agentDir}/experiments/history/{id}.json`; `active.json` marker written on run / deleted on completion (`historyDir` at `experiment.ts:102`, `experimentFilePath` at `:107`).
- **State machine** — `proposed→running` via `runExperiment` (`:223`, guards `status!=='proposed'`); `running→completed` via `evaluateExperiment` (`:253–358`, guards `status!=='running'` at `:261`, appends `learnings.md`+`results.tsv`, deletes `active.json`).
- **Listing** — `listExperiments(agentDir, {status})` at `:363` (reads all history files, filters by status).
- **Duration parser** — `parseDurationMs(interval)` at `src/bus/cron-state.ts:108`. Regex `^(\d+)(m|h|d|w)$`; returns `NaN` for anything else (incl. free-text/cron). Units m/h/d/w. This is the exact parser to compute `started_at + window`.
- **Daemon periodic loop** — `ReconcileTrigger.runOnce()` at `src/daemon/reconcile-trigger.ts:264`, fires every ~15 min. Already calls `runOrphanReclaim()` and `runDueSweep()`, each in its own swallow-and-log try/catch (`:286–299`). `runDueSweep()` at `:354` is the structural template (resolve paths, sweep, emit events, best-effort deliver).
- **Agent enumeration** — `gatherDeclaredAgents(frameworkRoot)` at `:89`; per-agent dir computed at `:28` (`join(agentsBase, name)`); results already gathered inside `runOnce` at `:268`.
- **CLI** — experiment commands cluster around `src/cli/bus.ts:1271–1333` (`create-experiment`, `run-experiment`, `evaluate-experiment`).
- **Tests** — `tests/sprint3-experiments.test.ts` (temp agentDir setup, full state-machine coverage) is the harness pattern to mirror.

## Key insight
`window` is descriptive, never computed to an expiry. The whole feature is: compute `expiredAt = Date.parse(started_at) + parseDurationMs(window)`, compare to `now`, and take a graduated action (flag → auto-close after grace). The task overdue-sweep (`sweepDueTasks`, `src/bus/task.ts:273–372`) is the proven precedent for a daemon-driven, idempotent, dry-run-capable sweep that emits events and messages owners — reuse its shape, don't invent a new loop.

## Open design decision (resolved in plan)
"Force a decision" at expiry must not fabricate a measurement. Resolution: auto-close is always `decision='discard'` with `result_value=null` and a machine `learning` note; a grace window (default 24h) gives the owner a flagged chance to evaluate properly first. Unparseable windows are logged and never auto-closed (can't compute expiry → don't guess).
