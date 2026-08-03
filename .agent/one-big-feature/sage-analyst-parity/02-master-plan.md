# Master Plan — sage-analyst-parity (P5-C)

## Problem
Sage lags the upstream analyst template in two ways: (1) missing the `usage-monitor` cron
entirely, (2) `experiments/config.json` exists but is missing the `theta_wave` preference-gate
key that theta-wave's own `SKILL.md` Phase 7 depends on to decide whether a proposed
system-level cycle change executes directly or must route through the P4.3 approval surface.
Additionally verify (not assumed) whether nightly-metrics/auto-commit/check-upstream/
catalog-browse have actually drifted from the template.

## Root findings (see 01-research.md for full detail + proof)
1. Live cron state lives at `~/.cortextos/cortextos1/.cortextOS/state/agents/sage/crons.json`
   (daemon-managed, NOT the git-tracked `orgs/.../sage/config.json`, and NOT at the
   `orgs/.../sage/crons.json` path the task brief assumed — that path doesn't exist). The
   sanctioned write path is `cortextos bus add-cron`, never manual JSON edits.
2. `experiments/config.json` (gitignored, lives at
   `orgs/clearworksai/agents/sage/experiments/config.json`, IS the live file the agent reads)
   already had `approval_required: true` but was missing the entire `theta_wave` object that
   `community/agents/analyst/ONBOARDING.md` Part 7 defines and `theta-wave/SKILL.md` Phase 7
   reads (`auto_create_agent_cycles`, `auto_modify_agent_cycles`).
3. Template's `usage-monitor` prompt (`templates/analyst/config.json`) references a
   `check-usage-api` CLI flag pair (`--warn-7day`/`--warn-5h`) and a `codex.utilization_*`
   JSON field that do not exist in `src/cli/bus.ts` / `src/bus/oauth.ts` — live-tested,
   `--warn-7day` throws `unknown option`. Real flag is `--json`; real fields are
   `five_hour_utilization`/`seven_day_utilization` (0.0-1.0 fractions).
4. nightly-metrics is intentionally diverged from the template (sage runs a bespoke,
   materially richer fleet-KPI pipeline) — not drift to fix. auto-commit/check-upstream/
   catalog-browse are aligned (same skill files, same schedules; the task-bus wrapper around
   them is a fleet-wide convention, not divergence).

## Changes made
1. **`cortextos bus add-cron sage usage-monitor 2h "<corrected prompt>"`** — 2h interval,
   corrected invocation (`--json`, real field names/units), preserves the same alert logic
   (CODE RED at 7d ≥80%, warning at 5h ≥90%, 10%-increment dedup, daily memory log). Runtime
   state only — no git change.
2. **`orgs/clearworksai/agents/sage/experiments/config.json`** — added `theta_wave: {enabled:
   true, interval: "7d", metric: "system_effectiveness", metric_type: "qualitative_compound",
   direction: "higher", auto_create_agent_cycles: false, auto_modify_agent_cycles: false}`,
   preserved existing `cycles` history and `approval_required: true`. Gitignored — no git
   change.
3. **`templates/analyst/config.json`** — fixed the `usage-monitor` cron `prompt` string to use
   the real `check-usage-api --json` invocation and real field names/units instead of the
   nonexistent flags/fields. Tracked file — small PR opened (do not merge; Josh merges).

## Out of scope / explicitly not done
- Did not force nightly-metrics to `cortextos bus collect-metrics` — sage's bespoke KPI
  pipeline is a verified improvement over the generic template command, not a bug. Reported as
  a documented divergence for Josh's awareness, not silently "fixed" or silently left
  unmentioned.
- No `src/` TypeScript change — the approval-routing gate is agent-instruction-level
  (theta-wave `SKILL.md` Phase 7 already documents the create-approval fallback; only the
  config values it reads were missing). No codex-handoff dispatched.

## Done-condition (machine-checkable)
- `cortextos bus list-crons sage` shows 12 crons including `usage-monitor` at `2h` — **met,
  live-verified**.
- `orgs/clearworksai/agents/sage/experiments/config.json` is valid JSON containing
  `theta_wave.auto_create_agent_cycles: false` and `theta_wave.auto_modify_agent_cycles: false`
  — **met, verified**.
- `templates/analyst/config.json`'s `usage-monitor` prompt no longer references
  `--warn-7day`/`--warn-5h`/`codex.utilization_*` — **met**.

## Known follow-up (not this build item, flagging for the ledger)
- The daemon warned on `add-cron`: "Cron 'usage-monitor' written to crons.json but NOT live in
  the running scheduler (daemon predates reload-verify — restart the daemon)." Sage's daemon
  process needs a restart/reload before `usage-monitor` actually fires on its 2h schedule —
  same class of issue as the frank2 comms-check orphaned-cron incident 2026-08-02. Flag to
  whoever next restarts sage (or bundle with the next fleet-wide daemon reload) — not a
  destructive op, no staging-first gate needed, but it does mean "live" here means "registered
  and will fire once the daemon reloads," not "fired yet."

## Specs
- `03-specs/01-template-usage-monitor-prompt-fix.md` — the one tracked-file change (template
  prompt string correction).
