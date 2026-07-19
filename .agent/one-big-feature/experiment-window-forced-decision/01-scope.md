# 01 — Scope: experiment-window-forced-decision

## Josh's exact request (verbatim, task_1784334618044_64195460)
> theta-wave found 3 experiments ran 15-35 days with zero evaluation despite evaluate-experiment CLI existing. Need: force a decision (evaluate/close) at or before each experiment's stated window (24h/7d) expires — auto-flag/auto-close stale-past-window experiments instead of letting status=running sit indefinitely. Scope + build via pipeline (OBF/M2C1), not ad hoc.

## Problem
Experiments transition `proposed → running → completed`. `running` has no forcing function: an experiment whose stated `window` (e.g. "24h", "7d") has long passed stays `running` forever unless a human/agent remembers to call `evaluate-experiment`. Real incidence: 3 experiments sat 15–35 days unevaluated.

## Goal
A periodic daemon sweep that, for every `status='running'` experiment across all agents:
1. **At window expiry** (`now > started_at + parseDurationMs(window)`): flag it — emit a warning event and message the owning agent to evaluate, once.
2. **After a grace period past expiry** (default 24h, configurable): auto-close it — `status='completed'`, `decision='discard'`, with a machine-written `learning` explaining it was auto-closed for exceeding its window without evaluation.

Both actions idempotent (a re-run must not double-flag or re-close). Mirrors the existing `sweepDueTasks` task-overdue pattern.

## Non-goals
- No schema migration of the experiment JSON shape beyond additive, optional bookkeeping fields.
- Do NOT invent a measured `result_value` — auto-close is always `discard` (we have no measurement; keeping unmeasured would be worse than the current bug).
- No change to `proposed` or already-`completed` experiments.
- Not touching the manual `evaluate-experiment` CLI behavior (agents can still evaluate normally before the grace deadline).

## Item count check (scope must match spec)
Josh named exactly these behaviors: (a) flag at/before window expiry, (b) auto-close stale-past-window. Spec below implements exactly 2 actions, no more, no less.
