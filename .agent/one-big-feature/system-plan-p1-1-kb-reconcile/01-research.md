# P1.1 — Research

Source of truth (binding): ~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/
MASTER-BUILD-PLAN.md line 96 (P1.1 nightly kb-reconcile), line 45-46 (C3), line 130
(context-maintenance.md), line 265-266 (daily-wiki-prep single-verdict rule).

## Problem

Index badly behind live state: Brain 0/206 files ingested, raw 10,805/36,891 (~29%) covered.
No nightly cron closes this gap today. P1.1 is the highest-leverage single item in phase 1
per v8 urgency note (line 91).

## Binding scope (verbatim, MASTER-BUILD-PLAN.md line 96)

One daemon cron: re-ingest changed files from all `DEFAULT_RECONCILE_ROOTS` + `kb-extract-edges`
refresh + counts row. First run must close two live gaps: Brain 0→206 files, raw 10,805→full
coverage of ingestible files. Absorbs frank2 `daily-wiki-prep` when live — removal is THIS
item's done-condition (single verdict per line 265-266, not dual keep+fold).

## Existing machinery (verified live)

- `knowledge-base/scripts/mmrag.py:135-139` — `DEFAULT_RECONCILE_ROOTS` = wiki, raw,
  `orgs/clearworksai/knowledge` (3rd root landed via cortextos#184, merged).
- `mmrag.py:2765` — `cmd_reconcile` function exists.
- `mmrag.py:3789` — CLI subparser `reconcile` exists.
- Reconcile machinery is already built. This item is cron wiring + gap-closing first run, not
  new reconcile logic.

## Open decision — cron owner (C3 says WHAT, not WHO)

Line 45-46: "knowledge-base skill stewards the whole KB (C3)" — C3 names the **skill**, not a
dedicated agent. No agent literally named "knowledge-base" exists in
`orgs/clearworksai/agents/` (checked all 17). Someone's `config.json` must host the nightly
cron entry that invokes the knowledge-base skill / `mmrag.py reconcile`.

Candidate: **larry** — already owns the `upstream-sync` infra cron, same category of
fleet-infra job. No Josh pick on record for this specific cron; flagging here per SCOPE_LOCK
(don't silently assume) rather than picking without a paper trail. Default to larry unless
told otherwise when specs are authored.

## Done-condition (binding, line 96 + line 265-266)

1. Brain 0→206 files ingested.
2. raw 10,805→full ingestible-file coverage.
3. 3 consecutive green nightly counts rows.
4. THEN frank2 `daily-wiki-prep` cron removed — single verdict, not dual keep+fold.
5. `kb-extract-edges` refresh runs in the same cron (line 96).

## Divergence budget (binding, all phases)

C6/C7: custom code in `orgs/`, `community/`, config — not `src/`. Cron wiring is a
`config.json` cron entry + skill invocation, not a `src/` change — no fork-delta ledger row
expected. Confirm at spec time if the reconcile invocation needs any new script (would live
under `orgs/clearworksai/` per P1.0 precedent, not `src/`).
