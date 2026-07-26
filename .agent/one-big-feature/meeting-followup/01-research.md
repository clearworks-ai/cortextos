# Research — meeting-followup (end-to-end follow-up automation)

Date: 2026-07-25. Planner: Fable. All paths verified by reading live state, not memory.

## What EXISTS and is LIVE (verified against `~/.cortextos/cortextos1/.cortextOS/state/agents/pa/crons.json`)

| Piece | Path | Trigger | Status |
|---|---|---|---|
| Fireflies extractor (single fleet touchpoint) | `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` | called by workers | LIVE. 3 modes: `commitments` (default; POSTs to briefs ingest, advances watermark), `recap` (JSON emit, `--recap-ledger` pre-LLM skip, no POST/watermark), `full` (PR#141: full meeting JSON incl. owner/deadline/source_quote; `--meeting-id` filter; no POST/watermark, **no ledger flag**) |
| Commitments surfacing | `orgs/clearworksai/agents/pa/.claude/skills/meeting-commitments-worker/SKILL.md` | pa cron `meeting-commitments` **2h, enabled** | LIVE + firing. Extract → Telegram (WE/THEY split) → Step 5b overdue-chase → Step 5c orphan audit |
| Recap Gmail draft | `orgs/clearworksai/agents/pa/.claude/skills/meeting-recap-draft-worker/SKILL.md` | pa cron `meeting-recap-draft` **4h, enabled** | Cron fires but **delivery broken since ≥2026-07-15**: `gws-dwd` implements only `+triage`/`+read` — no `+draft`. 10 recaps backlogged, ledger empty. Fix already dispatched to larry as `task_1784959165410_09349370` (add `+draft` to gws-dwd). See `incident_recap_draft_gws_dwd_missing_send_2026-07-25` |
| Transcript scanner | `orgs/clearworksai/agents/pa/.claude/skills/transcript-scanner-worker/SKILL.md` | pa cron `transcript-scanner` 2h, enabled | LIVE — but scans **bus message logs** for untracked tasks, not meeting transcripts. Not a follow-up component; leave alone |
| The writer (recap→records) | `orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md` | **NONE — manual only** | Step 4 files transcript to `knowledge/meetings/`, writes back to `knowledge/clients/*.md` (History + Open Items table); Step 5 kb-dream emission (operator verdict REQUIRED) |
| kb-dream skip tracking | `src/bus/kb-graph/dream.ts`, `src/cli/bus.ts` | via `kb-dream-file` | Merged PR#141, tested |
| Orphan audit script | `orgs/clearworksai/agents/frank2/scripts/orphan-meeting-audit.sh` | inside commitments worker Step 5c | LIVE but structurally blind (below) |
| Fireflies webhook | `~/code/briefs` PR#24 | deployed | **Unwired from delivery path.** Input dependency only — do NOT re-plan; cron polling is the live trigger today |

## THE GAP (verified 2026-07-25, incident `incident_meeting_intel_writeback_built_never_wired_2026-07-25`)

1. **No automation calls the writer.** PR#141 merged real, tested code (`--mode full`, dream.ts), but `meeting-intelligence-engineer` Step 4 — the only thing that writes `knowledge/meetings/` + `knowledge/clients/` — was never attached to any cron. Verified: `knowledge/meetings/` = README.md only; `knowledge/clients/` = `_template.md` only. Zero real files.
2. **Two downstream consumers read empty stores.** Commitments worker Step 5b (overdue-chase) and 5c (orphan audit) fire every 2h against these empty dirs — silently zero rows since merge. The orphan-audit watchdog can only flag files already filed to `knowledge/meetings/`; nothing files them, so the watchdog for the gap sits downstream of the gap.
3. **Why it stayed unwired:** `task_1784945566702_93219676` ("wire dormant SkillTree meeting skills into live pa cron chain", 2026-07-24) got queued behind gbrain-port + cron-register-reliability and never executed. Not a broken cron mechanism — all 18 pa crons fire normally (verified fire_count/last_fired).
4. **Recap delivery broken** (separate, already-dispatched fix): gws-dwd `+draft` missing.

## What's missing to make follow-up end-to-end

- A **writeback worker** (automated, non-interactive version of engineer Step 4) — genuinely new SKILL.md, but it composes existing pieces: `ff-extractor.py --mode full` + the engineer's exact History/Open Items schema + sibling worker skeleton (task create/complete, ledger, terminate-worker, SILENT-OK).
- A **pre-LLM ledger skip in `--mode full`** — `run_full` (ff-extractor.py:1112) has no ledger param, so an every-2h worker would re-run LLM extraction on already-filed meetings. Small additive flag mirroring `--recap-ledger` (~15 lines + test). Only real code change in the plan.
- The **WIRING step** — attach the worker to a live pa cron (smallest fix per the incident memo: hang off the existing 2h `meeting-commitments` cron, conditional-spawn pattern already proven in the `pre-meeting-brief-page` cron prompt: compute COUNT → `spawn-worker` only if > 0).
- **kb emission decision:** engineer Step 5 requires an operator verdict (`kb-dream-verdict yes`) before `kb-dream-file`; the skill calls skipping it a protocol violation. The automated worker therefore SKIPS Step 5 and leaves kb emission manual (or Josh explicitly authorizes auto-verdict for meeting payloads — his call, flagged in the plan).

## Reuse verdict

Compose, don't build: extractor (exists), commitments surfacing (live), recap draft (live cron, delivery fix in flight elsewhere), writer schema (exists in engineer skill), worker skeleton (two proven siblings), conditional-spawn wiring pattern (proven in pre-meeting-brief-page). New pieces: 1 SKILL.md + 1 small extractor flag + 1 cron-prompt edit. Nothing else.
