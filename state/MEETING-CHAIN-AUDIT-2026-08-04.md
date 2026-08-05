# Meeting Chain Audit — 2026-08-04

**Trigger:** Fireflies webhook `01KZ71M4876B6NKT8V3TFCQBRW` ("CW/MSIA Cathcup", mark@msia.org + josh@clearworks.ai) arrived 2026-08-04T23:17Z. pa ran the fast path at 23:22Z, extracted 2 decisions, and nothing was written anywhere.

**Method:** six parallel read-only source traces (fastpath, classifier, crm writers, recap-draft, pre-brief, wiring-map), reconciled against the LIVE cron registry at `~/.cortextos/cortextos1/.cortextOS/state/agents/*/crons.json`, live `cron-execution.log` files, and file mtimes. No file was modified.

**Verdict: 2 of 10 links work. 8 are broken.** One of them (webhook capture) works perfectly and delivers into a link (extraction) whose output has no consumer.

---

## 1. The chain, link by link

| # | Link | Intended behavior (design doc) | What actually happens | Status | Dies at |
|---|------|-------------------------------|----------------------|--------|---------|
| 1 | **Pre-brief** | `jobs/pre-call-briefing.md`: "Briefs generate from the calendar automatically · every external meeting, no trigger needed" | frank2 cron `pre-meeting-brief-page` fires every 15 min (92 fires on 08-04, last 23:30:03Z). Its step 1 runs `gws calendar +agenda --format json`, whose projection is hardcoded to `{calendar,end,location,start,summary}` — **no `attendees`, no `id`**. `parseAttendees()` returns `[]` → every event dropped. Scan returns `{"candidates":[]}` 100% of the time and has since 2026-07-03 (commit `1cc0ac45`). | INVOKED-BUT-RETURNS-EARLY | `src/bus/meeting-brief.ts:247` `if (external.length === 0) continue;` — fed lossy input by `~/.cortextos/.../frank2/crons.json` → `pre-meeting-brief-page` prompt step 1 |
| 2 | **Webhook capture** | `DESIGN-C-meeting-integration.md §0`: "Capture (webhook) → webhook-bridge → transcription completed → spawns commitments worker with FF_MEETING_ID fast path" | Works. HMAC verify at `src/cli/webhook-bridge.ts:571-580`, fireflies allowed at `:23`, target defaults to `pa` at `:625`. Delivered on time at 23:17Z. | **INVOKED-AND-WRITES** | — |
| 3 | **Extraction** | `DESIGN-C §0`: "Fetch + extract | ff-extractor.py"; `§3 A.1` "extend the extraction to emit `decisions[]` and `deal_state`" | Works — and this is where the chain silently ends. `run_full()` (the fast path the webhook names) contains **zero writes**. Its terminal statement is a `print()`. The whole 1755-line file has exactly one file-write (`save_watermark`) and one POST (`post_commitments`), both reachable ONLY from `run()` (commitments mode). `run()` never calls `extract_decisions_and_deal_state()` — so decisions are structurally unreachable from any writing mode, in every mode, always. | INVOKED-BUT-RETURNS-EARLY | `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:1714` `print(json.dumps({...}))` → `:1721 return 0`. Decisions die as dict keys at `:1588-1589`. |
| 4 | **Followups** (`crm/followups.jsonl`) | `DESIGN-B-crm.md §2 E4` + crm `AGENTS.md:46`: `crm.meeting.completed` → attendee upsert, interaction, followups, meetings file | `add-followup.py` works and is idempotent. It has **zero code callers fleet-wide**. Its only trigger is English prose inside an LLM cron prompt (`crm/crons.json` → `fireflies-ingest`, step 3), whose declared exit is "respond literally OK". The crm lane never even saw this meeting: `01KZ71M...` appears 0 times anywhere under `agents/crm/`. | EXISTS-BUT-NOTHING-INVOKES-IT | No caller. `orgs/clearworksai/agents/crm/crm/add-followup.py:54` is never reached. |
| 5 | **Pipeline / deal stage** | `MASTER-BUILD-PLAN.md:165` C2: "It owns … the CRM deal-state bridge" | `upsert-engagement.py:4` self-declares "the canonical writer for crm/pipeline.json mutations". **Zero invokers** — not in any live cron, not in any repo config.json. Its only code reference is `crm_connect_common.py:201`, which importlib-execs the module purely to scrape the `KNOWN_STAGES` constant and never calls `main()`. Second defect: `KNOWN_STAGES` (`:27-30`) contains neither `audit` nor `implementation`, so the transition pa believed happened would be rejected by argparse `choices` at `:40` even once wired. `pipeline.json` mtime Aug 3 21:25. | EXISTS-BUT-NOTHING-INVOKES-IT | `orgs/clearworksai/agents/crm/crm/upsert-engagement.py:62` — stage-transition branch; `main()` never entered. |
| 6 | **Client file writeback** | `DESIGN-C §0`: "Filing + client writeback | meeting-writeback-worker: `--mode full` → prepends client History, appends Open Items rows" | Skill is complete and already consumes decisions (`SKILL.md:323 build_decisions`, `:332 build_deal_state`, `:439`). It had a live pa cron `meeting-writeback` that fired from 2026-07-30T06:29Z through **2026-08-01T18:34:10Z** and has not fired since. It exists in **no** agent's live crons.json today. | EXISTS-BUT-NOTHING-INVOKES-IT (was wired, cron destroyed) | Invoker deleted — `src/daemon/cron-migration.ts:378` at 2026-08-01T18:00:56Z |
| 7 | **Knowledge** (meeting note + verbatim transcript) | `DESIGN-C §0`: "Verbatim transcript persist | ff-transcript-persist.py → knowledge/transcripts/"; meeting file → `knowledge/meetings/YYYY-MM-DD-[client]-[topic].md` | `ff-transcript-persist.py` is complete (incl. dnr handling at `:270-276`) and has **never had a caller** — `grep -rl ff-transcript-persist ~/.cortextos/.../state/agents/` = 0 across all 23 agents. Its output dir `orgs/clearworksai/knowledge/transcripts/` contains only `.gitkeep` (1 byte, Jul 30). Meeting notes are written by link 6, dead since 08-01; `knowledge/meetings/` newest real file is `2026-07-29-alloi-*` (Aug 2). The crm-side `meetings/*.md` files are hand-typed by an LLM following cron prose — no script writes them. | EXISTS-BUT-NOTHING-INVOKES-IT / DOES-NOT-EXIST | `orgs/clearworksai/agents/frank2/scripts/ff-transcript-persist.py:383` `main()` never reached |
| 8 | **Task assignment** (Multica / approval queue) | `MASTER-BUILD-PLAN.md:229 §3.2`: agent-executable → Multica issue (`provenance=meeting-pipeline`); human → approval queue as `[HUMAN]`, not a Telegram ping | Types and code merged. `grep -rc multica ~/.cortextos/.../state/agents/*/crons.json` → **zero across all 23 agents**. Meeting commitments still terminate at the legacy `$BRIEFS_INGEST_URL` POST. | DOES-NOT-EXIST (runtime) | No path exists |
| 9 | **Recap email draft** | `DESIGN-C §0` "Recap drafts | trust-ladder L1/L2/L3 → `gws gmail +draft` only"; `jobs/post-call-debrief.md` "the follow-up email is waiting in drafts" | Fully built and **provably worked**: `frank2/state/meeting-recap-drafts-surfaced.txt` has 14 entries from 2026-07-25, appended only on successful draft creation. pa cron `meeting-recap-draft` fired every 4h from 2026-07-26T01:55Z through **2026-08-01T18:08:09Z** (20 worker session dirs on disk). Absent from every live registry since. Secondary hazard: a **stale divergent fork** at `~/.claude/skills/meeting-recap-draft-worker/SKILL.md` (Jul 27, 2 days older) still calls `mcp__claude_ai_Gmail__create_draft`, which pa does not have — if it ever wins precedence it produces zero drafts, silently. | EXISTS-BUT-NOTHING-INVOKES-IT (was wired, cron destroyed) | Invoker deleted — `src/daemon/cron-migration.ts:378` at 2026-08-01T18:00:56Z |
| 10 | **Telegram notify** | `meeting-commitments-worker/SKILL.md:100`: "For NEW commitments only, send ONE Telegram to 6690120787, grouped by meeting" | The **only surviving write lane**. frank2's `meeting-commitments` cron is live (2h, last fired 2026-08-04T22:37:55Z, i.e. 40 min before the meeting; frank2's watermark is still at 18:00Z so the meeting is NOT burned on that lane). But the classifier yields zero for this transcript — pa proved it at 23:39Z — so there is nothing to notify about. No post-meeting Telegram went out; the two pa Telegrams on 08-04 were manual replies to Josh. | INVOKED-BUT-RETURNS-EARLY | `ff-extractor.py:1387` `if payload["commitments"]:` false → `:1406` noop branch |

### Why the classifier yielded zero (link 10's proximate cause)
Two gates, both in `pa/scripts/ff-extractor.py`:
- **LLM gate** `ACTION_ITEMS_PROMPT:99-108` — a three-way AND: named owner AND transcript-stated concrete date AND explicit commitment language ("I will"), else drop. `:113` says "Zero acceptable if none found — that is the expected result", so a total miss is indistinguishable from success.
- **Deterministic gate** `refine_outbound_item:1153-1154` — `if due is None and counterparty is None: return None`. `COUNTERPARTY_RE:200-203` has no possessive branch, so `"Automate Wendy's spreadsheet process"` yields `counterparty=None` and is dropped, while `"Build spreadsheet automation for Wendy"` survives. That single regex gap is the difference.

### The permanent burn
`save_watermark()` at `ff-extractor.py:1409` sits **outside** the `if/else` at `:1387/:1405`, so it advances on the zero-result branch identically to the success branch. `pa/state/ff-extractor-watermark.json` now reads `{"meeting_id": "01KZ71M4876B6NKT8V3TFCQBRW", "updated_at": "2026-08-04T23:39:30Z"}`. `is_newer_than_watermark():602-616` returns False for equal-timestamp/equal-id, so **pa's 4h poll can never retry this meeting.** frank2's separate watermark (18:00Z) is not burned.

---

## 2. Root cause — one paragraph

**Every write-side stage of the meeting chain is invoked by exactly one thing — a cron entry in the untracked runtime registry at `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json` — and on 2026-08-01T18:00:56Z the daemon's cron migration overwrote pa's 19-entry registry with the 4 entries found in pa's `config.json`, destroying 15 crons including `meeting-writeback` and `meeting-recap-draft`, the only invokers of the meeting-file, client-file, and recap-draft stages.** `src/daemon/cron-migration.ts:378` calls `writeCrons(agentName, converted)` unconditionally, where `converted` is built solely from `config.json` (`:352`) and the pre-existing `crons.json` is never read or merged; `src/bus/crons.ts:191` is explicitly documented as "Write (replace) all cron definitions for an agent atomically." pa's `config.json` had 4 crons; frank2's had 21 and survived the identical migration at the identical minute — which is exactly why frank2's `meeting-commitments` still fires and pa's writeback lane does not. The webhook fast path cannot compensate, because `run_full()` in `ff-extractor.py` was authored as a read-only emitter whose consumer is `meeting-writeback-worker`: it terminates in `print()` at `:1714` and contains no writer at all. So the structural cause is one sentence: **the fast path is diagnostic-only by design, its only consumer was a cron, and that cron was silently deleted by a config-driven overwrite three days before the meeting.** Two independent contributors sit outside that: the pre-brief lane feeds `meeting-brief-scan` an attendee-stripped calendar projection and has returned zero candidates since 2026-07-03, and the entire crm write lane is LLM prose in a cron prompt with no deterministic caller.

---

## 3. Designed-but-never-implemented vs implemented-then-unwired

### A. Designed, never implemented (no invoker ever existed)

| Item | Design source | Evidence of absence |
|---|---|---|
| `pa → crm` forward of `EVENT crm.meeting.completed` | `DESIGN-B-crm.md §4.3`: "one line in pa's fireflies webhook handling — after its own fast path, forward `EVENT crm.meeting.completed — <meeting_id>` to crm" | Consumer built (`crm/AGENTS.md:46`), producer never written. `grep -rn 'crm.meeting.completed' orgs src` → only AGENTS.md, two memory files, and `crm/crm/test_crm_events.py:154`. That test only asserts the string appears in AGENTS.md prose (`:156`) — it certifies documentation, not an emitter. `test_crm_events.py:15` admits it: "E4/E5/E6/E8 land via runbook, not a python emit." **This is why pa knew a deal advanced and crm did not.** |
| `ff-transcript-persist.py` invoker | `DESIGN-C §0` transcript-persist row; `MASTER-BUILD-PLAN.md:144` done-condition "≥1 per new Fireflies meeting" | Zero references in all 23 live registries; output dir has been empty since it was scaffolded Jul 30 |
| `meeting-writeback` cron (original wiring) | `DESIGN-C §3 A.2` | `git log -S meeting-writeback-worker -- orgs/clearworksai/agents/` → zero commits. It was registered at runtime only, on 2026-07-30 — never in git. larry already flagged this on 2026-07-30 (`larry/memory/handoffs/handoff-2026-07-30T02-25-00Z.md:75-80`: "Shipped twice, never wired twice") and it was not fixed. |
| Multica task rail + approval queue | `MASTER-BUILD-PLAN.md:216, :229 §3.2` | Zero crons, zero events, fleet-wide |
| `crm/write-meeting-note.py` (or any deterministic meetings-file writer) | crm `AGENTS.md:46` implies one | No script writes `crm/meetings/*.md`. `scan-stale-deals.py:37` only reads; `zoom-officehours-recap.py:154` writes `.json`. The Aug-3 russian-riverkeeper note was typed by hand by the LLM. |
| `records-admin-sweep` cron (live) | `crm/config.json:58` declares it; it is the only consumer of `interactions-to-notes.py` | Present in repo `config.json`, absent from the live crm registry. `crm/test_crm_events.py:141` asserts against `config.json`, so CI is green on a cron that has never fired. |

### B. Implemented, then unwired — with the change that removed the invoker

| Item | Invoker that existed | Removed by | Proof |
|---|---|---|---|
| **`meeting-recap-draft` cron (pa, 4h)** | Fired 20×, 2026-07-26T01:55:45Z → **2026-08-01T18:08:09.044Z** | `src/daemon/cron-migration.ts:378`, triggered from `src/daemon/agent-manager.ts:620` on agent start. Marker `~/.cortextos/.../pa/.crons-migrated` mtime **2026-08-01T18:00:56Z**. Not a commit — this is an untracked runtime write, which is why `git log` shows nothing. | 20 worker dirs `~/.cortextos/cortextos1/state/meeting-recap-draft-17853…`; `pa/cron-execution.log` first/last fire; scheduler kept firing from memory until `logs/pa/restarts.log:333 [2026-08-01T18:35:38Z] HARD-RESTART` re-read the 4-cron file |
| **`meeting-writeback` cron (pa)** | Fired 2026-07-30T06:29:38Z → **2026-08-01T18:34:10.620Z** | same write | same log; ledger `frank2/state/ff-full-writeback-surfaced.txt` mtime Jul 30 19:32 |
| **13 more pa crons** | `transcript-scanner`, `human-tasks-check`, `pre-meeting-brief-page`, `daily-ops-dashboard`, `midday-blockers`, `weekly-review`, `pipeline-review`, `outreach-check`, `client-health`, `weekly-cleanup`, `forgot-anything`, `pa-evening-wrap`, `meeting-commitments` | same write | pa registry went 19 → 5. Only `heartbeat, morning-brief, evening-wrap, comms-check, ff-extractor` have fired since. (Several duplicate frank2 crons, so the operational loss is narrower than 15 — but the meeting lane is not duplicated.) |
| **`client-context-sync` cron (frank2, 24h)** | Confirmed live 2026-07-30 (`larry/memory/handoffs/handoff-2026-07-30T02-25-00Z.md:60-63`, verified via `bus list-crons frank2`) | Unrecorded — absent today, no commit, registry is untracked | `grep -rl 'sync_client_context\|client-context-sync' ~/.cortextos/.../state/agents/` → 0 |
| **pa's `ff-extractor.py` as the canonical copy** | `6bde5073` "refactor(agents): move ff-extractor + drop stale comms-check-worker (frank2 -> pa) (#221)" git-mv'd it to pa | The mv left a 1660-line **untracked** leftover on disk at `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` (mtime Aug 3 17:36 — edited *after* the move). It has **zero** occurrences of `extract_decisions_and_deal_state`/`DECISIONS_PROMPT`; pa's has 4. Every consumer SKILL still `cd`s to frank2: `meeting-writeback-worker/SKILL.md:38`, `meeting-recap-draft-worker/SKILL.md:39`, `meeting-commitments-worker/SKILL.md:40`, `orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md:140`. Only `webhook-bridge.ts:287` says "cd pa agent dir" — which is precisely why pa's 23:22Z fast path *did* surface 2 decisions. | This is the same PR#305-class blind spot already in memory: force-added / untracked files with no diff to catch incomplete wire-up. Also untracked: `crm/crm/add-followup.py`, `crm/crm/fireflies-ingest.py`, `crm/crm/upsert-engagement.py`, `crm/config.json`, `pa/config.json`. |

---

## 4. Ordered fix plan

Sequenced by dependency. **Steps 1–3 must land before step 4**, or step 4 wires a live cron to a decisions-less script and permanently writes `Decisions: none` into client files.

### Step 0 — STOP THE BLEEDING (do first, 2 min)
**File:** `src/daemon/cron-migration.ts:378`
**Change:** merge instead of replace.
```ts
const existing = readCrons(agentName);                       // add
const merged = mergeByName(existing, converted);             // existing wins on collision
writeCrons(agentName, merged);                               // was: writeCrons(agentName, converted)
```
Also guard `:324` and `:339` — both call `writeCrons(agentName, [])` on a missing/empty/unparseable `config.json`, which zeroes a populated registry. Wrap: `if (readCrons(agentName).length === 0) { writeCrons(agentName, []); }`.
**Verify:** `npm run build && npm test`, then `rm ~/.cortextos/.../<test-agent>/.crons-migrated` on a scratch agent and confirm its runtime-added cron survives a restart.
**Effort:** SMALL. **Recovers:** nothing by itself — it stops the next silent wipe. Every fix below is worthless without it.

### Step 1 — Delete the stale frank2 extractor and repoint the four `cd` lines
**Files:**
- delete `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` (untracked leftover from `6bde5073`)
- `orgs/clearworksai/agents/pa/.claude/skills/meeting-writeback-worker/SKILL.md:38` — `cd …/agents/frank2` → `cd …/agents/pa`; also `:26` and `:74` ledger paths `frank2/state/` → `pa/state/`
- `orgs/clearworksai/agents/pa/.claude/skills/meeting-recap-draft-worker/SKILL.md:39` — same `cd`
- `orgs/clearworksai/agents/pa/.claude/skills/meeting-commitments-worker/SKILL.md:40,43` (both pa and frank2 copies) — same `cd`
- `orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md:140` — same `cd`

**Verify:**
```bash
grep -rn "agents/frank2" orgs/clearworksai/agents/pa/.claude/skills/ orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md   # expect 0
grep -c "extract_decisions_and_deal_state" orgs/clearworksai/agents/pa/scripts/ff-extractor.py   # expect 4
```
**Effort:** SMALL. **Recovers:** makes every downstream wiring step actually carry `decisions`/`deal_state`.

### Step 2 — ⭐ Restore `meeting-writeback` on pa (THE ONE CHANGE THAT RECOVERS THE MOST)
```bash
cortextos bus add-cron pa meeting-writeback 2h \
  'cortextos bus update-cron-fire meeting-writeback --interval 2h 2>/dev/null; cortextos spawn-worker "meeting-writeback-$(date +%s)" --dir "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa" --parent pa --model claude-haiku-4-5-20251001 --prompt "Read .claude/skills/meeting-writeback-worker/SKILL.md and execute it exactly. Output DONE."'
```
Then mirror the entry into `orgs/clearworksai/agents/pa/config.json` `crons[]` so it survives any future migration (and `git add -f` that config — it is currently untracked).
**Verify:** `cortextos bus list-crons pa | grep meeting-writeback`, then after one fire: `ls -t orgs/clearworksai/knowledge/meetings | head -1` shows a new file and `grep -c "Decisions:" ` on it is non-zero; `wc -l orgs/clearworksai/agents/pa/state/ff-full-writeback-surfaced.txt` increases.
**Effort:** SMALL.
**Recovers: links 6 and 7** — the meeting note in `knowledge/meetings/`, the client-file History prepend, and the Open Items rows. This is the single stage that would have captured both MSIA decisions and the deal-state change. It is 4 of the 8 broken links' worth of user-visible output.

### Step 3 — Restore `meeting-recap-draft` on pa, and kill the stale global fork
```bash
cortextos bus add-cron pa meeting-recap-draft 4h '<spawn-worker prompt, SKILL.md = meeting-recap-draft-worker>'
rm -rf ~/.claude/skills/meeting-recap-draft-worker    # Jul-27 fork that calls a Gmail MCP pa does not have
```
Mirror into `pa/config.json`. The skill was written assuming exactly this cron name and interval (`SKILL.md:26` literally calls `update-cron-fire meeting-recap-draft --interval 4h`) — no code change anywhere.
**Verify:** after one fire, `gws gmail +list --label DRAFT` shows a new recap draft, and `frank2/state/meeting-recap-drafts-surfaced.txt` gains a line (move that ledger to `pa/state/` per Step 1).
**Effort:** SMALL. **Recovers: link 9.**

### Step 4 — Fix the pre-brief calendar source
**File:** `~/.cortextos/.../frank2/crons.json` → `pre-meeting-brief-page` prompt step 1. Replace `gws calendar +agenda --format json` with the raw events resource, which returns `id` and `attendees`:
```bash
gws calendar events list --params "{\"calendarId\":\"primary\",\"timeMin\":\"$(date -u +%FT%TZ)\",\"timeMax\":\"$(date -u -v+3H +%FT%TZ)\",\"singleEvents\":true,\"orderBy\":\"startTime\"}" --format json > /tmp/pmb-events.json
```
**File:** `src/bus/meeting-brief.ts:136` — accept the native envelope: add `else if (isRecord(parsed) && Array.isArray(parsed.items)) { entries = parsed.items; }`.
**Do NOT** relax `meeting-brief.ts:247` — that filter is correct.
Add a loud guard: if `events.length > 0 && every event has attendees.length === 0`, warn to stderr. That one line would have caught this on 2026-07-03.
**Verify:** `cortextos bus meeting-brief-scan --now 2026-08-05T20:00:00Z` returns a non-empty `candidates[]` for the CalAsia onsite.
**Effort:** SMALL. **Recovers: link 1** (and stops `pre-meeting-brief`, the 17:00 daily cron, from being asked to report attendees it structurally cannot have — the fabricated-attendee shape already on record).

### Step 5 — Add the `EVENT crm.meeting.completed` producer
**File:** `orgs/clearworksai/agents/pa/.claude/skills/meeting-commitments-worker/SKILL.md`, after Step 2:
```bash
cortextos bus send-message crm normal "EVENT crm.meeting.completed — {\"meeting_id\":\"$FF_MEETING_ID\"}"
```
The consumer already exists at `crm/AGENTS.md:46`. Mirrors the E1/E2/E3/E7 pattern already tested in `crm/crm/test_crm_events.py`.
**Verify:** `cortextos bus inbox crm | grep crm.meeting.completed` after a webhook.
**Effort:** TRIVIAL. **Recovers:** the pa→crm notification gap — the reason pa knew and crm didn't.

### Step 6 — Wire `ff-transcript-persist`
Append the persist call to pa's existing `ff-extractor` 4h cron prompt (shares env + tick) rather than adding a new cron.
**Verify:** `ls orgs/clearworksai/knowledge/transcripts | wc -l` > 0 after the next Fireflies meeting.
**Effort:** SMALL. **Recovers: link 7's transcript half** and satisfies `MASTER-BUILD-PLAN.md:144`.

### Step 7 — Stop the silent watermark burn
**File:** `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:1408-1409` — `save_watermark()` sits outside the if/else. Gate it, or (safer) keep advancing but append a `state/ff-extractor-zero-yield.jsonl` row per dropped meeting so misses are auditable. Also add per-transcript drop-reason counters (`empty_text` / `casual` / `zero_extracted` / `all_refined_out`) to the `run()` output dict at `:1406`, mirroring the counters `run_full` already emits at `:1714`.
**Verify:** run a dry-run over a known-zero meeting, confirm a zero-yield row appears.
**Effort:** SMALL. **Recovers:** diagnosability. Without it, every classifier tuning change below is untestable against real historical misses.

### Step 8 — Loosen the classifier's one over-strict edge
**File:** `ff-extractor.py:200-203` `COUNTERPARTY_RE` — add a possessive branch, e.g. `|\b([A-Z][A-Za-z0-9&.-]+)(?:'s|’s)\b`. This converts `"Automate Wendy's spreadsheet process"` from DROP→KEEP without touching the due-date rule.
**Verify:** `python3 orgs/clearworksai/agents/pa/scripts/test_ff_extractor.py` (add the two MSIA strings as cases).
**Effort:** TRIVIAL.
Separately, `ACTION_ITEMS_PROMPT:102-105` needs a second tier (`status:"unscheduled"`, `dueDate:""` for owner+scope-but-no-date) — MEDIUM, and do NOT do it before Step 7 exists to measure the change.

### Step 9 — Make the crm lane deterministic
**File:** `~/.cortextos/.../crm/crons.json` → `fireflies-ingest`. Replace prose steps 1–5 with a single deterministic script call (extend `crm/crm/fireflies-ingest.py` to do upsert→interaction→followup→meetings-file and exit non-zero on partial failure). Also: `upsert-engagement.py:27-30` `KNOWN_STAGES` must gain `audit` and `implementation` or any delivery-stage transition is rejected at `:40`. Register `records-admin-sweep` in the live registry. `git add -f` the untracked crm scripts and configs.
**Verify:** `git ls-files orgs/clearworksai/agents/crm/crm/*.py | wc -l` matches the on-disk count; after a webhook, `grep -c <meeting-id> crm/ingested-transcripts.txt` = 1 and `followups.jsonl` gains a row with `source_ref: fireflies:<id>`.
**Effort:** MEDIUM.

### Step 10 — Multica / approval-queue rail
`MASTER-BUILD-PLAN.md §P3`, gated on P3.0a/P3.0b. **Do not start before Steps 2 and 5 land.** LARGE.

---

## 5. What must NOT be done

1. **Do not kill pa's 4h `ff-extractor` commitments poll, and do not kill frank2's 2h `meeting-commitments` cron.** Neither event path is proven yet. The standing rule holds: never kill a poll until its event path is proven to produce the same artifact.
2. **Do not point the webhook at `meeting-commitments-worker` and also leave the poll running with a shared write target.** The relay at `webhook-bridge.ts:287` currently names `meeting-commitments-worker` but hands it `--mode full` output. That skill iterates `items` (`SKILL.md:70`), a key `run_full` never emits (`:1714` emits `{mode, meetings, skipped_*}`). Repointing the relay to `meeting-writeback-worker` is the correct fix; wiring it to commitments would create a real double-post to `$BRIEFS_INGEST_URL`.
3. **Double-post hazard already live:** pa's `ff-extractor` cron and frank2's `meeting-commitments` cron both run commitments mode against the same `$BRIEFS_INGEST_URL` with **separate watermarks** (`pa/state/…` at 23:00Z/burned, `frank2/state/…` at 18:00Z/not burned). Restoring pa's `meeting-commitments` cron on top of frank2's would make it three. Pick one owner — pa — and disable frank2's, but only after one clean cycle proves pa's fires.
4. **Do not relax `src/bus/meeting-brief.ts:247`.** The external-attendee filter is correct and is the pre-brief skill's hard exclusion rule. The input is wrong, not the filter.
5. **Do not add `--recap` to the existing pa `ff-extractor` cron invocation.** `ff-extractor.py:1728` makes `--mode` and `--recap` mutually exclusive; doing so would kill commitment posting. Recap needs its own cron (Step 3).
6. **Do not wire `meeting-writeback` before Step 1.** As written, its `cd` at `SKILL.md:38` lands in frank2 and executes the decisions-less untracked leftover — it would write `Decisions: none` on every meeting, which is exactly the gap `DESIGN-C §1` calls "the one place the automated chain is lossy vs the SkillTree spec."
7. **Do not run a manual `meeting-intelligence-engineer` backfill over the same window as a newly-restored writeback cron.** Neither knows about the other; the `call-prep-researcher` output does not mark events surfaced, so the CalAsia onsite would get two briefs.
8. **Do not "fix" the MSIA meeting by hand-editing the watermark on a live pa session.** If you want it reprocessed, do it deliberately: stop the pa poll, reset `pa/state/ff-extractor-watermark.json` to the prior meeting, run once with `--dry-run` first.

---

## 6. Open questions for Josh

1. **Which agent owns the meeting lane — pa or frank2?** Right now both run commitments mode against the same briefs endpoint with independent watermarks. `webhook-bridge.ts:625` hardcodes `pa`; every SKILL.md and frank2's live cron say frank2. I can make either one canonical, but not both.
2. **Should the `~/.cortextos/.../state/agents/*/crons.json` registry become git-tracked (or continuously mirrored to a tracked file)?** Every loss in this audit — 15 pa crons, `client-context-sync` — is invisible to git because that registry is untracked runtime state. Mirroring it is a design change, not a bug fix.
3. **Should opportunity-shaped items ("we could automate Wendy's spreadsheet") become trackable commitments with no due date, or stay out of the commitment stream and live only in the meeting-note Decisions section?** Step 2 alone puts them in `knowledge/meetings/` and the client file. Making them followups (Step 8's tier-2 change) is a different bar and will increase volume.
4. **Reprocess `01KZ71M4876B6NKT8V3TFCQBRW`, or let it go?** pa's lane is permanently burned; frank2's is not. Recovery requires a deliberate watermark reset (see §5.8).
5. **Delete or stub `~/.claude/skills/meeting-intelligence-engineer/SKILL.md`?** The global copy is the unmodified Altari original with no `## I/O Contract` — any agent falling back to it silently loses the vault wiring. Same duplicate-copy hazard larry logged on 2026-07-31 for three skills.
