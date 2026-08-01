# P1.0 — Outputs router (OBF-lite, exempt)

Source of truth: /Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md
(binding, D4 decided in DECISIONS-FOR-JOSH.md). Master Build Plan v9, task_1785525052000_59412389.

## Scope (why OBF-lite exempt, not full M2C1)

Single repo (cortextos), no schema migration, no new subsystem, no multi-repo coordination.
Two deliverables only:
1. One-page convention doc committed to knowledge-sync describing content-type routing.
2. A small deterministic helper that files an artifact by content type + writes frontmatter.

## Deliverable 1 — convention doc

Path: `/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/all-docs/outputs-router-convention.md`
Content: the routing table below + the frontmatter contract, written as an SOP any agent/session
can read once and follow.

Routing table (binding, from MASTER-BUILD-PLAN.md P1.0, verbatim):
- client deliverables -> `raw/areas/clearworks/<client>/`
- people/org intel -> `raw/resources/people/` or `raw/resources/organizations/`
- SOPs/playbooks -> `raw/resources/reference/clearworks/`
- diagrams -> `raw/areas/clearworks/diagrams/`
- session/build artifacts -> `raw/sessions/`
- media -> `raw/media/`

Resolved content-type → destination mapping (removes the two ambiguities in the combined rows;
binding-table-compatible):
- `client` -> `raw/areas/clearworks/<client>/` (requires `--client`)
- `people` -> `raw/resources/people/`
- `org` -> `raw/resources/organizations/`
- `sop` -> `raw/resources/reference/clearworks/` — NOTE: exactly the binding-table path, NOT the
  `all-docs/` subdir. The `all-docs/` subdir is where this convention DOC itself lives (per the
  global CLAUDE.md SOP location); routed `sop` artifacts land one level up per the binding table.
- `diagram` -> `raw/areas/clearworks/diagrams/`
- `session` -> `raw/sessions/`
- `media` -> `raw/media/`

Frontmatter contract (binding): `agent:`, `job:`, `date:`, `source-task:` — provenance lives here,
NEVER in the path.

## Deliverable 2 — helper

New skill (not a src/ change — divergence budget, custom code lives in orgs/, not src/):
`/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/SKILL.md` describing the
convention for LLM-driven filing, plus a deterministic Python helper
`/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/file_output.py` that:
- takes `--content-type <client|people|org|sop|diagram|session|media> --source <path> --agent <name>
  --job <name> --source-task <id> [--client <slug>]`
- resolves the destination path per the mapping above
- COPIES the source file into place (`shutil.copy2` — never moves; source is left in place, the
  caller deletes it if desired). Destination filename = source basename.
- creates the destination directory with `mkdir -p` semantics if it does not exist (e.g. a new
  `--client <slug>` dir)
- injects/merges YAML frontmatter with agent/job/date/source-task (date = file mtime or now, passed
  by caller since the script may not call live clock itself — accept `--date` as a required flag).
  Frontmatter injection applies ONLY to `.md`/`.txt` sources (in-file). For any other extension
  (PNG/PDF/binary — common for `media` and `diagram`), do NOT touch the file bytes; instead write a
  sidecar `<basename>.provenance.md` next to the filed artifact containing only the frontmatter
  block. Provenance stays in frontmatter either way, never in the path (D4-compatible).
- prints the final destination path to stdout (so callers/skills can chain on it; also what P1.2's
  mirror driver consumes to build its source→target manifest)
- refuses (non-zero exit, clear stderr message — no traceback) on:
  - unknown `--content-type`
  - `--client` missing when `--content-type=client`
  - `--source` file that does not exist
  - destination file already existing (never silently overwrite; caller renames and retries)

No tests infra exists for orgs/ scripts in this repo; validate via a manual dry run with a scratch
file into a scratch client dir, confirm frontmatter + path, then delete the scratch artifact.

## File ownership

Codexer owns: `orgs/clearworksai/skills/outputs-router/SKILL.md`,
`orgs/clearworksai/skills/outputs-router/file_output.py`,
`/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/all-docs/outputs-router-convention.md`
(knowledge-sync is a sibling repo, not this git root — codexer writes it as a plain file edit, no
git commit needed there, knowledge-sync is not a PR'd repo). All target paths ABSOLUTE — never a
bare `~` in a shell/mkdir/Python call.

## Validation

- `python3 file_output.py --content-type sop --source <scratch.md> --agent larry --job test
  --source-task test --date 2026-07-31` prints
  `/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/<scratch-basename>.md`
  (absolute, NOT the `all-docs/` subdir) and the file exists there with correct frontmatter.
- Error paths spot-checked: missing `--source` file and `--content-type client` without `--client`
  both exit non-zero with a one-line stderr message.
- Convention doc exists and matches the routing table above exactly.

## Rollout

Feature branch off cortextos main, PR to clearworks-ai/cortextos, Josh approves merge. Never main
direct push. knowledge-sync convention doc is written directly (no PR flow there — it's larry's own
knowledge-sync working tree, not a shared-review repo).
