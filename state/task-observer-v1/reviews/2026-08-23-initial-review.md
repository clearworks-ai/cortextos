# Task Observer initial fleet review — 2026-08-23

Status: CANARY ACTIVE; fleet rollout pending restart/schedule gate

## Installed architecture

- Canonical CC BY 4.0 bundle: `/Users/joshweiss/code/cortextos/community/skills/task-observer`
- Upstream author attribution preserved: Eoghan Henn / rebelytics.com.
- Fleet adapter: `references/cortextos-fleet.md`
- Atomic writer: `scripts/cortextos_observe.py`
- Schema: `/Users/joshweiss/code/cortextos/state/task-observer-v1/schema.json`
- Confidential state: `state/task-observer-v1/partitions/<org>/<agent>/observations.jsonl`
- Review outputs: `state/task-observer-v1/reviews/`
- Full staged skill proposals: `state/task-observer-v1/skill-updates/YYYY-MM-DD/<skill>/`

The writer uses an agent-scoped lock, monotonic sequence allocation, append +
fsync, and survival verification. Directories are mode 0700 and logs/locks are
0600. Open-source observations refuse a non-empty session context.

## Three-agent canary

| Agent | Surface | Activation | Records |
|---|---|---:|---:|
| larry-codex | engineering/orchestration | AGENTS.md + canonical skill symlink | 2 |
| knox-codex | research/authenticated browser | AGENTS.md + canonical skill symlink | 1 |
| maven-codex | personal/confidential | AGENTS.md + canonical skill symlink | 1 |

Two concurrent Larry appends produced distinct sequence values 1 and 2 and
survived a fresh read. Knox and Maven records remain in separate partitions.

## Seeded review

Four OPEN observations were seeded from existing Task Observer rollout,
authenticated-browser, and confidentiality evidence. The first proposal applies
the two non-escalated cross-cutting findings to Task Observer itself:

1. Shared learning state needs atomic allocation and post-write verification.
2. Confidential learning must be partitioned at storage time.

The staged proposal is the complete Task Observer bundle, not a live-skill edit.
It adds the cortextOS adapter and atomic writer while preserving the upstream
bundle and attribution.

## Schedule gate

Exactly one `weekly-skill-review` declaration exists for `larry-codex` at
`0 9 * * 1`. The bus reported that the running daemon predates verified cron
hot-reload, so the declaration is not yet live. Do not create a duplicate. The
next gate is a controlled daemon/session restart followed by cron inventory and
one test fire.

## Fleet rollout gate

Canary storage and concurrency passed. Before enabling every substantive agent:

1. Validate the staged bundle and archive listing.
2. Restart/reload the daemon and prove the single schedule is live.
3. Activate remaining enabled substantive agents with the same symlink and
   bootstrap block.
4. Restart one canary and prove partition continuity.
5. Run a concurrent fleet append test and recount every partition.
