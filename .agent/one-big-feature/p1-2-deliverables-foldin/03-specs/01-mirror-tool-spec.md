# Spec 01 — mirror_deliverables.py (P1.2 mirror tool)

Buildable directly by codexer. Context: `../01-research.md`, `../02-master-plan.md`.
Binding done-condition (MASTER-BUILD-PLAN.md P1): *manifest row count ≥ deliverables count at
mirror time; per-pair diff mirror vs source = empty.*

## Files to create (all under `orgs/clearworksai/skills/outputs-router/`)

| File | Purpose |
|---|---|
| `mirror_deliverables.py` | The tool — stdlib-only Python 3, no new deps (match `file_output.py`) |
| `dirmap.json` | Subtree→(content_type, target) rules + exclusions (content below) |
| `manifests/` (dir) | Manifest output; `manifests/.gitkeep` |
| `SKILL.md` | APPEND a "Bulk mirror (P1.2)" section documenting the 3 subcommands |
| `tests/test_mirror_deliverables.py` | Unit tests (below), runnable via `python3 -m pytest` or stdlib `unittest` |

Do NOT modify `file_output.py`. Import from it:
`from file_output import CONTENT_TYPE_MAPPING` (base destinations) and reuse its frontmatter
key format (`agent/job/source-task/date`) — call `create_provenance_sidecar(path, ns)` with a
`types.SimpleNamespace(agent=…, job=…, source_task=…, date=…)`; implement frontmatter MERGE
locally (P1.0's `inject_frontmatter` blindly prepends — unsuitable, see Behavior 3).

## Constants

```python
DELIVERABLES_ROOTS = {  # agent → absolute dir
  a: os.path.expanduser(f"~/code/cortextos/orgs/clearworksai/agents/{a}/deliverables")
  for a in ("auditmaster", "muse", "larry", "pa", "frank2")
}
# NOTE: resolve the repo root from __file__ (…/orgs/clearworksai/skills/outputs-router/ → 3 dirs up),
# not from a hardcoded ~/code/cortextos, so the tool works from any checkout.
MIRROR_JOB = "deliverables-mirror-p1.2"
```

## dirmap.json (ship exactly this content; reviewed at Phase-1 gate)

```json
{
  "client_home": "raw/areas/clearworks/clients",
  "rules": [
    {"prefix": "auditmaster/alloi",        "type": "client",  "client": "alloi"},
    {"prefix": "auditmaster/msia",         "type": "client",  "client": "msia"},
    {"prefix": "auditmaster/studio-pch",   "type": "client",  "client": "studio-pch"},
    {"prefix": "auditmaster/rrk",          "type": "client",  "client": "rrk"},
    {"prefix": "auditmaster/ocg",          "type": "client",  "client": "ocg"},
    {"prefix": "auditmaster/logic-tcg",    "type": "client",  "client": "logic-tcg"},
    {"prefix": "auditmaster/talent-pipeline", "type": "session"},
    {"prefix": "auditmaster/_design-language", "type": "sop"},
    {"prefix": "auditmaster/_execution-layer", "type": "sop"},
    {"prefix": "auditmaster/_sample-audit",    "type": "sop"},
    {"prefix": "auditmaster/teaching",         "type": "sop"},
    {"prefix": "auditmaster/skills",           "type": "sop"},
    {"prefix": "auditmaster/clearworks-assessment", "type": "sop"},
    {"prefix": "auditmaster/cxportal",         "type": "sop"},
    {"prefix": "auditmaster/",  "top_level_only": true, "ext_in": [".png", ".svg"], "type": "diagram"},
    {"prefix": "auditmaster/",  "top_level_only": true, "type": "sop"},
    {"prefix": "frank2/",       "type": "diagram"},
    {"prefix": "larry/",        "type": "session"},
    {"prefix": "pa/",           "type": "media"},
    {"prefix": "muse/",         "type": "sop"}
  ],
  "exclude": {
    "dir_parts": ["__pycache__", ".git"],
    "name_globs": ["*.pyc", "*.bak*", ".gitignore", ".DS_Store"]
  }
}
```

Rule matching: first match wins (order above); path key = `<agent>/<relpath-within-deliverables>`.
`top_level_only` = file's parent is the deliverables root itself. Any file matching **no** rule
→ `plan` exits 1 listing all unmapped paths (no silent fallback).

## Target path computation

```
client:   <ks>/{client_home}/<client>/<relpath-within-subtree>
others:   <CONTENT_TYPE_MAPPING[type]>/deliverables-mirror/<agent>/<relpath-within-deliverables>
diagram exception: frank2 + auditmaster top-level diagrams go directly in
          <CONTENT_TYPE_MAPPING["diagram"]>/deliverables-mirror/<agent>/<basename>
```
where `<ks>` = `~/code/knowledge-sync/`. Relpath preservation is mandatory (34 basename
collisions exist across subtrees — flattening is a correctness bug).

## CLI

```
python3 mirror_deliverables.py plan   [--dirmap dirmap.json] [--out manifests/p1-2-mirror-manifest.jsonl]
python3 mirror_deliverables.py mirror --manifest <path> [--execute] [--source-task <bus-task-id>]
python3 mirror_deliverables.py verify --manifest <path>
```
- `mirror` without `--execute` = dry-run: prints per-status counts + first 20 planned writes,
  writes nothing, exit 0.
- All three print a single summary line to stdout ending with the status counts JSON.

## Manifest format — JSONL, one row per source file (incl. excluded)

```json
{"source": "<abs path>", "target": "<abs path or null>", "agent": "auditmaster",
 "content_type": "client", "client": "alloi",
 "status": "planned|excluded|mirrored|skipped-identical|conflict",
 "reason": "<only for excluded/conflict>", "sha256": "<source sha256>",
 "supported_ext": true, "planned_at": "<ISO>", "mirrored_at": "<ISO or null>"}
```
`supported_ext` = ext in mmrag `SUPPORTED_EXTS` (hardcode the set from
`knowledge-base/scripts/mmrag.py:60-67`; comment the source line). `mirror` rewrites the
manifest atomically (tmp + rename) with updated statuses.

## Behavior — mirror subcommand

1. Copy `shutil.copy2` (preserves mtime) after `os.makedirs(dest_dir, exist_ok=True)`.
2. Never overwrite: target exists & sha256 equal (for md/txt: equal after provenance-strip) →
   `skipped-identical`; target exists & different → `conflict`, write nothing.
3. Frontmatter, `.md`/`.txt` only — MERGE:
   - File starts with `---\n…\n---\n` → parse the block as simple `key: value` lines; add
     `agent`, `job` (= `deliverables-mirror-p1.2`), `source-task`, `date` (= today ISO),
     `mirror-of` (= source path with `$HOME` → `~`) **only if the key is absent**; rewrite block;
     body bytes untouched.
   - No frontmatter → prepend a new block with those five keys.
   - No YAML lib — plain line parsing (`key: value`), preserve unknown lines verbatim.
4. All other extensions: file copied byte-identical; provenance goes in
   `<target>.provenance.md` sidecar via P1.0's `create_provenance_sidecar` + an appended
   `mirror-of: <source>` line.
5. Idempotent: second `mirror --execute` run yields zero `mirrored`, all `skipped-identical`.

## Behavior — verify subcommand (the done-condition, codified)

Exit 0 iff ALL hold; otherwise exit 1 and list every failing row:
1. **Count:** manifest row count ≥ live file count under all `DELIVERABLES_ROOTS`
   (recount with `os.walk` at verify time).
2. **Per-pair diff:** every row with status `mirrored`/`skipped-identical`:
   - md/txt: mirror bytes minus the injected/merged provenance keys (strip exactly the five
     keys `agent/job/source-task/date/mirror-of` if `job == deliverables-mirror-p1.2`, or the
     whole prepended block when source had no frontmatter) == source bytes.
   - other: `filecmp.cmp(source, target, shallow=False)` is True AND sidecar exists.
3. **No rows** with status `conflict` or `planned` (i.e. mirror ran to completion).

## Tests (tmp-dir fixtures; no writes to real knowledge-sync — patch `<ks>` base via env var `MIRROR_KS_BASE`, which the tool must honor)

| # | Case | Assert |
|---|---|---|
| t1 | md WITH existing frontmatter | merged block has 5 new keys, pre-existing keys untouched, body byte-identical; verify green |
| t2 | md WITHOUT frontmatter | block prepended; strip-diff empty |
| t3 | binary (png bytes) | target byte-identical, `.provenance.md` sidecar exists with `mirror-of:` |
| t4 | target exists, different content | status `conflict`, target untouched, verify exit 1 |
| t5 | re-run `mirror --execute` | all rows `skipped-identical`, no file mtime changes |
| t6 | `__pycache__/x.pyc`, `a.bak-old`, `.gitignore` in source | rows status `excluded` with reason; still counted in count-check |
| t7 | plan on fixture tree | manifest row count == fixture file count |
| t8 | tamper 1 byte in a mirrored binary | verify exit 1 naming that row |
| t9 | source file matching no dirmap rule | `plan` exit 1, unmapped path listed |
| t10 | basename collision (two sources, same name, different subtrees) | both mirrored to distinct targets |

## Done-condition (machine-checkable — matches Master Build Plan)

```
python3 mirror_deliverables.py verify --manifest manifests/p1-2-mirror-manifest.jsonl && echo GREEN
```
GREEN ⇔ manifest rows ≥ deliverables count at mirror time AND every per-pair diff
(provenance-stripped for md/txt) is empty AND zero conflicts. Plus: all tests pass; dry-run
default proven (t-suite); no modification to `file_output.py` (git diff clean on it).

## Out of scope (do not build)

Agent write-path flip, deliverables/ symlink/retire, mmrag/ingest-root changes, P1.0
CONTENT_TYPE_MAPPING edits, ocg slug consolidation, any deletion of source files.
