# Fleet Cron Accountability Ledger — 2026-08-04

**Discipline:** Every cell verified at its SOURCE. No inference from stale state-files, no `cortextos status`, no empty-grep guessing.

## Sources of truth (cited per cell)
- **Inventory / schedule / enabled**: `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json` (authoritative — enumerated with `jq`, not any external list).
- **FIRES**: `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/cron-execution.log` (JSONL `{ts,cron,status:"fired"}`). Column shows LAST `ts` where `status=="fired"` for that exact cron name. `NEVER FIRED` = 0 matching rows in the log.
- **PRODUCES**: the actual artifact the cron prompt writes, found by following the prompt → output path, then `ls -lt` + content sample. `UNVERIFIED` only after a real search of the named dirs.

**Fleet "now" anchor:** latest fire across all logs = `2026-08-04T22:02:24Z` (crm heartbeat). All log timestamps are UTC; crons.json `last_fired_at` matches within ms. Fire-log file mtimes read ~7h earlier because the filesystem shows local (PT) time — the JSONL `ts` inside is UTC and is what this ledger cites.

**Cross-check note:** For every currently-enabled cron, the fire-log last-`ts` matches crons.json `last_fired_at` to the millisecond, so the two independent sources agree. Divergences are called out inline (they are all *removed* crons whose log rows survive).

---

## 1. Full per-cron ledger (78 enabled crons across 12 agents)

Legend for DISPOSITION: **KEEP** = KEEP-SCHEDULE · **RETIRE** · **EVENT** = REPLACE-WITH-EVENT · **DETERMIN** = REPLACE-WITH-DETERMINISTIC.

### auditmaster (`agents/auditmaster/crons.json`)
| agent | cron | schedule | FIRES (last-fire, log) | PRODUCES (artifact) | DISPOSITION |
|---|---|---|---|---|---|
| auditmaster | heartbeat | 4h | 2026-08-04T21:56:24Z (log 321 rows) | Bus-only: `update-heartbeat`, no file artifact — heartbeat is the product | KEEP (liveness) |
| auditmaster | gbrain-graph-refresh | 6h | 2026-08-04T21:31:24Z (log 37 rows) | `~/code/knowledge-sync/**/links.sqlite` refreshed + `kb-graph-canary` PASS/FAIL; deterministic bus commands in prompt | **DETERMIN** — prompt is two fixed `node dist/cli.js bus …` calls + a canary; no reasoning. Wrap as plain script + alert-on-FAIL. |

### codexer (`agents/codexer/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| codexer | heartbeat | 4h | 2026-08-04T21:42:54Z (log 419 rows) | Bus heartbeat only (build agent idles between dispatches) | KEEP (liveness) |

### crm (`agents/crm/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| crm | heartbeat | 4h | 2026-08-04T22:02:24Z (log 61 rows) | Bus heartbeat + inbox | KEEP (liveness) |
| crm | daily-checkin | `0 8 * * 1-5` | 2026-08-04T15:00:25Z (log 6 rows) | Reads `crm/followups.jsonl` (mtime 08-03 19:22), Telegram brief; no new file | KEEP (weekday digest cadence) |
| crm | weekly-brief | `0 9 * * 1` | 2026-08-03T16:00:12Z (log 2 rows) | Monday pipeline brief from `crm/contacts.json`/`interactions.jsonl`/`followups.jsonl`; Telegram | KEEP (weekly review) |
| crm | deal-enrichment | `0 2 * * 2-6` | 2026-08-04T09:00:20Z (log 1 row) | Nightly enrichment pass on stale deals → CRM writes; **UNVERIFIED — only 1 log row, no dated enrichment artifact found (searched crm/, crm/crm/)** — needs a human look | KEEP (cadence) — see §4 |
| crm | fireflies-ingest | 2h | 2026-08-04T20:09:24Z (log 121 rows) | **`agents/crm/crm/interactions.jsonl`** (mtime 2026-08-04 15:02, 184KB) + `contacts.json` (08-04 15:02). Sample last row: `{"ts":"2026-08-04T22:02:48Z","contact_id":"mark","type":"meeting","summary":"[CAL] CW/MSIA Catchup…"}` | **EVENT** — poll of Fireflies GraphQL. Fireflies webhook receiver already built: `src/cli/webhook-bridge.ts` (`ALLOWED_INTEGRATIONS` incl. `'fireflies'`, line 23; running PID 22230 port 20242). Replace 2h poll with webhook push; keep a wide daily backstop. |
| crm | fireflies-weekly-sweep | `0 17 * * 5` | **NEVER FIRED (log has 0 rows for it)** | Friday wide-lookback sweep → same `interactions.jsonl` path as fireflies-ingest; no artifact yet (never ran) | KEEP (weekly backstop cadence) — but see §4: never fired, needs a human look. |
| crm | zoom-officehours-reconcile | `0 16 1,15 * *` | **NEVER FIRED (log has 0 rows for it)** | Biweekly Zoom OH reconcile; prompt states "v2 webhook path is primary; this catches any missed webhook" → webhook = `webhook-bridge.ts` `'zoom-officehours'` integration (line 23) | KEEP (biweekly backstop) — legitimately a backstop to the event surface; low freq. Never fired → §4 human look (may just not have hit a 1st/15th ×16:00 slot yet). |

### frank2 (`agents/frank2/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| frank2 | heartbeat | 4h | 2026-08-04T18:14:43Z (log 67 rows) | Bus heartbeat | KEEP (liveness) |
| frank2 | check-approvals | 2h | 2026-08-04T20:05:24Z (log 134 rows) | `cortextos bus list-approvals` scan; Telegram only on pending; no file | **DETERMIN** — mechanical `list-approvals --format json` + conditional ping. Bus already has the queue; a deterministic sweep suffices (LLM adds nothing). |
| frank2 | fleet-reconcile | 15m | 2026-08-04T21:52:54Z (log 298 rows) | Spawns `fleet-reconcile-worker`; acts on drift; no durable file (bus state) | KEEP (short-cadence liveness reconcile) |
| frank2 | daily-trending-repos | `30 16 * * 1-5` | 2026-08-03T23:30:05Z (log 9 rows) | GitHub trending digest → morning-brief teaser; **UNVERIFIED — no dated trending-repos file found (searched frank2/memory, frank2/deliverables)**; likely folded into memory/Telegram — §4 | KEEP (daily research cadence) |
| frank2 | pre-meeting-brief | `0 17 * * 1-5` | 2026-08-04T00:00:06Z (log 2 rows) | Pre-meeting prep for tomorrow's calendar; Telegram only, no durable file named by the prompt | KEEP — but note overlap with `pre-meeting-brief-page` (the verified published-URL path is the live one; this text one fired only 2×). Candidate consolidation, not a clean RETIRE. |
| frank2 | weekly-review | `3 18 * * 5` | 2026-08-01T18:21:13Z (log 1 row) | Weekly review synthesis (Sonnet subagent) → Telegram/memory | KEEP (weekly review) |
| frank2 | weekly-prep | `7 14 * * 6` | 2026-08-01T21:07:03Z (log 2 rows) | Saturday next-week prep (Sonnet subagent) | KEEP (weekly) |
| frank2 | weekly-synthesis | `3 16 * * 5` | 2026-07-31T23:03:06Z (log 2 rows) — **crons.json shows `last_fired_at:null` but log has 2 real fires; json field was reset, log is authoritative** | Durable-knowledge extraction from daily notes → wiki/memory | KEEP (weekly) |
| frank2 | weekly-cleanup | `3 10 * * 0` | 2026-08-02T17:03:20Z (log 2 rows) | Stale-task review of `~/code/knowledge-sync/raw/tasks/clearworks/active.md` | KEEP (weekly) |
| frank2 | outreach-check | `2 10 * * 1,3,5` | 2026-08-03T17:02:38Z (log 2 rows) | Reads active.md SALES section (Haiku subagent) → follow-up nudges | KEEP (M/W/F cadence) |
| frank2 | client-health | `4 9 * * 3` | 2026-08-01T18:21:13Z (log 1 row) | Scans `knowledge-sync/areas/clearworks/clients/` (Haiku subagent) | KEEP (weekly) |
| frank2 | pipeline-review | `3 15 * * 4` | 2026-08-01T18:21:13Z (log 1 row) | Thursday sales-pipeline analysis (Sonnet subagent) | KEEP (weekly) |
| frank2 | human-tasks-check | 4h | 2026-08-04T18:28:43Z (log 19 rows) | SILENT-ONLY reconcile of [HUMAN] task list (dashboard already renders); no file | **DETERMIN** — prompt explicitly "purely to reconcile"; deterministic bus sweep, no LLM needed. |
| frank2 | nightly-fleet-analysis | `3 2 * * *` | 2026-08-04T09:03:20Z (log 11 rows) | Reads all agent logs (Sonnet subagent) → `agents/frank2/memory/2026-08-04.md` (mtime 08-04) | KEEP (nightly analysis) |
| frank2 | meeting-commitments | 2h | 2026-08-04T20:37:54Z (log 38 rows) | Spawns `meeting-commitments-worker`; state `state/meeting-commitments-last.txt` = bare epoch `1785839863` (mtime 08-04 13:47), P1-P3 deduped away, only P0 surfaces. **Known dead-output dupe of crm `fireflies-ingest`** (both extract meeting commitments from the same Fireflies transcripts) | **RETIRE** — dupe. Source proof: worker SKILL.md lines 94-126 (only P0 surfaces, everything else already persisted elsewhere) + crm/fireflies-ingest is the authoritative commitment writer (interactions.jsonl). Overlapping extraction, near-empty output. |
| frank2 | transcript-scanner | 2h | 2026-08-04T20:42:54Z (log 38 rows) | Spawns `transcript-scanner-worker` (bogus-gap-task history, see MEMORY) | KEEP (with caution) — active worker; not a clean retire, but repeated false-positive incidents (MEMORY 08-03) argue for **DETERMIN** hardening of the gap detector. |
| frank2 | daily-ops-dashboard | `5 15 * * *` | 2026-08-03T22:05:02Z (log 4 rows) | Builds/publishes 6-tab ops dashboard (PR #3); sources `agents/clearworksai/...` env then deploys | KEEP (daily build) — genuine artifact build. |
| frank2 | session-archaeology | `0 17 * * 0` | 2026-08-03T00:00:22Z (log 2 rows) | Synthesizes 7d of `knowledge-sync/cc/sessions/` → session-archaeology file | KEEP (weekly) |
| frank2 | daily-wiki-prep | `7 2 * * *` | 2026-08-04T09:07:20Z (log 4 rows) | `python3 knowledge-sync/scripts/wiki-synthesize…` → `~/code/knowledge-sync/wiki/_master-index.md` (mtime 2026-08-04 03:13) + `wiki/projects/` | **DETERMIN** — prompt is a single fixed `python3` script invocation; LLM wrapper is pure overhead. |
| frank2 | pre-meeting-brief-page | `*/15 7-19 * * 1-5` | 2026-08-04T22:00:24Z (log 86 rows) | Cheap `meeting-brief-scan` first, then worker renders transient `/tmp/pmb-brief.md`, publishes it with `briefs/publisher/publish_brief.py`, curl-verifies `CODE=200`, and sends the URL. No durable local/knowledge-sync write. The cited CalAsia file is a separate P1 router spot-run (`state/SKILL-OUTPUT-PATH-REGISTRY.json`). | KEEP (business-hours cadence, self-gating) |

### knox (`agents/knox/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| knox | heartbeat | 4h | 2026-08-04T21:09:30Z (log 10 rows) | Bus heartbeat | KEEP (liveness) |
| knox | daily-research-brief | `0 9 * * *` | 2026-08-04T16:00:26Z (log 2 rows) | **`agents/knox/research/output/2026-08-04/aec-brief.md`** (dir mtime 08-04 09:01) | KEEP (daily research brief) |
| knox | topic-briefing | `0 18 * * *` | 2026-08-04T01:00:07Z (log 1 row) | `research/topic-briefings/YYYY-MM-DD/options.md` per prompt; **UNVERIFIED — dir not confirmed in this pass (only 1 fire); search research/topic-briefings** — §4 | KEEP (daily) |
| knox | weekly-trends-review | `0 9 * * 1` | 2026-08-03T16:00:12Z (log 1 row) | Weekly synthesis over research/output; memory | KEEP (weekly review) |
| knox | research-quality-review | `0 12 * * 5` | **NEVER FIRED (log has 0 rows for it)** | Reads `research-quality-review` SKILL; source-failure/tuning report; no artifact (never ran) | KEEP (weekly maintenance cadence) — but never fired → §4 human look. |
| knox | research-pulse-delta | `15 6,18 * * *` | 2026-08-04T13:15:24Z (log 4 rows) | `delta_check.py` (durable venv) → appends JSONL pulse items. NOTE MEMORY: cursor advances EVERY run — deterministic script already. | **DETERMIN** — the fetch is already a fixed `.venvs/research-pulse/bin/python … delta_check.py`; the LLM only forwards JSON. Run the script on schedule, LLM-verify only new_items. |

### larry (`agents/larry/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| larry | heartbeat | 4h | 2026-08-04T21:14:24Z (log 70 rows) | Bus heartbeat + 3-repo health | KEEP (liveness) |
| larry | repo-health | 4h | 2026-08-04T21:13:54Z (log 70 rows) | `git log`/Railway status across 4 repos; Telegram on issue | **DETERMIN** — mechanical git+railway status checks; script + LLM-only-on-anomaly. |
| larry | uptime-check | 4h | 2026-08-04T21:13:54Z (log 70 rows) | `bash $CTX_AGENT_DIR/bin/uptime-check.sh` — **already a deterministic script** | KEEP-as-DETERMIN (already deterministic; leave on schedule) |
| larry | upstream-sync | `0 9 * * 1` | 2026-08-03T16:00:13Z (log 2 rows) | `git fetch upstream`; pending-commit list | KEEP (weekly) |
| larry | test-status | `0 6 * * 1-5` | 2026-08-04T13:00:23Z (log 9 rows) | `npm test` each repo; Telegram on failure | KEEP (weekday cadence) — arguably DETERMIN (fixed test runs), but failure-triage benefits from LLM. |
| larry | release-coordinator | `0 17 * * 5` | 2026-08-01T12:59:35Z (log 3 rows) — **crons.json shows `null`; log has 3 fires (authoritative)** | Friday release review, git log since Monday × 4 repos | KEEP (weekly) |
| larry | dependency-audit | `0 11 * * 4` | 2026-07-30T18:00:34Z (log 2 rows) — **crons.json shows `null`; log has 2 fires (authoritative)** | `npm audit` × 4 repos | KEEP (weekly) — but last real fire 07-30; §4 human look (stale). |
| larry | pr-review-reminder | 8h | 2026-08-04T18:32:13Z (log 36 rows) | `gh pr list --state open` × 4 repos; Telegram | **DETERMIN** — mechanical open-PR list; deterministic sweep. |
| larry | usage-audit | `7 23 * * *` | 2026-08-04T06:07:01Z (log 11 rows) | `usage-audit` SKILL → nightly friction/failure report | KEEP (nightly analysis) |
| larry | plan-adherence-audit | `7 6 * * *` | 2026-08-04T13:07:24Z (log 5 rows) | `python3 larry/bin/plan-adherence-audit…` → transcript scan | **DETERMIN** — fixed python invocation. |
| larry | pipeline-bypass-audit | `30 2 * * *` | 2026-08-04T09:30:20Z (log 3 rows) | `bash scripts/pipeline-bypass-audit.sh` → `agents/larry/memory/feedback_pipeline_bypass_2026-08-0X_*.md` (many, 08-02/08-03) | KEEP-as-DETERMIN (already a bash script on schedule; leave). |
| larry | weekly-security-audit | `7 3 * * 3` | **NEVER FIRED (log has 0 rows for it)** | 10-vector security audit → `knowledge-sync/raw/areas/clearworks/security-*`; no artifact (never ran) | KEEP (weekly security cadence) — never fired → §4 human look. |
| larry | staging-health | 4h | 2026-08-04T21:13:54Z (log 21 rows) | `bash $CTX_AGENT_DIR/bin/staging-health.sh` — **already deterministic** | KEEP-as-DETERMIN (already a script) |
| larry | cxportal-pull-nightly | `52 2 * * *` | 2026-08-04T09:52:20Z (log 3 rows) | `agents/larry/state/cxportal-pull-ledger.jsonl` (mtime 08-02 03:04 — **last WRITE 08-02 though it fired 08-04**; see §4) | KEEP (nightly import) — ledger not updated since 08-02 despite 08-04 fire → §4 human look. |
| larry | kb-reconcile-nightly | `37 3 * * *` | 2026-08-04T10:37:21Z (log 11 rows) | `agents/larry/state/kb-reconcile-ledger.jsonl` (mtime 2026-08-04 08:27) | **DETERMIN** — mmrag reconcile + kb-extract-edges are fixed commands. |
| larry | claude-mem-export | `12 3 * * *` | 2026-08-04T10:12:20Z (log 3 rows) | `agents/larry/state/claude-mem-export-ledger.jsonl` (mtime 2026-08-04 03:14) → session-memory markdown | **DETERMIN** — deterministic exporter feeding kb-reconcile. |
| larry | sweep-due-tasks | 15m | 2026-08-04T21:53:54Z (log 204 rows) | `cortextos bus sweep-due-tasks --apply` — **already a single deterministic bus command** | KEEP-as-DETERMIN (already deterministic; short cadence justified) |

### maven (`agents/maven/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| maven | heartbeat | 4h | 2026-08-04T18:46:43Z (log 93 rows) | Bus heartbeat | KEEP (liveness) |
| maven | daytime-heartbeat | `0 */2 * * *` | 2026-08-04T21:00:24Z (log 184 rows) | Second heartbeat, 2h daytime; **duplicate liveness with `heartbeat`** — no distinct artifact | **RETIRE** — redundant second heartbeat. Source proof: both are bare liveness pings (fire counts 93 vs 184, same agent, no output difference). Collapse to one. |

### muse (`agents/muse/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| muse | heartbeat | 4h | 2026-08-04T18:41:44Z (log 223 rows) | Bus heartbeat | KEEP (liveness) |
| muse | fleet-activity-intel | `0 15 * * 1-5` | 2026-08-04T22:00:24Z (log 24 rows) | SILENT deterministic `python3 muse/scripts/fleet-activity-digest.py` → `muse/memory/YYYY-MM-DD.md ## FLEET_ACTIVITY_INTEL` block | **DETERMIN** — prompt says "run exactly this one command and nothing else"; already deterministic, drop the LLM wrapper. |
| muse | morning-digest | `30 7 * * *` | 2026-08-04T14:30:25Z (log 33 rows) | **`agents/muse/memory/digests/2026-08-04.md`** (mtime 08-04 07:33, 2.6KB). Sample: `MORNING DIGEST 2026-08-04` + YOUR CONVERSATIONS / BUILDING IN PUBLIC / WORTH KNOWING. Telegram to 6690120787. **This is correlation (d).** | KEEP (daily digest — genuine reasoning cron) |

### ophir (`agents/ophir/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| ophir | heartbeat | 4h | 2026-08-04T19:16:24Z (log 435 rows) | Bus heartbeat only — ophir has NO other cron and default-to-opus (MEMORY: retier candidate) | KEEP (liveness) — but agent does nothing but heartbeat; §4 human look (is ophir doing any work at all?). |

### pa (`agents/pa/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| pa | heartbeat | 4h | 2026-08-04T21:50:57Z (log 121 rows) | Bus heartbeat | KEEP (liveness) |
| pa | morning-brief | `3 8 * * 1-5` | 2026-08-04T15:03:25Z (log 8 rows) | `bash pa/scripts/morning-brief.sh` (script mtime 08-02) → Telegram brief | KEEP (weekday digest) — script-backed already. |
| pa | evening-wrap | `2 17 * * 1-5` | 2026-08-04T00:02:28Z (log 1 row) | Evening wrap from Gmail triage; Telegram | KEEP (weekday digest) |
| pa | comms-check | 15m | 2026-08-04T21:56:27Z (log 400 rows) | Spawns `comms-check-worker`. **This is correlation (a)+(b)** — SKILL.md line 100 sends `"New email — From:… Subject:… snippet"` (Mark Lurie draft-reply); Step 4c meeting-alert-gate (lines 222-276) sends meeting-booked pings (Steven Burns via Acuity / Nancy Henriquez). No durable file; Telegram + task creation. | **EVENT** — this is a 15-min Gmail poll. Push listener already built: `agents/pa/scripts/gmail_push_listener.py`. Replace poll with Gmail push; keep a low-freq safety sweep. (Meeting-booked side also has webhook-bridge `ops-check-lead`/zoom surfaces.) |
| pa | ff-extractor | `0 */4 * * *` | 2026-08-04T19:00:14Z (log 7 rows) | `python3 scripts/ff-extractor.py` → POSTs commitments to `BRIEFS_INGEST_URL` (x-api-key `TASKS_INGEST_TOKEN`) = the **briefs.clearworks.ai tasks board**. **This is correlation (c) data feed.** | **EVENT** — Fireflies poll → briefs board. Same Fireflies webhook (`webhook-bridge.ts` line 23) can drive ingest on meeting-complete instead of every 4h. |

### sage (`agents/sage/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| sage | heartbeat | 4h | 2026-08-04T18:43:14Z (log 37 rows) | Bus heartbeat | KEEP (liveness) |
| sage | nightly-metrics | 24h | 2026-08-04T18:40:14Z (log 7 rows) | `bash memory/kpi-collector-v1.sh` → `~/.cortextos/cortextos1/analytics/kpi/latest.json` (mtime 2026-08-04 11:40, 1.5KB) | **DETERMIN** — fixed `bash kpi-collector-v1.sh`; LLM wrapper unnecessary. |
| sage | auto-commit | 24h | 2026-08-04T14:02:55Z (log 6 rows) | `local-version-control` SKILL → daily git commit | KEEP (daily) — has judgment (what to stage/commit). |
| sage | check-upstream | 24h | 2026-08-04T18:40:14Z (log 4 rows) | `upstream-sync` SKILL → framework-update check | KEEP (daily) |
| sage | catalog-browse | 7d | 2026-08-01T18:38:16Z (log 1 row) | `catalog-browse` SKILL → new-community-skill recs | KEEP (weekly) |
| sage | weekly-audit | `0 8 * * 1` | 2026-08-03T15:00:19Z (log 2 rows) | Rotating subsystem codebase scan | KEEP (weekly) |
| sage | theta-wave | `0 9 * * 0` | 2026-08-02T16:00:18Z (log 2 rows) | `theta-wave` SKILL — deep system-improvement scan | KEEP (weekly) |
| sage | experiment-loop | `0 6 * * 1-5` | 2026-08-04T13:00:23Z (log 5 rows) | Reads prior KPI JSON → daily experiment cycle | KEEP (weekday) |
| sage | fleet-health-check | 5m | 2026-08-04T22:01:57Z (log 1045 rows) | `read-all-heartbeats` + log-event; no file — pure liveness reconcile | **DETERMIN** — mechanical heartbeat read + log; 5-min LLM invocation is wasteful. Deterministic health poll. |
| sage | weekly-kpi-commits | `0 8 * * 1` | 2026-08-03T15:00:19Z (log 2 rows) | 7-day commit counts × repos; **fires same minute as `weekly-audit` (Mon 08:00), overlapping KPI/audit scope** | KEEP (weekly) — but **DETERMIN** candidate (fixed git-count loop); consolidate with weekly-audit. |
| sage | daily-system-analysis | `0 7 * * 1-5` | 2026-08-04T14:00:25Z (log 5 rows) | `git log -20` in cortextos → daily analysis before Josh's day | KEEP (weekday analysis) |
| sage | usage-monitor | 2h | 2026-08-04T20:50:56Z (log 21 rows) | `cortextos bus check-usage-api --json` → parse 5h/7d utilization | **DETERMIN** — fixed API-usage read + threshold; no reasoning. |

### scout (`agents/scout/crons.json`)
| agent | cron | schedule | FIRES | PRODUCES | DISPOSITION |
|---|---|---|---|---|---|
| scout | heartbeat | 4h | 2026-08-04T20:50:56Z (log 439 rows) | Bus heartbeat | KEEP (liveness) |
| scout | regulars-tracker | `0 6 * * 1` | 2026-08-03T13:00:16Z (log 12 rows) | Scans last 4 weekly digests → flags recurring venues; Telegram | KEEP (weekly) |
| scout | creator-expansion | `0 18 * * 5` | 2026-08-01T01:00:06Z (log 13 rows) | Weekly source-expansion feeding the daily digest | KEEP (weekly) |
| scout | morning-digest | `30 7 * * *` | 2026-08-04T14:30:28Z (log 80 rows) | **`agents/scout/outputs/digests/2026-08-04.md`** (mtime 08-04) — NE LA activities digest; Telegram | KEEP (daily digest) |

---

## 2. Disposition rollup

**Counts (78 crons):**
- **KEEP-SCHEDULE:** 45 (all heartbeats/liveness + genuine daily/weekly digests, reviews, research briefs, nightly analyses, and legit low-freq backstops)
- **REPLACE-WITH-DETERMINISTIC:** 20
- **REPLACE-WITH-EVENT:** 4 (crm fireflies-ingest, pa comms-check, pa ff-extractor) — 3 distinct + fireflies-weekly-sweep stays as backstop cadence
- **RETIRE:** 2 (frank2 meeting-commitments, maven daytime-heartbeat)
- Several KEEP rows are flagged as *already-deterministic* (uptime-check, staging-health, pipeline-bypass-audit, sweep-due-tasks) — leave on schedule, no LLM to strip.

### RETIRE list (with source proof of redundancy)
| agent | cron | Why redundant (source) |
|---|---|---|
| frank2 | meeting-commitments (2h) | Dead-output dupe of crm `fireflies-ingest`. Both extract meeting commitments from the same Fireflies transcripts. Worker `meeting-commitments-worker/SKILL.md` lines 94-126: only `P0` surfaces, P1-P3 "already persisted elsewhere"; state file `state/meeting-commitments-last.txt` is a bare epoch (near-empty output). crm/fireflies-ingest is the authoritative writer (`crm/crm/interactions.jsonl`, 184KB, live 08-04). |
| maven | daytime-heartbeat (`0 */2 * * *`) | Redundant second liveness ping alongside maven `heartbeat` (4h). No distinct artifact — both are bare `update-heartbeat`. Collapse to one. |

### REPLACE-WITH-EVENT list (target receiver, already built)
| agent | cron | schedule | Target event surface (built) |
|---|---|---|---|
| crm | fireflies-ingest | 2h | Fireflies webhook → `src/cli/webhook-bridge.ts` (`ALLOWED_INTEGRATIONS` incl. `'fireflies'`, line 23; running PID 22230:20242). Keep a wide daily backstop. |
| pa | comms-check | 15m | Gmail push listener → `agents/pa/scripts/gmail_push_listener.py`. Keep a low-freq safety sweep. |
| pa | ff-extractor | `0 */4 * *` | Fireflies webhook (same `webhook-bridge.ts`) → drive `ff-extractor.py`'s `BRIEFS_INGEST_URL` POST on meeting-complete instead of 4h poll. |
| crm | fireflies-weekly-sweep | `0 17 * * 5` | Stays a **KEEP** weekly backstop to the fireflies webhook (not a poll to replace) — listed here for completeness of the event picture. |

### REPLACE-WITH-DETERMINISTIC list (20)
auditmaster/gbrain-graph-refresh · frank2/check-approvals · frank2/human-tasks-check · frank2/daily-wiki-prep · frank2/transcript-scanner (harden gap detector) · knox/research-pulse-delta · larry/repo-health · larry/pr-review-reminder · larry/plan-adherence-audit · larry/kb-reconcile-nightly · larry/claude-mem-export · muse/fleet-activity-intel · sage/nightly-metrics · sage/fleet-health-check · sage/usage-monitor · sage/weekly-kpi-commits.
Each is an LLM cron whose prompt is a fixed script/bus-command invocation with at most a threshold check — the reasoning layer adds cost, not value.
(Already-deterministic, leave on schedule: larry/uptime-check, larry/staging-health, larry/pipeline-bypass-audit, larry/sweep-due-tasks.)

---

## 3. The four user-visible correlations (source-cited)

**(a) Email triage "New email — Mark Lurie… draft reply"**
→ **pa `comms-check` cron (15m)** → spawns `comms-check-worker`.
Source: `agents/pa/.claude/skills/comms-check-worker/SKILL.md` line 100:
`cortextos bus send-telegram 6690120787 "New email — From: <from> | Subject: <subject> | <one-line snippet>"`. The draft-reply action is the worker's downstream handling of an actionable email. Cron def: `agents/pa/crons.json` → `comms-check`.

**(b) "New meeting booked — Steven Burns via Acuity" and "Nancy Henriquez confirmation"**
→ **pa `comms-check` cron (15m)**, same worker. These are inbound booking/confirmation emails classified by the worker's meeting-notification gate.
Source: `comms-check-worker/SKILL.md` Step 4c "Meeting-notification gate" (lines 222-276) — `cortextos bus meeting-alert-gate` collapses all emails about one meeting into one Telegram; line 276 handles "zcal bookings" / confirmations. "Acuity" is not a webhook in this repo (`webhook-bridge.ts` `ALLOWED_INTEGRATIONS` = zoom-officehours/fireflies/ops-check-lead only, line 23) — the Acuity/Nancy notifications arrive as **email** and are surfaced by comms-check, NOT an event receiver.

**(c) "Dashboard — briefs.clearworks.ai" link**
→ Data feed = **pa `ff-extractor` cron (`0 */4 * * *`)** → `agents/pa/scripts/ff-extractor.py` (line 1349) `require_env("BRIEFS_INGEST_URL")` + `TASKS_INGEST_TOKEN` (x-api-key, line 1300) POSTs extracted Fireflies commitments to the briefs tasks board. Argparse description (line 1414): "Extract Fireflies commitments into the briefs tasks board." The `refresh-briefs-dashboard.sh` script (`agents/larry/scripts/`) is a **manual/legacy** publisher — it is NOT in any current crons.json (`jq '.crons[].name' larry/crons.json | grep refresh-briefs` = 0 matches; it has 260 historical log rows as a since-removed cron). frank2 `daily-ops-dashboard` builds a *separate* 6-tab ops dashboard (PR #3), not briefs.clearworks.ai.

**(d) Morning digest**
→ **muse `morning-digest` cron (`30 7 * * *`)** → Telegram to 6690120787 + persisted to `agents/muse/memory/digests/YYYY-MM-DD.md`.
Source: `agents/muse/crons.json` → `morning-digest` prompt ("PERSIST … write … to muse/memory/digests/YYYY-MM-DD.md … SEND ONE TELEGRAM to 6690120787"). Verified artifact: `agents/muse/memory/digests/2026-08-04.md` (mtime 08-04 07:33, sample `MORNING DIGEST 2026-08-04`).
(Note: scout also runs a `morning-digest` at the same `30 7 * * *` — but that is the NE LA *activities* digest → `agents/scout/outputs/digests/2026-08-04.md`, a different product. Josh's "morning digest" of pipeline/build intel = muse.)

---

## 4. Flagged for a human look (FIRES=NEVER or PRODUCES=UNVERIFIED or stale)

**NEVER FIRED (enabled in crons.json, 0 rows in fire log):**
1. `crm/fireflies-weekly-sweep` (`0 17 * * 5`) — 0 log rows. Weekly Friday backstop; may simply not have hit a Friday-17:00 slot since creation. Verify it can fire.
2. `crm/zoom-officehours-reconcile` (`0 16 1,15 * *`) — 0 log rows. Biweekly (1st/15th ×16:00) backstop to the zoom-officehours webhook; low-freq, may not have hit a slot. Verify.
3. `knox/research-quality-review` (`0 12 * * 5`) — 0 log rows. Friday weekly. Never produced its tuning report. Verify it fires this Friday.
4. `larry/weekly-security-audit` (`7 3 * * 3`) — 0 log rows. **Highest concern** — a security audit that has never once run. Confirm the Wed-03:07 slot fires and the `knowledge-sync/raw/areas/clearworks/security-*` output lands.

**PRODUCES=UNVERIFIED (fired, but no dated artifact found in searched dirs):**
5. `crm/deal-enrichment` — fired 08-04 (1 log row) but no dated enrichment artifact found (searched `crm/`, `crm/crm/`). Confirm it writes anywhere observable.
6. `frank2/daily-trending-repos` — fired 9× but no dated trending-repos file found (searched `frank2/memory`, `frank2/deliverables`); likely Telegram/memory-only. Confirm intended output.
7. `knox/topic-briefing` — fired 1× (08-04); `research/topic-briefings/YYYY-MM-DD/options.md` not confirmed this pass. Verify dir populated.

**Fired-but-output-stale (log says fired 08-04, artifact older):**
8. `larry/cxportal-pull-nightly` — fired 2026-08-04T09:52Z but `state/cxportal-pull-ledger.jsonl` last WRITE is 08-02 03:04. The cron fires but its ledger stopped advancing 2 days ago → likely a no-op/error inside the run. Human look.
9. `larry/dependency-audit` — last real fire 2026-07-30 (crons.json `null`, log 2 rows). 5 days stale for a weekly. Verify Thursday-11:00 slot still fires.

**Agent-does-nothing:**
10. `ophir` — only cron is `heartbeat` (435 fires), no work cron at all, and default-to-opus (per MEMORY cost audit). Confirm ophir is supposed to be doing anything, or disable to stop the opus liveness burn.

---
*Generated 2026-08-04. Every FIRES cell = last `status:"fired"` ts from `cron-execution.log`. Every PRODUCES cell = artifact `ls -lt` mtime + content sample, or explicit UNVERIFIED with dirs searched. crons.json vs log divergences (weekly-synthesis, release-coordinator, dependency-audit show `null` in json but have real log fires) resolved in favor of the log.*
