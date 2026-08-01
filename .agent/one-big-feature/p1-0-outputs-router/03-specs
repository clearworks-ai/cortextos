# Spec 01 — Outputs router skill + helper

## Objective

Ship the P1.0 outputs router: a convention doc + a deterministic filing helper, so any agent can
file an artifact into the knowledge-sync taxonomy by content type with correct frontmatter.

## Owned files (this spec owns all three, no other spec exists in this OBF-lite build)

- `/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/SKILL.md`
- `/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/file_output.py`
- `/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/all-docs/outputs-router-convention.md`

All target paths in this spec are ABSOLUTE. Never write a bare `~` in a shell command, Python
path, or mkdir call — it does not expand outside an interactive shell and will create a literal
`~` directory. Use `/Users/joshweiss/code/...` directly, or `os.path.expanduser("~/code/...")` in
Python if a home-relative literal is unavoidable.

## Files read but not edited

- `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md` (binding source)
- `orgs/clearworksai/skills/knowledge-base/SKILL.md` (style precedent for skill doc format)

## Provided contract

`file_output.py` CLI:
```
python3 file_output.py --content-type <client|people|org|sop|diagram|session|media> \
  --source <path> --agent <name> --job <name> --source-task <id> --date <ISO date> \
  [--client <slug>]
```
Content-type → destination mapping (all under `/Users/joshweiss/code/knowledge-sync/`):
- `client` -> `raw/areas/clearworks/<client>/` (requires `--client`)
- `people` -> `raw/resources/people/`
- `org` -> `raw/resources/organizations/`
- `sop` -> `raw/resources/reference/clearworks/` (NOT the `all-docs/` subdir — that is only where
  the convention doc itself lives; routed sop artifacts land one level up, per the binding table)
- `diagram` -> `raw/areas/clearworks/diagrams/`
- `session` -> `raw/sessions/`
- `media` -> `raw/media/`

Behavior:
- COPIES the source into the destination dir (`shutil.copy2` — never move; source stays in place).
  Destination filename = source basename. Creates the destination dir (`mkdir -p` semantics) if it
  does not exist (e.g. a brand-new `--client` slug).
- Frontmatter (`agent:`, `job:`, `date:`, `source-task:`): for `.md`/`.txt` sources, inject/merge
  a YAML frontmatter block in the filed copy. For any other extension (PNG/PDF/binary), do NOT
  modify file bytes — write a sidecar `<basename>.provenance.md` next to the filed artifact
  containing only the frontmatter block. Provenance never goes in the path.
- Prints the final destination path to stdout (single line, nothing else on stdout).
- Exit non-zero with a clear one-line stderr message (no traceback) on:
  - unknown `--content-type`
  - `--client` missing when `--content-type=client`
  - `--source` path that does not exist
  - destination file already exists (never silently overwrite — caller renames and retries)
- `--date` is a required flag (script does not call the system clock itself — caller passes it,
  matching this repo's workflow-script constraint on `Date.now()`/`new Date()`).

## Consumed contracts

None — this is the first P1 item, no upstream dependency within this build.

## Adjacent specs

None (single-spec OBF-lite build).

## Implementation steps

1. Write `/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/SKILL.md`:
   routing table + frontmatter contract as agent-facing instructions (style precedent:
   `orgs/clearworksai/skills/knowledge-base/SKILL.md` frontmatter block + prose sections). Include
   the sidecar rule for non-text artifacts.
2. Write `/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/file_output.py`
   implementing the CLI contract above. Use `argparse`, `shutil.copy2`,
   `os.makedirs(..., exist_ok=True)`, and simple YAML frontmatter string handling (no new pip
   dependency — stdlib only, this repo has no Python package manifest for orgs/ scripts).
3. Write the convention doc at the knowledge-sync path above — one page, routing table +
   frontmatter contract + sidecar rule, written as an SOP (see CLAUDE.md file-organization table:
   SOPs go to `raw/resources/reference/clearworks/all-docs/`).
4. FINAL STEP — assert each artifact exists at its exact absolute target path from the Owned
   files list above (e.g. `test -f /Users/joshweiss/code/cortextos/orgs/.../SKILL.md &&
   test -f /Users/joshweiss/code/cortextos/orgs/.../file_output.py &&
   test -f /Users/joshweiss/code/knowledge-sync/raw/.../outputs-router-convention.md`, non-zero
   exit / stop and fix if any is missing). Do not mark this spec done until all three assertions
   pass. Do NOT pause for confirmation mid-build — this runs autonomously; only stop if an
   assertion fails or a genuine scope ambiguity blocks progress.

## Validation requirements

Manual dry run (paste the exact commands + output into your handoff):
```
python3 /Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router/file_output.py \
  --content-type sop --source <scratch-file>.md --agent larry --job test \
  --source-task test --date 2026-07-31
```
Expected: stdout prints exactly
`/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/<scratch-file>.md`
(absolute path; NOT under `all-docs/`), exit 0, and that file exists with a well-formed YAML
frontmatter block containing `agent: larry`, `job: test`, `date: 2026-07-31`, `source-task: test`.

Error-path checks (both must exit non-zero with one-line stderr, no traceback):
1. Same command with `--source /tmp/does-not-exist.md`.
2. `--content-type client` without `--client`.

Then delete the scratch artifact (do not leave test files in knowledge-sync).

## Handoff requirements

Standard OBF handoff: files changed, dry-run command + output, risks, branch name, cleanup notes.
Branch off `main`, PR to `clearworks-ai/cortextos` — never push to main directly.
