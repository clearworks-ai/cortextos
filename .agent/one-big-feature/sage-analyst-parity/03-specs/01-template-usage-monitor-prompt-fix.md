# Spec 01 — fix broken `usage-monitor` prompt in `templates/analyst/config.json`

Branch: `fix/sage-analyst-parity`

## Why
Porting the template's `usage-monitor` cron to sage (P5-C parity item) surfaced that the
template's own prompt text is broken: it invokes `cortextos bus check-usage-api --warn-7day 80
--warn-5h 90`, but `check-usage-api` (`src/cli/bus.ts:4522`) only defines `--account`,
`--force`, `--json` — live-tested: `--warn-7day` throws `error: unknown option '--warn-7day'`.
The prompt also tells the agent to check `codex.utilization_5h`/`codex.utilization_7d` fields
that don't exist anywhere in `checkUsageApi`'s return type (`CheckUsageResult` in
`src/bus/oauth.ts`, fields are `five_hour_utilization`/`seven_day_utilization`, 0.0-1.0
fractions). Every future analyst onboarded from this template would inherit a cron that errors
every 2 hours. Fixing in place — 1-line prompt-string edit, no schema/logic change.

## Change — `templates/analyst/config.json`

In the `usage-monitor` cron entry, replace the `prompt` value:

```diff
- "prompt": "Check Claude API usage: run cortextos bus check-usage-api --warn-7day 80 --warn-5h 90 2>&1. Parse the JSON output. Rules: (1) If 7-day utilization >= 80% send the orchestrator a CODE RED via Telegram immediately. (2) If 5-hour >= 90% send a warning. (3) For 7-day: check if the current utilization has crossed a new 10% increment since the last check (e.g. crossed 10%, 20%, 30%... 90%). Read the last logged 7-day value from today's memory file to compare. If a new 10% threshold was crossed, send the orchestrator a brief Telegram: '7-day usage: X% (resets <date>)'. Same logic applies to codex.utilization_5h and codex.utilization_7d fields. (4) Always log the current levels in your daily memory."
+ "prompt": "Check Claude API usage: run cortextos bus check-usage-api --json 2>&1. Parse the JSON output (fields five_hour_utilization and seven_day_utilization are 0.0-1.0 fractions). Rules: (1) If seven_day_utilization >= 0.80 send the orchestrator a CODE RED via Telegram immediately. (2) If five_hour_utilization >= 0.90 send a warning. (3) For 7-day: check if the current utilization has crossed a new 10% increment since the last check (e.g. crossed 10%, 20%, 30%... 90%). Read the last logged 7-day value from today's memory file to compare. If a new 10% threshold was crossed, send the orchestrator a brief Telegram: '7-day usage: X% (resets <date>)'. (4) Always log the current levels in your daily memory."
```

## Acceptance
- `templates/analyst/config.json` remains valid JSON.
- No other field of the `usage-monitor` cron entry changes (name, type, interval unchanged).
- `cortextos bus check-usage-api --json` is a real, currently-working invocation
  (`src/cli/bus.ts:4522`, confirmed no "unknown option" error for `--json`; only the
  `--warn-*` flags errored).
- No `src/` change — string-only fix to a JSON template file.
