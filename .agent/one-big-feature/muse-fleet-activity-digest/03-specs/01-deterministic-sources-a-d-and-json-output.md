# Spec 01 — Deterministic sources A–D + digest object + atomic JSON output

## Problem
Muse's daily fleet-activity intel runs as an interim prompt-driven cron (`fleet-activity-intel`, 8 AM Mon–Fri) that asks an LLM to re-gather git/tasks/crons and "find the story" every morning. This is the same prompt-only pattern that silently drifted on Jun 25 (a memory said the rewrite landed; the live crons.json still held the old menu prompts until frank2 caught it 2026-07-02). It is especially fragile here because the input is 86% noise: `cortextos bus list-tasks --status completed --format json` returns ~9,536 completed tasks, ~8,243 of them `Cron:`-prefixed self-created cron-run tasks. Verified in the last 24h: 166 completed, only 14 real. An LLM asked to filter that each morning will variably include cron noise and re-derive the 24h boundary differently every run — non-reproducible output. Filtering, windowing, and dedup are a script's job, not a prompt's.

## Goal
A deterministic, stdlib-only Python 3 script that gathers the four structured fleet sources (bus tasks, git across the owned repos, the per-agent event log, cron-fire deltas), windows and dedups them exactly, classifies them into a shipped/fixed/broke/capability digest, and writes that digest as a machine-readable JSON artifact via an atomic write — with zero LLM and zero MCP involvement. Running the script twice for the same day yields byte-identical JSON. No `Cron:`-prefixed task ever appears in the output.

## Scope
File: `orgs/clearworksai/agents/muse/scripts/fleet-activity-digest.py` (executable, colocated with the proven `process-posts.py`). Tests colocated with the muse scripts (fixture-based).

This spec covers design-doc §3.1–§3.4 Steps 0–4, Step 6, Step 7.1 (JSON write only), plus §6 Phase 1, plus the retention prune (locked decision 5). Step 5 enrichment and Step 7.2–7.5 (Markdown upsert, log-event, stdout summary, `.last-run.json` write of unions) are spec 02 — this spec only *reads* `.last-run.json` for dedup and produces the JSON + digest object that spec 02 consumes.

- **Language:** Python 3, stdlib only — `json`, `subprocess` (for git and the bus command), `datetime`, `pathlib`. No LLM, no MCP, no new runtime dependency (honors the cortextOS "no external runtime deps" rule). Atomic writes: write to a temp file in the target dir, then `os.replace` (matches the `src/utils/atomic.ts` convention — no half-written digest if the process dies mid-write).

### Module-level constants (top of file, no separate config file)
- `REPOS = [~/code/clearpath, ~/code/cxportal, ~/code/nonprofit-hub, ~/code/auditos, ~/code/cortextos, ~/code/gws-security]` — `gws-security` included per locked decision 4. Note `cxportal` is a symlink to `~/code/lifecycle-killer`; git resolves it fine, so use `~/code/cxportal` directly. Expand `~` via `pathlib`/`os.path.expanduser`.
- `AGENTS = [larry, frank2, automator, auditmaster, muse]` — the agents whose event logs, crons.json, and daily memory are scanned.
- `WINDOW_HOURS = 24` (default), `MONDAY_WINDOW_HOURS = 72` (locked decision 1 — widen the Monday run so Fri-evening/weekend activity is not lost).
- `MAX_ITEMS_PER_BUCKET = 15` — cap per digest list to bound size.
- `RETENTION_DAYS = 90` — locked decision 5.
- Path constants: script output dir `orgs/clearworksai/agents/muse/memory/fleet-activity/`; JSON output `.../fleet-activity/YYYY-MM-DD.json`; dedup state `.../fleet-activity/.last-run.json`; events root `/Users/joshweiss/.cortextos/cortextos1/orgs/clearworksai/analytics/events/`; per-agent crons store `/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json`.

### Fix A — Init + window + dedup state (Step 0)
- Compute `now = datetime.now(timezone.utc)` **once** at start and thread it through every source (single source of truth for the window boundary — this is what makes the run reproducible).
- `WINDOW_HOURS` = 72 if `now` is a Monday (`now.weekday() == 0`), else 24. `window_start = now − WINDOW_HOURS`.
- Load `.last-run.json` (fields `last_run_utc`, `seen_commit_shas`, `seen_task_ids`, `cron_fire_counts`); empty/default values if the file is absent or unparseable (never abort on a missing state file — treat as a first run).

### Fix B — Structured sources A–D (Steps 1–4)
- **Step 1 — Tasks (source A).** Shell out to `cortextos bus list-tasks --status completed --format json`; parse the JSON array. Keep a task iff **all** hold: `completed_at` parses AND `>= window_start`; **`title` does NOT start with `"Cron:"` (HARD REQUIREMENT — proven by test)**; `id` not in `seen_task_ids`. Group kept tasks by `assigned_to`. For each retain `title`, `assigned_to`, `completed_at`, and a truncated `result` (first ~280 chars). Classify by scanning `title`+`result` for `fix|bug|resolved|patch|broke|crash|regression` → **fixed/broke**; else → **shipped**.
- **Step 2 — Git (source B).** For each repo in `REPOS`: run `git -C <repo> log --since="<WINDOW_HOURS> hours ago" --no-merges --pretty=format:'%H%x09%an%x09%ct%x09%s'`, and separately capture merge commits via a second run with `--merges` (detects merged PRs). Skip any commit whose SHA is in `seen_commit_shas`. Classify each subject by conventional-commit prefix: `feat` → **shipped**; `fix`/`revert` → **fixed**; `chore`/`test`/`docs`/`refactor` → **maintenance** (kept but deprioritized). Record `{repo, sha, author, ts, subject, class}`. A repo path that does not exist / is not a git repo is skipped, not fatal.
- **Step 3 — Events (source C).** For each agent under the events root, read today's and (if the window crosses midnight, or on a Monday-72h run) the prior day(s)' `YYYY-MM-DD.jsonl`. One JSON event per line (`agent`, `timestamp`, `category`, `event`, `severity`, `metadata`). Keep events with `timestamp >= window_start` AND `category` in `{action, task}` AND `event` NOT in the noise set `{heartbeat_ok, agent_heartbeat, inbox_ack}` (drop heartbeat/inbox noise). Prioritize high-signal events: `guardrail_triggered`, `humanizer_block`, `decision_made`, `task_blocked`, `output_created`, `restart_deferred` — these are the "what broke / what got caught" beats.
- **Step 4 — Cron deltas (source D).** For each agent's `crons.json`, compute the `fire_count` delta per cron vs the `cron_fire_counts` snapshot in `.last-run.json` (delta against the stored snapshot, NOT a re-scan — makes "what fired since last run" exact rather than time-window-approximate). Flag **broken fires**: any cron where `last_fire_attempted_at > last_fired_at` (attempted but did not complete) → a "cron broke" candidate. Flag **new/disabled** crons: presence or `enabled` changes vs the snapshot → "capability added/removed."

### Fix C — Digest object + atomic JSON write + retention prune (Steps 6, 7.1)
- **Step 6 — Assemble the digest object** with exactly this shape (from design §3.4 Step 6):
  ```
  {
    "date": "YYYY-MM-DD",
    "window_hours": 24|72,
    "generated_at": "<iso>",
    "shipped":   [ {source, agent/repo, summary, ts, ref} ... ],
    "fixed":     [ ... ],
    "broke":     [ ... ],
    "capability_changes": [ ... ],
    "client_signal": [],
    "stability": { "restarts_by_agent": {...} },
    "counts": { "shipped": N, "fixed": N, "broke": N },
    "raw_refs": { "commit_shas": [...], "task_ids": [...] }
  }
  ```
  `shipped` = feat commits + shipped tasks; `fixed` = fix commits + bug tasks + broken-then-fixed; `broke` = broken cron fires, guardrail/humanizer blocks, task_blocked events; `capability_changes` = new/disabled crons, new outputs. `client_signal` stays a **reserved empty list** (locked decision 3 — the consuming LLM crons pull Omi themselves; this script never calls Omi/MCP). `stability.restarts_by_agent` is populated by spec 02's enrichment; this spec may emit it empty. Sort each list **newest-first**. Cap each list at `MAX_ITEMS_PER_BUCKET`; note any overflow in `counts`. `raw_refs` carries the union of commit SHAs + task IDs seen this run (spec 02 folds these into `.last-run.json`).
- **Step 7.1 — Write JSON (atomic).** Write the digest object to `.../fleet-activity/YYYY-MM-DD.json` via temp file + `os.replace`. Re-running for the same day overwrites that day's JSON — idempotent.
- **Retention prune (locked decision 5).** After writing, delete any `fleet-activity/*.json` whose date is older than `RETENTION_DAYS` (90). Forward-only, runs at the end of each build. Prune only day-stamped digest files; never touch `.last-run.json`.

## Out of scope
- Markdown `## FLEET_ACTIVITY_INTEL` upsert into `memory/YYYY-MM-DD.md` — that is spec 02.
- Step 5 enrichment (sources E/F), the `log-event` call, the one-line stdout summary, and writing the `.last-run.json` unions — all spec 02.
- Any LLM, Omi, or MCP call (`client_signal` stays reserved-empty).
- Changing the downstream cron contract (`growth-planning`, `linkedin-seeds` read the Markdown block — untouched here).
- The cron repoint itself (Larry-owned Phase 4, gated on Josh).

## Tests (colocated with muse scripts, fixture-based)
Fixtures: fake `cortextos bus` output (monkeypatched subprocess or captured JSON), fake git via tmp repos or injected `git log` output, fake event JSONL files, fake crons.json snapshots.
1. **Zero `Cron:` tasks in output (HARD, proven):** feed a completed-tasks fixture containing `Cron:`-prefixed and real tasks; assert no output item derives from a `Cron:`-prefixed task.
2. **Idempotency:** run twice for the same fixed `now`; assert the two `YYYY-MM-DD.json` files are byte-identical.
3. **Git SHA classification:** fixture commits with `feat`/`fix`/`revert`/`chore`/`test`/`docs`/`refactor` prefixes classify to shipped/fixed/maintenance correctly; SHAs already in `seen_commit_shas` are skipped.
4. **Event noise filtered:** JSONL fixture mixing `heartbeat_ok`/`agent_heartbeat`/`inbox_ack` with high-signal events; assert only the `{action,task}` non-noise events survive and high-signal events are prioritized.
5. **Cron broken-fire detection:** crons.json fixture where `last_fire_attempted_at > last_fired_at` produces a `broke`/broken-fire candidate; a normal fire does not.
6. **Retention prune deletes only >90d files:** seed dated JSON files spanning <90d and >90d; assert only the >90d ones are deleted and `.last-run.json` is untouched.

## Acceptance
- Clean run against fixtures; all tests above green.
- Stdlib only — no import outside `json`/`subprocess`/`datetime`/`pathlib`/`os`. No `any`-equivalent loose parsing that swallows real data; no stray debug prints in committed code.
- No `Cron:`-prefixed task ever appears in the JSON (proven by test 1).
- Re-running for the same day is byte-identical (proven by test 2).
- Atomic writes (temp + `os.replace`); no half-written JSON on a mid-write crash.
- A missing/malformed `.last-run.json`, a non-existent repo path, or a missing event/crons file degrades gracefully (treated as empty), never aborts the run.
- Diff limited to `fleet-activity-digest.py` + its test file(s).

## Sequencing
First component of the build. Spec 02 (Markdown upsert + logging + enrichment + `.last-run.json` union write) builds directly on the digest object and JSON produced here. Codexer implements (GATE: build framework=one-big-feature slug=muse-fleet-activity-digest repo=/Users/joshweiss/code/cortextos), Larry adversarial-reviews against this spec, then spec 02, then the full test run → local validation (Larry Phase 3) → PR → Josh merges → Larry repoints the cron (Phase 4).
