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