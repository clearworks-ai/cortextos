# P1.2 — Deliverables fold-in — Master Plan

Builds on: P1.0 outputs-router (PR #187, `orgs/clearworksai/skills/outputs-router/`) and
P1.1 kb-reconcile-nightly (PR #188, ledger `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`).
Research: `01-research.md`. Spec: `03-specs/01-mirror-tool-spec.md`.

## Scope of THIS build (D4 mirror phase only)

Deliverable: `mirror_deliverables.py` — a bulk mirror tool in the P1.0 skill dir that
plans, executes, and verifies the additive mirror of all `orgs/clearworksai/agents/*/deliverables/`
files (817 today) into their content-type homes in knowledge-sync, with provenance frontmatter
and a source→target manifest.

**Explicitly OUT of scope** (later, gated — not this build):
- Flipping agents to write via `file_output.py` directly — gated on **7 green days** of
  kb-reconcile-ledger counts rows AFTER the mirror lands. Not buildable now by definition.
- Retiring/symlinking `deliverables/`.
- Any change to `file_output.py` or mmrag ingest roots (roots already cover all targets — no-op).

## Phases

### Phase 1 — dirmap + plan (manifest generation)
- Write `dirmap.json` (checked in, same skill dir): per-subtree content-type + target rules from
  research §3, incl. the `clients/<slug>/` client-home value (open flag — one-line change if
  Josh overrides), exclusion classes (`__pycache__`, `*.pyc`, `*.bak*`, `.gitignore`).
- Build `plan` subcommand: walk the five deliverables roots, apply dirmap, emit
  `manifests/p1-2-mirror-manifest.jsonl` — one row per source file (statuses `planned` /
  `excluded`), with content-type, target, sha256. **Fail loudly on any unmapped path** — no
  silent defaults.
- Gate: manifest reviewed (row count vs live `find` count; conflict/unmapped/excluded rows
  eyeballed) before Phase 2 runs with `--execute`.

### Phase 2 — mirror (additive copy)
- Build `mirror` subcommand: dry-run by default, `--execute` to write. Per row: copy (preserve
  mtime), then md/txt → **merge** provenance frontmatter (never double-`---`), others →
  `.provenance.md` sidecar reusing P1.0's format + `mirror-of:` source path. Never overwrite:
  existing-identical → `skipped-identical`; existing-different → `conflict`, nothing written.
  Manifest rows updated in place with final status.
- Idempotent: re-run converges (all `mirrored` → `skipped-identical`).

### Phase 3 — verify (done-condition, codified)
- Build `verify` subcommand, exit 0 iff BOTH:
  1. manifest row count ≥ live deliverables file count at mirror time (recounted, not 812/817
     hardcoded);
  2. every `mirrored`/`skipped-identical` pair diffs empty — md/txt compared after stripping
     exactly the injected provenance block; all other types byte-compared (`cmp`); sidecar
     existence checked for non-text.
- Any `conflict` or missing target → exit 1 with the offending rows listed.

### Phase 4 — land + ingest confirmation
- Unit tests (spec §Tests) green; `verify` green on the real corpus.
- One PR to `clearworks-ai/cortextos`: tool + dirmap + tests + manifest. knowledge-sync side
  (the ~363 MB of mirrored files) commits to the knowledge-sync repo. Josh gate on merge as
  always.
- After the next kb-reconcile-nightly run: confirm the counts row's raw distinct-file count
  rose by ≈ mirrored-row count (minus the 17 unsupported-ext files). That row is day 1 of the
  7-green-day clock for the (out-of-scope) flip.

## Risks
- **Conflict rows against pre-existing taxonomy files** (clients/msia etc. already populated) —
  mitigated: never overwrite, conflicts surfaced in verify, resolved case-by-case at review.
- **812→817 drift / live writes during mirror** — mitigated: recount at run time, idempotent
  re-run picks up stragglers.
- **Client-home flag (clients/ vs top-level)** — mitigated: it's one dirmap value behind the
  Phase 1 review gate; default = `clients/<slug>/` per research §3 recommendation.
- **Repo bloat (363 MB)** — accepted per C4; single reviewed commit.
