# Outputs Router Skill

## Purpose

This skill provides a deterministic way to file artifacts into the knowledge-sync taxonomy. It ensures that files are routed to the correct location based on their content type and that necessary frontmatter is added.

## Usage

To use the outputs router, you need to provide the content type, source file path, agent name, job name, source task ID, and date. For client-specific content, the client slug is also required.

### CLI Command

```bash
python3 orgs/clearworksai/skills/outputs-router/file_output.py --content-type <type> \
  --source <path> --agent <name> --job <name> --source-task <id> --date <ISO date> \
  [--client <slug>]
```

### Supported Content Types

| Content Type | Destination | Requires `--client`? |
| :--- | :--- | :--- |
| `client` | `raw/areas/clearworks/<client>/` | Yes |
| `people` | `raw/resources/people/` | No |
| `org` | `raw/resources/organizations/` | No |
| `sop` | `raw/resources/reference/clearworks/` | No |
| `diagram` | `raw/areas/clearworks/diagrams/` | No |
| `session` | `raw/sessions/` | No |
| `media` | `raw/media/` | No |

### Frontmatter

For `.md` and `.txt` files, the following YAML frontmatter will be injected or merged into the filed copy:

```yaml
agent: <agent_name>
job: <job_name>
source-task: <source_task_id>
date: <iso_date>
```

For other file types (e.g., PNG, PDF, binary), a sidecar file named `<basename>.provenance.md` will be created containing the frontmatter block.

## Examples

### Filing an SOP

```bash
python3 orgs/clearworksai/skills/outputs-router/file_output.py --content-type sop \
  --source /path/to/new-sop.md --agent codexer --job "create sop" \
  --source-task task_12345 --date 2026-07-31
```

### Filing a Client Document

```bash
python3 orgs/clearworksai/skills/outputs-router/file_output.py --content-type client \
  --source /path/to/client-doc.pdf --agent larry --job "client review" \
  --source-task task_67890 --date 2026-07-31 --client acme-corp
```

## Bulk Mirror (P1.2)

The bulk mirror tool (`mirror_deliverables.py`) provides automated mirroring of all agent deliverables into the knowledge-sync taxonomy with provenance tracking and verification.

### Subcommands

#### plan

Generate a manifest of all files to be mirrored:

```bash
python3 orgs/clearworksai/skills/outputs-router/mirror_deliverables.py plan \
  [--dirmap dirmap.json] [--out manifests/p1-2-mirror-manifest.jsonl]
```

The plan subcommand walks all agent deliverables directories, applies rules from `dirmap.json` to determine content types and target paths, and emits a JSONL manifest with one row per source file.

#### mirror

Execute the mirror operation (dry-run by default):

```bash
python3 orgs/clearworksai/skills/outputs-router/mirror_deliverables.py mirror \
  --manifest <path> [--execute] [--source-task <bus-task-id>]
```

- **dry-run (default)**: Prints planned operations without writing files
- **`--execute`**: Actually copies files and adds provenance
- **`--source-task`**: Bus task ID for provenance tracking

The mirror subcommand:
- Copies files preserving mtime
- Merges provenance frontmatter into `.md`/`.txt` files (adds keys only if absent)
- Creates `.provenance.md` sidecars for binary files
- Never overwrites: identical files are skipped, different files create conflict rows
- Is idempotent: re-running with `--execute` converges to all `skipped-identical` status

#### verify

Verify that the mirror completed successfully:

```bash
python3 orgs/clearworksai/skills/outputs-router/mirror_deliverables.py verify \
  --manifest <path>
```

The verify subcommand checks:
1. Manifest row count ≥ live deliverables file count
2. Every mirrored pair has empty diff after stripping provenance
3. Zero conflict or unplanned rows

Exits 0 only if all checks pass.

### Manifest Format

JSONL with one row per source file:

```json
{
  "source": "<abs path>",
  "target": "<abs path or null>",
  "agent": "auditmaster",
  "content_type": "client",
  "client": "alloi",
  "status": "planned|excluded|mirrored|skipped-identical|conflict",
  "reason": "<only for excluded/conflict>",
  "sha256": "<source sha256>",
  "supported_ext": true,
  "planned_at": "<ISO>",
  "mirrored_at": "<ISO or null>"
}
```

### Content Type Rules

The `dirmap.json` file defines per-subtree content-type rules:

```json
{
  "client_home": "raw/areas/clearworks/clients",
  "rules": [
    {"prefix": "auditmaster/alloi", "type": "client", "client": "alloi"},
    {"prefix": "auditmaster/msia", "type": "client", "client": "msia"},
    {"prefix": "auditmaster/studio-pch", "type": "client", "client": "studio-pch"},
    {"prefix": "auditmaster/rrk", "type": "client", "client": "rrk"},
    {"prefix": "auditmaster/ocg", "type": "client", "client": "ocg"},
    {"prefix": "auditmaster/logic-tcg", "type": "client", "client": "logic-tcg"},
    {"prefix": "auditmaster/talent-pipeline", "type": "session"},
    {"prefix": "auditmaster/_design-language", "type": "sop"},
    {"prefix": "auditmaster/_execution-layer", "type": "sop"},
    {"prefix": "auditmaster/_sample-audit", "type": "sop"},
    {"prefix": "auditmaster/teaching", "type": "sop"},
    {"prefix": "auditmaster/skills", "type": "sop"},
    {"prefix": "auditmaster/clearworks-assessment", "type": "sop"},
    {"prefix": "auditmaster/cxportal", "type": "sop"},
    {"prefix": "auditmaster/", "top_level_only": true, "ext_in": [".png", ".svg"], "type": "diagram"},
    {"prefix": "auditmaster/", "top_level_only": true, "type": "sop"},
    {"prefix": "frank2/", "type": "diagram"},
    {"prefix": "larry/", "type": "session"},
    {"prefix": "pa/", "type": "media"},
    {"prefix": "muse/", "type": "sop"}
  ],
  "exclude": {
    "dir_parts": ["__pycache__", ".git"],
    "name_globs": ["*.pyc", "*.bak*", ".gitignore", ".DS_Store"]
  }
}
```

### Provenance Frontmatter

For `.md` and `.txt` files, the mirror tool merges (not blindly prepends) this frontmatter:

```yaml
agent: codexer
job: deliverables-mirror-p1.2
source-task: <bus-task-id>
date: <iso-date>
mirror-of: <source-path>
```

Existing keys are preserved; new keys are added only if absent. The `mirror-of` field records the original source path for traceability.

For binary files, provenance is stored in `<target>.provenance.md` sidecar files with the same frontmatter plus the `mirror-of` field.

### Testing

Run the test suite:

```bash
python3 -m pytest tests/test_mirror_deliverables.py -v
```

Tests cover frontmatter merging, binary handling, conflict detection, exclusions, and all edge cases specified in the implementation spec.

### Done Condition

```bash
python3 orgs/clearworksai/skills/outputs-router/mirror_deliverables.py verify \
  --manifest manifests/p1-2-mirror-manifest.jsonl && echo GREEN
```

GREEN indicates: manifest rows ≥ deliverables count at mirror time, all per-pair diffs empty (provenance-stripped for md/txt), and zero conflicts.