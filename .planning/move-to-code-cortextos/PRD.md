# PRD — Move cortextos framework into ~/code/

**Status:** Plan only. Not executing until Josh gives go-ahead.
**Created:** 2026-04-13 by frank2
**Branch (when executed):** `feature/relocate-to-code-cortextos`

## Problem

Framework lives at `~/cortextos/`, sibling of `~/code/`. Josh's mental model: "code lives in `~/code/`". Friction whenever he navigates the filesystem — the framework is the odd one out.

Secondary: a stale `~/cortextos.old/` sits next to it from a prior migration and should be removed in the same batch.

## Goal

Move `~/cortextos/` → `~/code/cortextos/` with zero data loss and minimum downtime (< 5 min fleet outage). All agents (auditos, frank2, sage, maven) must come back online automatically and resume work as if nothing happened.

## Non-goals

- Splitting orgs/ out to a separate repo (Option C from the earlier convo). Out of scope for this plan.
- Moving `~/.cortextos/` runtime state. Stays where it is.
- Moving `~/code/auditos`, `~/code/clearpath`, etc. — those are the repos agents operate on, they already live in `~/code/`.

## Success criteria

1. `pwd` at new location returns `/Users/joshweiss/code/cortextos`.
2. `pm2 list` shows `cortextos-daemon` + `cortextos-dashboard` online with new cwd.
3. `cortextos status` returns all 4 agents running within 3 min of restart.
4. Each agent responds to a Telegram test ping within 5 min.
5. Dashboard loads at localhost:3000 with fresh data.
6. `git status` in new location is clean, `git log` matches pre-move.
7. `~/cortextos.old/` removed.
8. `~/cortextos/` symlink left behind pointing at new location (optional, for any hardcoded references in external tools — remove after 48h if nothing breaks).

## Out-of-scope risks acknowledged

- Claude Code transcript paths under `~/.claude/projects/-Users-joshweiss-cortextos-...` will NOT match the new cwd. Transcripts for in-flight sessions will keep writing to old paths until each agent restarts. Post-move transcripts go to the new escaped path. **This means the new zombie-detection port needs the new cwd after restart** — which it will get via `agent.getWorkingDirectory()` reading config.json at start time. No code change needed, just plan for the transcript dir split.
- Any open Claude Code session that survives the move will drift. Hard-restart all agents as part of the migration.
