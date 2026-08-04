# Spec v2 — mirror_deliverables.py tool + the two merged bugfixes

Supersedes `03-specs/01-mirror-tool-spec.md` for provenance purposes only — the original build
spec was correct and is not being re-derived here. This document records the tool as it exists on
`main` today plus concrete detail on the two real bugs found post-build and fixed via merged PRs,
and the one known-but-unfixed verify edge case. Grounded in
`orgs/clearworksai/skills/outputs-router/mirror_deliverables.py` (current) and `git log --oneline
-- orgs/clearworksai/skills/outputs-router/mirror_deliverables.py`, which shows, most-recent-first:
`bbcd416` (PR #250), `9666c14` (PR #248), `0721f95` (original build).

## Bug 1 — REPO_ROOT off-by-one (PR #248, commit `9666c14`)

File: `mirror_deliverables.py`, `REPO_ROOT` constant (near line 75).

Directory shape: `<repo root>/orgs/clearworksai/skills/outputs-router/mirror_deliverables.py`.
Walking up from that file to repo root requires 4 hops: `outputs-router → skills → clearworksai →
orgs → <repo root>`.

Before:
```python
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ""))
```
(3 `".."` hops — the original build spec's own comment said "3 dirs up," which was itself wrong).
This resolved to `<repo root>/orgs/orgs/...`-shaped nonsense, one level too shallow — a directory
that does not exist on disk.

After (current, on `main`):
```python
# Resolve repo root from __file__ (…/orgs/clearworksai/skills/outputs-router/ → 4 dirs up:
# outputs-router -> skills -> clearworksai -> orgs -> repo root)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
```
4 `".."` hops, correctly landing on the actual repo root.

Real effect of the bug: `DELIVERABLES_ROOTS` (built from `REPO_ROOT`) pointed at nonexistent
paths for all five agents. `plan_subcommand`'s loop does `if not os.path.exists(root): continue`
— so instead of erroring, the tool silently produced a *successful*, empty (0-row) manifest. This
is the dangerous failure mode: a broken run looks identical to a real one that happens to find
nothing, with no stderr signal. Caught before the real fold-in ran, via the manifest row count
(0) failing sanity-check against the expected ~817.

## Bug 2 — `plan_subcommand` exclusion check only tested `dir_parts` (PR #250, commit `bbcd416`)

File: `mirror_deliverables.py`, `plan_subcommand()` (roughly lines 290–345) and
`compute_target_path()` (roughly lines 92–132).

`dirmap.json`'s `exclude` block has two independent exclusion classes:
```json
"exclude": {
  "dir_parts": ["__pycache__", ".git"],
  "name_globs": ["*.pyc", "*.bak*", ".gitignore", ".DS_Store"]
}
```
`compute_target_path()` always checked both classes and returned `target=None` if either matched
(a `name_glob` match hits `for glob in dirmap["exclude"]["name_globs"]: ... return None`, roughly
line 105–107). But `plan_subcommand()`, which decides the manifest row's `status`, only checked
`dirmap["exclude"]["dir_parts"]` before falling through to the `planned` branch — it never
consulted `name_globs` at that decision point.

Before (effective logic in `plan_subcommand`, pre-fix): a file matching a `name_globs` pattern
(e.g. a stray `.gitignore` sitting inside a deliverables subtree, or a `*.bak-predensity` file)
still got `status="planned"` and called `compute_target_path()` for its target — which correctly
returned `None` per the `name_globs` check. Net result: a manifest row with
`status="planned", target=None` — self-contradictory and unhandled. `mirror_subcommand` then hit
`os.path.exists(target_path)` with `target_path=None`, raising `TypeError` and crashing the
mirror run on real corpora containing any excluded-by-name file (research confirms `.gitignore`,
`__pycache__/*.pyc`, `*.bak-predensity` are present in the live 817-file corpus).

After (current, on `main`, lines ~314–330 of `plan_subcommand`):
```python
# Check exclusions — both dir_parts AND name_globs, mirroring the
# checks compute_target_path() applies (else a name_glob match returns
# target=None but was still recorded status="planned", which crashes
# mirror_subcommand on os.path.exists(None)).
source_basename = os.path.basename(source_path)
exclusion_reason = None
for part in dirmap["exclude"]["dir_parts"]:
    if part in source_path.split(os.sep):
        exclusion_reason = f"dir_part: {part}"
        break
if exclusion_reason is None:
    for glob in dirmap["exclude"]["name_globs"]:
        if source_basename.endswith(glob.replace("*", "")):
            exclusion_reason = f"name_glob: {glob}"
            break

if exclusion_reason is not None:
    manifest.append({..., "target": None, "status": "excluded", "reason": exclusion_reason, ...})
else:
    manifest.append({..., "target": target_path, "status": "planned", ...})
```
Now a `name_glob`-matched file gets `status="excluded"` with a `reason` string at plan time,
consistent with what `compute_target_path()` was already computing — no more
`status=planned, target=null` rows, no crash.

## File-by-file routing rules (from `dirmap.json`, unchanged by either fix)

First-match-wins over `<agent>/<relpath-within-deliverables>` prefixes:

| Source prefix | Content type | Target home |
|---|---|---|
| `auditmaster/{alloi,msia,studio-pch,rrk,ocg,logic-tcg}` | client | `raw/areas/clearworks/clients/<client>/<relpath>` |
| `auditmaster/talent-pipeline` | session | `raw/sessions/deliverables-mirror/auditmaster/talent-pipeline/<relpath>` |
| `auditmaster/{_design-language,_execution-layer,_sample-audit,teaching,skills,clearworks-assessment,cxportal}` | sop | `raw/resources/reference/clearworks/deliverables-mirror/auditmaster/<subtree>/<relpath>` |
| `auditmaster/` top-level, `.png`/`.svg` | diagram | `raw/areas/clearworks/diagrams/<basename>` (flattened — top-level diagram exception) |
| `auditmaster/` top-level, other | sop | `raw/resources/reference/clearworks/deliverables-mirror/auditmaster/<basename>` |
| `frank2/` | diagram | `raw/areas/clearworks/diagrams/deliverables-mirror/frank2/<relpath>` |
| `larry/` | session | `raw/sessions/deliverables-mirror/larry/<relpath>` |
| `pa/` | media | `raw/media/deliverables-mirror/pa/<relpath>` |
| `muse/` | sop | `raw/resources/reference/clearworks/deliverables-mirror/muse/<relpath>` |

Exclusions (either class marks a file `status="excluded"`, not routed): `dir_parts` =
`__pycache__`, `.git`; `name_globs` = `*.pyc`, `*.bak*`, `.gitignore`, `.DS_Store`. Any file
matching no rule at all causes `plan` to exit 1 listing unmapped paths — no silent default.

## Known unfixed edge case — `strip_provenance_frontmatter()` verify false positive

`verify_subcommand` calls `strip_provenance_frontmatter(target_bytes, MIRROR_JOB)` on every
`.md`/`.txt` `mirrored`/`skipped-identical` row and byte-compares the result against the raw
source bytes. `strip_provenance_frontmatter()` (mirror_deliverables.py, ~lines 238–287) strips
lines from the target's frontmatter block by **key-name match** against the fixed set
`{"agent", "job", "source-task", "date", "mirror-of"}` — it does not track which specific lines
`merge_frontmatter()` actually injected versus which were already present in the source file's
own frontmatter.

`merge_frontmatter()` (~lines 163–217) correctly implements "add key only if absent": if a source
file already has its own `date:` line in frontmatter, the merge step does **not** duplicate or
overwrite it, and the target ends up with exactly one `date:` line — the source's own,
pre-existing one. But `strip_provenance_frontmatter()`, working only from the target and matching
by key name, cannot distinguish that pre-existing `date:` line from a would-be injected one; it
strips it unconditionally because the key name matches. The stripped target then differs from the
raw, unstripped source bytes on that one line, and `verify` reports
`"provenance-stripped diff non-empty"` even though the merged file's actual content is correct
(the merge added zero bytes for that key). This produced 3 false-positive rows out of 817 in the
real execution — confirmed as this root cause, not data corruption. Fixing it would require
`merge_frontmatter()` to record which keys it actually added (e.g. a set of injected key names
persisted per-row in the manifest) so `strip_provenance_frontmatter()` strips only those, instead
of matching by fixed key-name across all five. Flagged as follow-up, not fixed in this pass.

## Out of scope (unchanged)

Agent write-path flip, `deliverables/` retirement/symlink, `dirmap.json` rule edits, ocg slug
consolidation, and fixing the `strip_provenance_frontmatter()` false-positive itself.
