# One-Big-Feature: muse-fleet-activity-digest

**Repo:** cortextos (`~/code/cortextos`)
**Owner:** larry (spec + review + PR) → codexer (impl)
**Trigger:** Josh 2026-07-02 — "Handle the muse fleet activity"; greenlit + scope-locked ("yes to all", 2026-07-02 ~17:40Z).
**Design of record:** `orgs/clearworksai/agents/larry/memory/reports/2026-07-02-muse-fleet-activity-digest-design.md`
**Task:** task_1783014450218_19761551

## Framework choice
one-big-feature. Single cohesive feature, one repo (cortextos), one subsystem: one new deterministic Python script in the muse agent dir plus repointing one existing cron at it. Not a schema migration, not multi-repo, not a new subsystem. Task shards suffice.

## The problem in one line
Muse's daily fleet-activity intel runs as an interim prompt-driven cron (`fleet-activity-intel`, 8 AM Mon–Fri) that asks an LLM to re-gather git/tasks/crons and "find the story" every morning — the same prompt-only pattern that silently drifted on Jun 25, and especially fragile here because 86% of "completed tasks" are cron-noise an LLM filters inconsistently (verified: 166 completed in 24h, only 14 real).

## The fix in one line
A deterministic, stdlib-only Python script (`muse/scripts/fleet-activity-digest.py`, colocated with the proven `process-posts.py`) that gathers four structured sources — bus tasks, git across the owned repos, the per-agent event log, cron-fire deltas — dedups/classifies them into a shipped/fixed/broke digest written as both JSON and a `## FLEET_ACTIVITY_INTEL` Markdown block the existing content crons already consume; then repoint the same cron at the script.

## Scope decisions LOCKED by Josh (2026-07-02, "yes to all")
1. **Monday window widens to 72h** so Fri-evening + weekend activity is not lost. Constant `MONDAY_WINDOW_HOURS = 72`, default `WINDOW_HOURS = 24`.
2. **Silent** — writes to memory only; downstream crons consume. NO daily Telegram recap to Josh.
3. **Script stays deterministic; NO Omi in the script.** `client_signal` stays a reserved empty list; the consuming LLM crons pull Omi themselves.
4. **`gws-security` added** to the tracked repo list → `REPOS = [clearpath, cxportal, nonprofit-hub, auditos, cortextos, gws-security]`.
5. **Retention: keep per-day digest JSON 90 days, then prune** (prune step runs at end of each digest build; forward-only).

## Key facts codexer must know
- **Live cron (source of truth):** `/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/muse/crons.json` → cron `fleet-activity-intel`, schedule `0 15 * * 1-5`, `enabled: true`. config.json is INERT (`feedback_cortextos_config_cron_inert.md`) — never edit it; the scheduler reads only crons.json.
- **`cxportal` is a symlink** → `~/code/lifecycle-killer`; git resolves fine. Use `~/code/cxportal` in the repo list.
- **Task noise is the whole point:** `cortextos bus list-tasks --status completed --format json` returns ~9,536 tasks, ~8,243 `Cron:`-prefixed. Excluding `title` startswith `"Cron:"` is a HARD requirement, proven by test.
- **Stdlib only** — `json`, `subprocess`, `datetime`, `pathlib`, `sqlite3` if needed. No new runtime deps (cortextOS rule). Atomic writes (temp + `os.replace`) per `src/utils/atomic.ts` convention.
- **Colocate + match the proven shape:** `process-posts.py` runs every 10 min via the `post-processor` cron (fire_count 3444). Same invocation shape, same dir (`orgs/clearworksai/agents/muse/scripts/`).
- The `## FLEET_ACTIVITY_INTEL` Markdown block is the interface the existing `growth-planning` (Mon 9 AM) and `linkedin-seeds` (Tue 10 AM) crons already expect — do not change that contract.

## Components (build order)
1. **spec 01 — deterministic sources A–D + digest object + JSON output.** Steps 0–4, 6, 7.1 of the design's assembly algorithm. Window/determinism, `.last-run.json` dedup, exclude `Cron:` tasks, git classification, event filtering, cron deltas, digest assembly, atomic JSON write, retention prune. Stdlib only, no LLM, no MCP.
2. **spec 02 — Markdown upsert + logging + enrichment.** Step 7.2–7.5: idempotent `## FLEET_ACTIVITY_INTEL` upsert into `muse/memory/YYYY-MM-DD.md` (replace-not-append), `log-event` call, one-line stdout summary, best-effort enrichment (sources E/F) behind try/except.

**Larry-owned, NOT codexer (post-build):**
- **Phase 3 — local validation:** run the script against live data for today + a backfilled prior day; confirm zero `Cron:` tasks leaked, commit SHAs match `git log`, re-run is byte-identical (idempotency proof). This is the "prove it landed" gate the Jun 25 incident demands.
- **Phase 4 — cron repoint (Larry, gated on validation):** `cortextos --instance cortextos1 bus update-cron muse fleet-activity-intel --prompt "<thin invocation>"`; verify crons.json literal; `test-cron-fire`; lift Muse's hold; update `project_fleet_activity_intel_larry_rebuild` memory.

## Test requirements (every spec)
Unit tests colocated with muse scripts (fixture-based; fake `cortextos bus` output + fake git via tmp repos, or inject via monkeypatched subprocess). No `any`-equivalent, no stray debug prints. Two non-negotiables proven by test: (a) zero `Cron:`-prefixed tasks appear in output; (b) re-running for the same day yields byte-identical JSON (idempotency).

## Gates
- All merges to cortextos main = Josh approval (PR).
- The cron repoint (Phase 4) touches the LIVE cortextos1 crons store — non-destructive field update, but Larry executes it only after local validation passes, and verifies crons.json directly after (IPC reload can fail silently).
- Muse is on HOLD for `fleet-activity-intel`/`growth-planning`/`linkedin-seeds` edits until this rebuild is reconciled (`project_fleet_activity_intel_larry_rebuild.md`). Larry lifts the hold at Phase 4.

## Status
- [x] Design proven against live data (task/cron/event paths verified 2026-07-02)
- [x] Josh: go on the build + scope locked ("yes to all", 2026-07-02)
- [x] Specs 01-02 written
- [ ] codexer impl (01→02) → larry review + full test run → local validation → PR → Josh merge → Larry cron repoint
