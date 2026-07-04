# Spec 02 — Markdown `## FLEET_ACTIVITY_INTEL` upsert + logging + best-effort enrichment

## Problem
Spec 01 produces the deterministic digest object and its `YYYY-MM-DD.json` artifact. But the downstream content crons — `growth-planning` (Mon 9 AM) and `linkedin-seeds` (Tue 10 AM) — do not read JSON; they already expect a `## FLEET_ACTIVITY_INTEL` Markdown block inside the day's `muse/memory/YYYY-MM-DD.md`. That interface must be produced deterministically and **idempotently**: re-running the digest for the same day must replace the section, not stack a second copy. The run also needs to record what it saw for next-run dedup, emit an auditable event, and print a one-line summary so a wrapping cron can `tail -1` it — matching the proven `process-posts.py` SILENT-OK shape. Finally, the optional narrative context from agents' own daily memory and restart logs (sources E/F) must enrich the output when present but never be allowed to fail the run.

## Goal
From the same in-memory digest object spec 01 built, render and idempotently upsert a compact `## FLEET_ACTIVITY_INTEL` block into `muse/memory/YYYY-MM-DD.md` (replace, never append); persist next-run dedup state to `.last-run.json`; fire a `log-event`; print a single-line stdout summary; and attach best-effort enrichment (sources E/F) that degrades silently on any failure. Running the whole script twice for the same day leaves exactly one `## FLEET_ACTIVITY_INTEL` section and byte-identical outputs.

## Scope
Same file: `orgs/clearworksai/agents/muse/scripts/fleet-activity-digest.py`. Tests colocated with the muse scripts.

This spec covers design-doc §3.4 Step 5 (enrichment) + Step 7.2–7.5, plus §6 Phase 2. It consumes the digest object and JSON produced by spec 01 and does not re-gather sources A–D.

### Fix A — Best-effort enrichment (Step 5, sources E/F)
- Runs before the digest object is finalized (feeds `stability` and per-agent context); the **entire** enrichment block is wrapped in try/except so a missing or malformed file never fails the run.
- **Source E — cross-agent daily memory.** For each target agent, grep `orgs/clearworksai/agents/<agent>/memory/YYYY-MM-DD.md` for lines under headings `## SHIPPED`, `## FIXED`, `## INCIDENT`; attach as free-text context to the matching agent's bucket. A missing/malformed memory file is skipped silently.
- **Source F — restart log.** Count restart lines per agent in `/Users/joshweiss/.cortextos/cortextos1/logs/<agent>/restarts.log` within the window → populate `stability.restarts_by_agent`. A missing log = 0 restarts for that agent.

### Fix B — Idempotent Markdown upsert (Step 7.2)
- Render a compact Markdown `## FLEET_ACTIVITY_INTEL` block from the **same digest object** (no re-gather), grouped `Shipped` / `Fixed` / `Broke` / `Capability changes`, one bullet per item formatted `[agent/repo] summary (ref)` (see design §3.5 illustrative render). Include the header line with date + window, e.g. `## FLEET_ACTIVITY_INTEL  (YYYY-MM-DD, 24h)`.
- Upsert into `orgs/clearworksai/agents/muse/memory/YYYY-MM-DD.md`: the section is delimited by the `## FLEET_ACTIVITY_INTEL` heading up to the next `## ` heading or EOF. **REPLACE that span, do not append.** If the section is absent, append the section to the file (or create the file if the day's memory file does not yet exist). Atomic write (temp + `os.replace`). Running twice for the same day yields exactly one `## FLEET_ACTIVITY_INTEL` section and byte-identical file content.

### Fix C — Dedup-state write (Step 7.3)
- Update `.../fleet-activity/.last-run.json` (atomic) with: `last_run_utc = now`; `seen_commit_shas` = union of prior + this run's commit SHAs; `seen_task_ids` = union of prior + this run's kept task IDs; `cron_fire_counts` = the current per-`<agent>/<cron>` `fire_count` snapshot (so the next run's Step 4 delta is exact). Source the SHAs/IDs from the digest object's `raw_refs` (populated by spec 01).

### Fix D — Log-event + stdout summary (Steps 7.4, 7.5)
- Fire: `cortextos bus log-event action fleet_activity_digest_built info --meta '{"shipped":N,"fixed":N,"broke":N}'` (counts from the digest). Wrap so a log-event failure logs but never aborts.
- Print exactly one line to stdout: `Built fleet-activity digest for <date>: N shipped, N fixed, N broke` — matching the `process-posts.py` SILENT-OK pattern so the wrapping cron can `tail -1` it.

## Out of scope
- Re-gathering or re-classifying sources A–D (spec 01 owns that; this spec reuses the in-memory digest).
- Any LLM/Omi/MCP call (`client_signal` stays reserved-empty — the consuming crons pull Omi).
- Changing the `## FLEET_ACTIVITY_INTEL` contract shape the downstream crons consume beyond what design §3.5 specifies.
- The cron repoint (Larry-owned Phase 4).

## Tests (colocated with muse scripts, fixture-based)
1. **Idempotent upsert:** run the upsert twice against a memory file (once absent, once already containing the section); assert exactly one `## FLEET_ACTIVITY_INTEL` section exists afterward and the second run replaces rather than duplicates it (byte-identical file on the second run).
2. **Section delimiting:** a memory file with content after the section (a following `## ` heading) — assert the upsert replaces only the `## FLEET_ACTIVITY_INTEL` span and leaves the following section intact.
3. **Enrichment failure never aborts:** point source E/F at a missing/malformed file; assert the run completes, writes JSON + Markdown, and simply omits the enrichment (no exception escapes).
4. **`.last-run.json` union:** given prior `seen_commit_shas`/`seen_task_ids`, assert the written state is the union of prior + this run and `cron_fire_counts` reflects the current snapshot.
5. **log-event fired:** assert the `cortextos bus log-event ... fleet_activity_digest_built ...` invocation is made with the correct counts (via monkeypatched subprocess); a log-event failure does not abort.
6. **Stdout summary:** assert stdout's last line matches `Built fleet-activity digest for <date>: N shipped, N fixed, N broke`.

## Acceptance
- Clean run against fixtures; all tests above green plus spec 01's still green.
- Running the full script twice for the same day leaves exactly one `## FLEET_ACTIVITY_INTEL` section and byte-identical JSON + Markdown (idempotency proven).
- Enrichment (sources E/F) is strictly best-effort: no missing/malformed file ever aborts the run (proven by test 3).
- Stdlib only; atomic writes for the Markdown and `.last-run.json`; no stray debug prints beyond the single summary line.
- Diff limited to `fleet-activity-digest.py` + its test file(s).

## Sequencing
Builds ON spec 01 (same script; consumes spec 01's digest object, JSON, and `raw_refs`). Implement after spec 01 lands in the same branch. Codexer implements (GATE: build framework=one-big-feature slug=muse-fleet-activity-digest repo=/Users/joshweiss/code/cortextos), Larry adversarial-reviews both specs together + runs the full test suite → Larry local validation (Phase 3: run against live data for today + a backfilled prior day, confirm zero `Cron:` leaks, SHAs match `git log`, re-run byte-identical) → PR → Josh merges → Larry repoints the `fleet-activity-intel` cron (Phase 4) and lifts Muse's hold.
