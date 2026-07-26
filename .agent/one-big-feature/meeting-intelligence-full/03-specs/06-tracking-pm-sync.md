# Spec 06 — §4.6 Tracking + PM sync: write to the database you already built

**Source (verbatim, Google Doc §4.6):** "Write to cxportal's Meetings Hub DB (14-table schema, PR #42). This is 'our database.' The writer (PR #141) is merged but unwired — wire its Step 4 onto the pipeline. cxportal IS the PM system for end-users — per-client meeting timeline, commitments with status, approval sign-off."

This piece has two independently-shippable halves. Split explicitly here because they have different repos, different blockers, and different priority (research doc + Josh's task instruction for this run name 6a as the dispatch-first shard).

---

## 6a — Writer wiring (file writeback): DISPATCH THIS RUN

**Repo:** `/Users/joshweiss/code/cortextos`
**Status:** buildable now, no blockers.
**Grounded in:** `.agent/one-big-feature/meeting-followup/01-research.md` "What's missing to make follow-up end-to-end" (4 bullets) + live reads below.

### The gap (verified live, 2026-07-25)

- `meeting-intelligence-engineer` Step 4 (`orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md:118-159`) is the only thing that writes `knowledge/meetings/*.md` and `knowledge/clients/*.md` — but it is a manual/operator-triggered skill, attached to **zero crons**.
- Verified live: `orgs/clearworksai/knowledge/meetings/` = `README.md` only. `orgs/clearworksai/knowledge/clients/` = `_template.md` only. Zero real files.
- Meanwhile `orgs/clearworksai/agents/crm/crm/meetings/` already has 55 real meeting files (crm agent's private dir — invisible to pa/frank2's crons).
- Two live 2h crons already try to read the empty stores: `meeting-commitments-worker` Step 5b (overdue-chase, `orgs/clearworksai/agents/pa/.claude/skills/meeting-commitments-worker/SKILL.md:127-165`) and Step 5c (orphan audit, same file :168-195) — both silently return zero rows every fire.

### Build

1. **New SKILL.md**: `orgs/clearworksai/agents/pa/.claude/skills/meeting-writeback-worker/SKILL.md`. Short-lived worker, same skeleton as `meeting-commitments-worker` (task-create → do-work → dedup-ledger → complete-task → `terminate-worker` self-cleanup, SILENT-OK on empty). Composes existing pieces, builds nothing new algorithmically:
   - Calls `python3 scripts/ff-extractor.py --mode full --full-ledger state/ff-full-writeback-surfaced.txt` (new `--full-ledger` flag — see step 2) from the frank2 agent dir, same env-sourcing pattern as `meeting-commitments-worker` Step 2 (`.env` then `secrets.env`, `set -a`/`set +a`).
   - For each meeting in the JSON `meetings` array not already in the ledger: file to `orgs/clearworksai/knowledge/meetings/YYYY-MM-DD-[client]-[topic].md` per the exact filing convention in `meeting-intelligence-engineer/SKILL.md:81-101` (header `Attendees / Source / Processed`), then write back to `orgs/clearworksai/knowledge/clients/[client].md` using the EXACT History-entry schema (`SKILL.md:141-150`) and Open-Items table schema (`SKILL.md:152-159`, `| Item | Owner | Deadline | Source | Status |`, unnamed owner → `NEEDS-OWNER`, no date → `NEEDS-DEADLINE`).
   - Client-name matching: match transcript attendees/organizer against existing `knowledge/clients/*.md` filenames (case-insensitive slug match); if no match, create from `_template.md` using the best-guess client name from the transcript and flag it in the run's log line (never silently drop a meeting for lack of a client file).
   - **Explicitly SKIPS Step 5 (kb-dream emission)** — engineer's own rule: "KB filing requires verdict... never call kb-dream-file without a prior kb-dream-verdict yes" (SKILL.md:235). An unattended worker cannot supply an operator verdict. Leave kb emission manual, exactly as research doc's bullet 4 specifies. Do NOT auto-verdict.
2. **New extractor flag** `--full-ledger PATH` in `frank2/scripts/ff-extractor.py`, mirroring the existing `--recap-ledger` pattern (`parse_args` at line 906 for the existing flag; `run_recap`/`load_recap_ledger`/`skipped_ledger` at lines 1041-1090 for the mechanism to mirror). `run_full` (line 1112) currently has NO ledger param — every 2h fire would re-run LLM extraction on already-filed meetings without this. Add: `load_ledger(path) -> set[str]`, skip transcripts whose `id` is already in the ledger (increment `skipped_ledger` in the output JSON), append newly-filed ids to the ledger after successful file-write (ledger write happens in the SKILL, not the extractor, matching the existing pattern where `--recap-ledger` is pre-LLM skip only — the extractor writes nothing to disk itself except the watermark in non-full modes). ~15 lines per research doc's estimate.
3. **Wiring**: attach to the existing 2h `meeting-commitments` cron in `pa/crons.json`, conditional-spawn pattern (proven live in `pre-meeting-brief-page`, cron prompt quoted below) — do NOT create a new cron entry; extend the existing `meeting-commitments` cron prompt to compute a COUNT of un-filed meetings first, then `spawn-worker` the new `meeting-writeback-worker` only if COUNT > 0, exactly like:
   ```
   COUNT=$(node -e '...' /tmp/pmb-candidates.json); if [ "$COUNT" -gt 0 ]; then cortextos spawn-worker ... ; else echo "no candidates - skip"; fi
   ```
   (live reference: `pa/crons.json` cron name `pre-meeting-brief-page`, `schedule: 15m`). Run the writeback spawn BEFORE the existing commitments-worker spawn in the same cron fire (or as its own conditional block appended to the same prompt) so that by the time Step 5b/5c of `meeting-commitments-worker` run, the client files are current.

### Files to touch (opencoder)

| File | Change |
|---|---|
| `orgs/clearworksai/agents/pa/.claude/skills/meeting-writeback-worker/SKILL.md` | NEW — worker skeleton per above |
| `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` | `--full-ledger` flag + `load_ledger`/skip logic in `run_full` (~line 906 for arg, ~1112-1159 for `run_full`) |
| `orgs/clearworksai/agents/frank2/tests/` (or repo's existing test location for ff-extractor) | unit test for the new ledger skip path, mirrors existing `--recap-ledger` test if one exists — locate via `grep -rl recap.ledger` under `frank2/tests` before writing a new one |
| `.cortextOS/state/agents/pa/crons.json` (or the daemon's cron-update CLI, NOT hand-edited JSON — check `cortextos bus update-cron` / equivalent before raw-editing this file) | extend `meeting-commitments` cron prompt with the conditional-spawn block |

### Test plan

- Unit: `--full-ledger` skip behavior (first run files, ledger populated; second run on same meeting id = 0 new files, `skipped_ledger` count in output).
- Live proof: run the extractor manually once against a real un-filed transcript, confirm `knowledge/meetings/*.md` and `knowledge/clients/*.md` get real content (not just `_template.md`), confirm the SAME meeting on a second run produces zero new writes.
- Confirm downstream: `meeting-commitments-worker` Step 5b/5c on the NEXT fire after a writeback picks up the newly-populated Open Items table (no code change needed there — it already reads the right path, it's just been empty).

### Out of scope for 6a

- kb-dream emission (stays manual, Josh's own call per research doc bullet 4).
- The 55 pre-existing crm/meetings files — those are a data-migration task (Google Doc §5 step 1: "route to crm/larry"), not this worker's job. This worker only handles NEW meetings going forward.
- cxportal DB write — that's 6b below.

---

## 6b — cxportal Meetings Hub DB write: NOT dispatched this run, blocked on spec 07

**Repo:** `/Users/joshweiss/code/lifecycle-killer` (symlink `~/code/cxportal`)

Google Doc §4.6 literally says "Write to cxportal's Meetings Hub DB (14-table schema, PR #42)... cxportal IS the PM system for end-users." Verified live: `migrations/0009_meetings_hub.sql` exists, shipped via PR #42 (+ #43 admin meeting-detail endpoint, +#44 RRK/Alloi seed data). Nothing in either Fireflies pipeline (frank2's `ff-extractor.py` or crm's `fireflies-ingest.py`) currently writes to this DB.

This half is explicitly blocked by §8 (spec 07): writing meeting/commitment data into cxportal's DB without a defined sync contract back to CRM (source of truth per the Doc's own framing) recreates "a second CRM that drifts" — the exact failure mode the whole doc diagnoses. Do not build 6b until 07 is resolved and Josh has signed off on the sync contract's direction-of-truth/write-path/conflict-rule.

Build shape once unblocked (for follow-up planning, not to be dispatched from this spec alone): 6a's writeback worker (or a downstream step of it) POSTs the same meeting/commitment data it just wrote to `knowledge/clients/*.md` to a new or existing cxportal Meetings Hub ingest endpoint (check `server/routes` under lifecycle-killer for an existing admin ingest route before adding one — PR #43's "admin meeting-detail endpoint" may already expose a write path). Needs its own OBF shard in the lifecycle-killer repo per the GATE cross-repo note in the master plan.
