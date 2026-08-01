# P1.1 — Nightly kb-reconcile cron (OBF-lite, exempt)

Source of truth: ~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md
line 96 (binding), line 265-266 (single-verdict rule). Research: 01-research.md in this dir.

## Scope (why OBF-lite exempt, not full M2C1)

Single repo (cortextos), no schema migration, no new subsystem, no `src/` changes. The reconcile
machinery already exists and is verified live (`knowledge-base/scripts/mmrag.py` —
`DEFAULT_RECONCILE_ROOTS` at :135-139, `cmd_reconcile` at :2765, CLI subparser at :3789;
`cortextos bus kb-extract-edges` at `src/cli/bus.ts:2661`). This item is CRON WIRING ONLY:

1. One new cron entry in larry's `config.json` (cron owner per research doc — larry already owns
   `upstream-sync`, same fleet-infra category; no Josh pick on record, flagged below).
2. One new wrapper script under `orgs/clearworksai/agents/larry/bin/` (divergence budget: custom
   code lives in `orgs/`, never `src/` — same rule P1.0 followed; precedent for larry-cron
   scripts: `bin/uptime-check.sh`, `bin/staging-health.sh`, `scripts/pipeline-bypass-audit.sh`).
3. A counts-row JSONL ledger the wrapper appends to, so freshness is provable per night.

Do NOT reimplement reconcile or edge-extraction logic. Do NOT touch frank2's config now — its
`daily-wiki-prep` removal is the done-condition verdict, spec'd but executed later.

## Deliverable 1 — wrapper script

`orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` — needed because the cron must chain
three steps and append a machine-readable row; that is scripting, and per the divergence budget it
lives under `orgs/clearworksai/`, not `src/`. No fork-delta ledger row expected (no `src/` change).

The script, in order:
1. `knowledge-base/venv/bin/python3 knowledge-base/scripts/mmrag.py reconcile --json --yes`
   — defaults already cover all three `DEFAULT_RECONCILE_ROOTS` (wiki, raw,
   `orgs/clearworksai/knowledge`) and collection `shared-clearworksai`; no `--roots` override.
   NOTE (verified in source): even with `--json`, per-file `SKIP (error)` lines print to stdout
   BEFORE the final JSON report (`mmrag.py` ~:1699) — the wrapper must parse the LAST JSON object
   on stdout, not the whole stream.
2. `cortextos bus kb-extract-edges --org clearworksai --json` — refreshes `links.sqlite`
   (deterministic, zero-LLM; default roots via `defaultExtractRoots`).
3. Compose one JSONL counts row from both JSON outputs + a UTC timestamp + a computed `green`
   boolean, append to the ledger (exact format in spec-01).

## Deliverable 2 — cron entry

One new object in larry's `config.json` `crons` array, matching the existing script-driven pattern
(`pipeline-bypass-audit` is the closest precedent: create bus task → update-cron-fire → run script
→ complete task on success). Schedule `37 3 * * *` (larry tz = America/Los_Angeles):
- AFTER frank2's `daily-wiki-prep` at `7 2 * * *`, so during the coexistence window each night's
  new wiki articles are ingested the same night, and reconcile isn't walking `wiki/` while frank2
  commits into it.
- Offset from larry's own `pipeline-bypass-audit` (`30 2 * * *`) and `weekly-security-audit`
  (`7 3 * * 3` — would collide every Wednesday at 3:07).

Because first runs are long (below), the cron prompt launches the wrapper in the background
(run_in_background / nohup) and does NOT wait for completion; the wrapper itself writes the ledger
row when it finishes. Each cron fire also checks the PREVIOUS night's row and Telegrams Josh only
if it is red or missing (silent-failure on a KB cron is a known escalation pattern — frank2's
wiki-prep failed silently 3 nights May-Jun 2026).

## First run — closing the two live gaps

- Brain (`orgs/clearworksai/knowledge`): 0 → 206 files. Small; should complete in run one.
- raw: 10,805 → full ingestible coverage (~36,891 candidates, ~26k backlog).

Timing precedent: NONE found in this repo — no measured reconcile duration exists anywhere I could
locate. What IS verified: `mmrag.py` has resumable checkpointing built specifically for
interrupted long runs (`reconcile_checkpoints` table at :517, `--fresh` flag, `resumed_files`
counter). So a multi-night first close is safe by design: each nightly run resumes where the last
stopped, `resumed_files` in the counts row proves progress, and no run is wasted. Do not promise a
one-night close; expect the raw backlog to take one to several nights of Gemini/embedding ingest
(cost tracked by mmrag's own `_tracker`). The Brain gap (206 files) should close night one and is
the early canary that the cron works at all.

## Done-condition tracking (binding, plan line 96 + 265-266)

1. Brain 0→206 ingested — proven by `total_files_indexed_after` growth + a targeted
   `mmrag.py` query against a Brain file.
2. raw at full ingestible coverage — proven when `total_files_indexed_after` ≈
   `total_files_on_disk` (modulo ignored files) and `new_files` drops to steady-state small.
3. **3 consecutive green nightly counts rows** in the ledger (`green: true` per spec-01's
   definition: reconcile exit 0, `failed_files == 0`, `delete_failures` all zero, edge-extract
   `errors` empty).
4. THEN — single verdict — remove frank2's `daily-wiki-prep` cron via PR (spec'd in spec-01,
   executed only after step 3; Josh approves the merge like any main merge). Not dual keep+fold;
   this is binding per line 265-266, do not re-litigate at build time.

Verification is mechanical: `tail -3` the ledger, all three rows `green: true`, dates consecutive.

## File ownership

Codexer owns:
- `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` (new)
- `orgs/clearworksai/agents/larry/config.json` (one cron object appended to `crons`)

Created at runtime by the wrapper (not committed):
- `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`

NOT touched: `orgs/clearworksai/agents/frank2/config.json` (removal is a later, separate PR),
anything under `src/`, `knowledge-base/scripts/mmrag.py`.

## Open questions / flags (do not guess at build time)

1. **Cron owner = larry is the research doc's default, not a Josh pick.** Flagged per SCOPE_LOCK.
   Proceed with larry unless Josh objects at PR review — the PR itself is the paper trail.
2. **Counts-row schema/location is derived, not binding.** No prior KB counts ledger exists; the
   schema in spec-01 is derived from the actual `_reconcile_collection` report keys
   (`mmrag.py:1710-1727`) and `extractEdges` result keys (`bus.ts`). Repo-root
   `state/pipeline-ledger.jsonl` is JSONL-ledger precedent, but that dir is a shared-clobber zone;
   the agent-owned `larry/state/` path is chosen deliberately. Build step: keep as spec'd unless a
   conflicting convention surfaces.
3. **Stale brief:** `orgs/clearworksai/knowledge/skilltree-system-brief.md:25` claims a
   `gbrain-graph-refresh` cron owned by auditmaster — no such cron exists in any of the 17 agent
   config.json files (checked). Irrelevant to this build (edge refresh runs in THIS cron per plan
   line 96), but do not cite that brief as evidence of existing coverage.
4. **API key preflight:** `mmrag.py` needs its Gemini key via `load_config()`. The wrapper must
   fail loudly (red ledger row) if reconcile exits non-zero for config reasons, not silently skip.

## Rollout

Feature branch off cortextos main, PR to `clearworks-ai/cortextos`, Josh approves merge. Never
main direct push. After merge, the daemon picks up larry's new cron on next config reload/restart;
first fire at 03:37 PT. The frank2-removal PR happens only after the 3-green-rows condition.
