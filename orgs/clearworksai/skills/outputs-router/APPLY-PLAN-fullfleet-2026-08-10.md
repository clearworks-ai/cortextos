# G-lane apply plan — full-fleet deliverables fold-in (2026-08-10)

Track **G** (P1.2 deliverables fold-in) of the v9 finish plan. Runs the P1.0 content-type
router across **every** agent's `deliverables/`, emits the complete source→target manifest,
and stages the fold-in into the knowledge-sync ingest roots **without mutating them**.

## Problem this closes

The prior P1.2 run (`p1-2-mirror-manifest.jsonl`, 820 rows) hardcoded only 5 legacy agents
(`auditmaster, muse, larry, pa, frank2`) in `DELIVERABLES_ROOTS`. The **running `-codex`
agents** — `auditmaster-codex` (846 files), `pa-codex`, `frank2-codex`, `larry-codex` — plus
codex-only subtrees (`_engine`, `audit-assembly-skills-*`) were never scanned or routed, and
there was no manifest covering them. Result: ~900 deliverables invisible to ingest.

## What changed (this PR — additive only, no `src/`)

- `mirror_deliverables.py`: `DELIVERABLES_ROOTS` is now **auto-discovered** — any
  `orgs/clearworksai/agents/<agent>/deliverables/` is scanned (was a hardcoded 5-agent list).
  Added `MIRROR_AGENTS_DIR` env override so the planner can run from a git worktree while
  pointing at the live checkout (agent deliverables are gitignored `orgs/clearworksai/*`
  local state and are NOT present in a worktree). The top-level diagram special-case now
  matches the base agent name so `-codex` diagrams route identically to their legacy twins.
- `dirmap.json`: added `<agent>-codex/` prefix rules mirroring every legacy rule, plus rules
  for codex-only subtrees (`auditmaster-codex/_engine`, `auditmaster-codex/audit-assembly-skills`).
- `manifests/p1-2-mirror-manifest-fullfleet.jsonl`: the primary deliverable — the complete
  source→target manifest (1747 rows: 1730 planned, 17 excluded, 0 unmapped).

## Ingest roots (routed targets, per content type)

Base = `~/code/knowledge-sync/`. From P1.0 `CONTENT_TYPE_MAPPING`:

| content type | ingest root |
|---|---|
| client   | `raw/areas/clearworks/clients/<client>/` |
| sop      | `raw/resources/reference/clearworks/deliverables-mirror/<agent>/` |
| session  | `raw/sessions/deliverables-mirror/<agent>/` |
| diagram  | `raw/areas/clearworks/diagrams/` (top-level basename) or `.../diagrams/deliverables-mirror/<agent>/` |
| media    | `raw/media/deliverables-mirror/<agent>/` |

## Manifest summary (this run)

- Total rows: **1747** — planned **1730**, excluded **17** (15 `__pycache__`, 2 `.gitignore`), unmapped **0**.
- Per content type (planned): client 1243, sop 259, session 106, media 86, diagram 36.
- Per agent: auditmaster 762, auditmaster-codex 846, pa 43, pa-codex 43, larry 16,
  larry-codex 16, frank2 10, frank2-codex 10, muse 1.
- **Legacy↔codex target collisions: 623** (620 identical content → `skipped-identical` on apply;
  **3 differing** → surface as `conflict` rows, never overwritten — review those 3 by hand).
  Only `client`-type targets collide (they are not `deliverables-mirror/<agent>` namespaced);
  sop/session/diagram-subtree/media are per-agent namespaced and never collide.

## Reproduce the manifest (read-only scan — safe)

```bash
cd orgs/clearworksai/skills/outputs-router
MIRROR_AGENTS_DIR="$HOME/code/cortextos/orgs/clearworksai/agents" \
  python3 mirror_deliverables.py plan \
  --dirmap dirmap.json \
  --out manifests/p1-2-mirror-manifest-fullfleet.jsonl
# expect: plan complete: {"planned": 1730, "excluded": 17}   (exits 1 on any unmapped path)
```

## APPLY into ingest roots — HALT-AT-PROD BOUNDARY

Writing into `~/code/knowledge-sync/` mutates prod ingest roots. This PR does **not** run it.
The mirror is non-destructive by design: identical targets are skipped, differing targets
become `conflict` rows (never overwritten), and re-runs converge to all `skipped-identical`.

**Dry-run first (writes nothing):**
```bash
cd ~/code/cortextos/orgs/clearworksai/skills/outputs-router
MIRROR_AGENTS_DIR="$HOME/code/cortextos/orgs/clearworksai/agents" \
  python3 mirror_deliverables.py mirror \
  --manifest manifests/p1-2-mirror-manifest-fullfleet.jsonl \
  --source-task <bus-task-id>
```

**Apply for real (Josh runs this):**
```bash
cd ~/code/cortextos/orgs/clearworksai/skills/outputs-router
MIRROR_AGENTS_DIR="$HOME/code/cortextos/orgs/clearworksai/agents" \
  python3 mirror_deliverables.py mirror \
  --manifest manifests/p1-2-mirror-manifest-fullfleet.jsonl \
  --execute --source-task <bus-task-id>
```

**Verify after apply:**
```bash
cd ~/code/cortextos/orgs/clearworksai/skills/outputs-router
MIRROR_AGENTS_DIR="$HOME/code/cortextos/orgs/clearworksai/agents" \
  python3 mirror_deliverables.py verify \
  --manifest manifests/p1-2-mirror-manifest-fullfleet.jsonl && echo GREEN
```

After `--execute`, review any `conflict` rows (expected 3 client collisions) and resolve
by choosing legacy vs codex content per file; codex is the running superset and is normally
authoritative.
