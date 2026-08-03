# Research — sage-analyst-parity (P5-C)

## Source
`MASTER-BUILD-PLAN.md` lines 274-279 ("sage-to-upstream-analyst-parity — NEW build item,
correction 5"): bring sage up to the upstream analyst template — add `usage-monitor` cron
(2h, from `templates/analyst/config.json`); add `experiments/config.json` with theta-wave
preference gates (approval-REQUIRED experiments — proposals route through the P4.3 approval
surface); keep nightly-metrics/auto-commit/check-upstream/catalog-browse aligned with the
template. Read full P5 section (lines 215-330) for context: P5-C is the "keep + rewire"
priority-job lane; sage owns theta-wave per upstream analyst design (analyst initiates, the
orchestrator only converses — `community/agents/analyst/ONBOARDING.md` Part 7).

## Two storage planes discovered (important correction to the task brief)

The task brief assumed `orgs/clearworksai/agents/sage/crons.json` is the live cron source of
truth. That file **does not exist**. Verified the real architecture:

1. **Crons** are NOT stored in the git-tracked `orgs/.../sage/config.json` at all after
   onboarding. `cortextos bus add-cron` (per `community/agents/analyst/ONBOARDING.md` Step 22:
   "do not edit config.json directly") writes to a **runtime state file**:
   `~/.cortextos/cortextos1/.cortextOS/state/agents/sage/crons.json` — outside the git repo
   entirely. `cortextos bus list-crons sage` reads from this same live state. This is the true
   source of truth; the repo's `orgs/.../sage/config.json` `crons` array is a stale onboarding
   snapshot the daemon doesn't consult.
2. **`experiments/config.json`** works differently — it's read directly from
   `CTX_AGENT_DIR` (`orgs/clearworksai/agents/sage/experiments/config.json`), which IS the
   live file the agent reads at cron-fire time (no separate state-dir mirror for this one).
   Confirmed both `orgs/clearworksai/agents/sage/config.json` and
   `orgs/clearworksai/agents/sage/experiments/config.json` are **gitignored**
   (`.gitignore:17` → `orgs/clearworksai/*`) — edits here are local runtime state, not a git
   change, no PR needed.

`templates/analyst/config.json` (the template referenced by the plan) IS git-tracked and was
in scope for one small fix (below).

## Gap 1 — usage-monitor cron: confirmed missing, added

`cortextos bus list-crons sage` showed 11 crons, no `usage-monitor`. Added via
`cortextos bus add-cron sage usage-monitor 2h "<prompt>"` (the sanctioned path, not manual
JSON edits) — now 12, live-verified below.

**Template prompt is broken as written** — found and fixed while porting it:
- Template text: `cortextos bus check-usage-api --warn-7day 80 --warn-5h 90`. Ran it in-repo:
  `error: unknown option '--warn-7day'`. The `check-usage-api` Commander command
  (`src/cli/bus.ts:4522`) only accepts `--account`, `--force`, `--json` — no warn-threshold
  flags exist or ever existed in `src/bus/oauth.ts`.
- Template text also references `codex.utilization_5h` / `codex.utilization_7d` fields.
  `checkUsageApi`'s real return shape (`src/bus/oauth.ts` `CheckUsageResult`) only has
  `five_hour_utilization` / `seven_day_utilization` (0.0-1.0 fractions) — no `codex` object
  anywhere in the type or the JSON it emits.
- Sage's cron was written with the corrected invocation (`--json`, real field names, fraction
  thresholds 0.80/0.90). `templates/analyst/config.json` was also fixed in place (1-line prompt
  string edit, no logic/schema change) so future analyst onboarding doesn't inherit the same
  broken cron — small, low-risk, directly serves the parity goal of this build item.

## Gap 2 — experiments/config.json theta-wave preference gates: partially missing, now complete

Sage's `experiments/config.json` already existed (`{"approval_required": true, "cycles": [...]}`)
— NOT missing outright as the task brief assumed, but incomplete. Cross-referenced
`community/agents/analyst/ONBOARDING.md` Part 7 (Steps 24-25), which defines the actual schema
theta-wave's own `SKILL.md` Phase 7 reads: a `theta_wave` object with `enabled`, `interval`,
`metric`, `metric_type`, `direction`, `auto_create_agent_cycles`, `auto_modify_agent_cycles`,
plus the top-level `approval_required`. Sage's file was missing the entire `theta_wave` key —
so the gate `SKILL.md` Phase 7 references ("If auto_create_agent_cycles or
auto_modify_agent_cycles is false, create approvals instead of executing directly") had no
config to read.

Added the `theta_wave` key, preserving the existing `cycles` history array:
- `enabled: true` (theta-wave cron already live weekly)
- `interval: "7d"` (matches sage's actual live cron schedule `0 9 * * 0`, not the ONBOARDING.md
  default example of `24h` — sage's theta-wave fires weekly, not daily)
- `metric: "system_effectiveness"`, `metric_type: "qualitative_compound"`, `direction: "higher"`
  — copied verbatim from `theta-wave/SKILL.md`'s own definition of its compound metric
- `auto_create_agent_cycles: false`, `auto_modify_agent_cycles: false` — this is the literal
  ask in the plan text ("approval-REQUIRED experiments — proposals route through the P4.3
  approval surface"): both false forces theta-wave's own Phase 7 gate to create an approval
  via `cortextos bus create-approval` instead of executing a cycle create/modify directly.

**No src/ change needed for the approval routing itself.** This gate is enforced entirely by
the agent reading `experiments/config.json` during its own theta-wave cron run and following
`theta-wave/SKILL.md` Phase 7's documented instruction — it is not backed by any TypeScript
code path (`auto_create_agent_cycles`/`auto_modify_agent_cycles` appear nowhere in `src/`,
confirmed by repo-wide grep — they're agent-instruction-only, consumed by Sage itself, not by
the daemon or CLI).

### P4.3 approval surface — confirmed real interface, not invented

Read `src/bus/approval.ts` (P4.3, already merged). `createApproval()` is exposed via
`cortextos bus create-approval "<title>" "<category>" "<context>"` (categories:
`external-comms | financial | deployment | data-deletion | other`). It creates a pending
approval file, a linked human task (Multica sync), posts to the activity channel with
Approve/Deny buttons, and pings the requesting agent's own Telegram. This is a real, live,
already-merged interface — theta-wave's gated proposals route through it using the `other`
category (a system-cycle-change proposal doesn't cleanly fit the other four).

## Gap 3 — nightly-metrics/auto-commit/check-upstream/catalog-browse alignment

Diffed sage's live cron prompts (`cortextos bus list-crons sage`) against
`templates/analyst/config.json`:

| Cron | Template | Sage (live) | Verdict |
|---|---|---|---|
| auto-commit | 24h, `local-version-control/SKILL.md` workflow | 24h, same skill + task-tracking wrapper (`TASK_ID=...create-task/complete-task`) | **Aligned** — wrapper is the fleet-wide task-bus convention every sage cron uses, not drift |
| check-upstream | 24h, `upstream-sync/SKILL.md` workflow | 24h, same skill + same wrapper | **Aligned** |
| catalog-browse | 7d, `catalog-browse/SKILL.md` workflow | 7d, same skill + same wrapper | **Aligned** |
| nightly-metrics | 24h, `cortextos bus collect-metrics` (generic cross-agent aggregator, `src/bus/metrics.ts:collectMetrics`) | 24h, bespoke `memory/kpi-collector-v1.sh` + `memory/kpi-digest-v1.sh` (fleet reliability + observability KPIs: restart frequency, heartbeat staleness, error rate, uptime%, task coverage) with alert-tier Telegram routing | **Intentionally diverged, not a bug** — sage's own purpose-built analyst KPI pipeline is materially richer than the generic template command. Report as a documented, verified divergence; did not force it back to the template (that would be a regression, not parity). Flagging as a genuine judgment call rather than silently expanding or silently "fixing" it. |

## Scope decision: no codex-handoff needed

Every change is (a) a cron addition via the sanctioned `cortextos bus add-cron` CLI path
(runtime state, gitignored), (b) a JSON config edit to a gitignored agent file, and (c) one
prompt-string edit to a tracked template JSON file (no schema/logic change). Nothing touches
`src/` TypeScript. Per the dispatch instructions, this does not need codex-rescue — done
directly.
