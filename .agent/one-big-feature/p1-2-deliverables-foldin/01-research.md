# P1.2 — Deliverables fold-in — Research

Source of truth (binding): `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`
line 97 (P1.2 row), line 95 (P1.0 routing pick), lines 108–113 (P1 done-conditions).
Execution order = D4 (mirror-then-migrate) — **DECIDED, accepted as written**.

## Binding scope (verbatim, MASTER-BUILD-PLAN.md line 97)

> The P1.0 content-type router applied in mirror-then-migrate order (D4 semantics): MIRROR each
> of the 812 files into its content-type home in the knowledge-sync taxonomy (additive, zero-risk;
> provenance frontmatter added at mirror time; router emits a source→target manifest) → add to
> ingest roots → after 7 green days (checked by 1.1's nightly counts rows), flip agents to write
> via the P1.0 helper directly; deliverables/ becomes symlink or retires.

Machine-checkable done-condition (line ~109):
> router mirror manifest (source→target pairs) row count ≥ deliverables count at mirror time;
> per-pair `diff` mirror vs source = empty.

## 1. Where the "812" files actually live (verified 2026-07-31)

Five per-agent `deliverables/` dirs under `orgs/clearworksai/agents/*/deliverables/`.
**Live count today = 817 files** (plan's 812 has drifted +5 — expected; the done-condition is
explicitly "≥ deliverables count **at mirror time**", so the tool must recount at run time,
never hardcode 812).

| Agent dir | Files | Size | Shape |
|---|---|---|---|
| auditmaster | 747 | 337 MB | 6 client subtrees + 9 internal subtrees + 11 top-level files |
| pa | 43 | 16 MB | one project (`led-sign/`) — image/build artifacts |
| larry | 16 | 3.4 MB | 5 project subtrees + 1 html — internal eng build outputs |
| frank2 | 10 | 6.3 MB | `clearworks-system-v5..v9.{html,png}` — system diagrams |
| muse | 1 | 4 KB | `aia-aec-deck-2026-07-20.md` |
| **Total** | **817** | **~363 MB** | |

auditmaster breakdown (the bulk):
- **Client subtrees (615 files):** alloi 272, msia 97, studio-pch 97, ocg 74, rrk 39, logic-tcg 36.
  Each has nested structure (e.g. `alloi/transcripts/`, `ocg/mockups/`, `logic-tcg/md/`).
- **Internal subtrees (121):** `_sample-audit` 38, `talent-pipeline` 37 (dist/packaged/forks —
  build artifacts), `_design-language` 16, `teaching` 10, `skills` 9, `_execution-layer` 6,
  `cxportal` 3, `clearworks-assessment` 2, `_engine` 0 (empty dirs only).
- **Top-level (11):** knowledge-architecture diagrams (png/svg pairs) + 3 md docs.

File types: 360 md, 163 png, 81 jpg, 52 pdf, 42 svg, 32 html, 20 py, 18 txt, 17 json, 8 pbm,
6 docx, 5 rtf, 3 .skill, plus junk (2 `.pyc` under `__pycache__`, 1 `.bak-predensity`,
1 `.gitignore`, 1 `.bin`).

**34 basename collisions** exist across directories — a flatten-to-basename copy (what P1.0
does) cannot work for the bulk mirror. The mirror must preserve relative paths per subtree.

## 2. The P1.0 router as it actually shipped (PR #187)

Location: `orgs/clearworksai/skills/outputs-router/` — `SKILL.md` + `file_output.py` (125 lines,
stdlib-only Python). CLI-only interface, no library API, but module constants/functions are
importable:

```bash
python3 orgs/clearworksai/skills/outputs-router/file_output.py \
  --content-type {client|people|org|sop|diagram|session|media} \
  --source <path> --agent <name> --job <name> --source-task <id> --date <ISO> [--client <slug>]
# prints the destination path on success
```

Behavior (from code, not SKILL.md prose):
- `CONTENT_TYPE_MAPPING` (module constant, importable): client→`raw/areas/clearworks/<client>/`,
  people→`raw/resources/people/`, org→`raw/resources/organizations/`,
  sop→`raw/resources/reference/clearworks/`, diagram→`raw/areas/clearworks/diagrams/`,
  session→`raw/sessions/`, media→`raw/media/`. Base = `~/code/knowledge-sync/`.
- Destination = `<mapped dir>/<basename(source)>` — **flattens**, no relpath support.
- **Hard exit(1) if destination exists** — safe for single filings, unusable naively for 817
  files with 34 basename collisions.
- Frontmatter: for `.md`/`.txt` it **blindly prepends** a `---agent/job/source-task/date---`
  block (SKILL.md says "injected or merged" but `inject_frontmatter()` at file_output.py:74-85
  does no merge — a file that already has YAML frontmatter ends up with two `---` blocks).
  Many deliverables mds already carry frontmatter → the mirror needs a real merge.
- Non-text files get a `<name>.provenance.md` sidecar (`create_provenance_sidecar()`, :88-98).
- `inject_frontmatter(file_path, args)` / `create_provenance_sidecar(file_path, args)` only
  need `.agent/.job/.source_task/.date` attributes on `args` — a `SimpleNamespace` works, so the
  mirror tool can **import and reuse** without modifying P1.0.

**Conclusion:** the mirror tool is a sibling script in the same skill dir that imports
`CONTENT_TYPE_MAPPING` + the frontmatter format from `file_output.py` (semantic reuse of the
router), and adds what the bulk case needs: relpath preservation, manifest, merge-not-prepend,
collision policy, dry-run, verify.

## 3. Content-type classification of the 817

Deterministic per-subtree defaults (encoded in a reviewable `dirmap.json`, not hardcoded):

| Source subtree | Type | Target home |
|---|---|---|
| auditmaster/{alloi,msia,studio-pch,rrk,ocg,logic-tcg} | client | client home `<slug>/` (see flag below) |
| auditmaster/{_design-language,_execution-layer,_sample-audit,teaching,skills,clearworks-assessment,cxportal} | sop | `raw/resources/reference/clearworks/deliverables-mirror/auditmaster/<subtree>/` |
| auditmaster/talent-pipeline | session | `raw/sessions/deliverables-mirror/auditmaster/talent-pipeline/` |
| auditmaster top-level png/svg | diagram | `raw/areas/clearworks/diagrams/` |
| auditmaster top-level md | sop | reference home |
| frank2 (system diagrams html+png) | diagram | `raw/areas/clearworks/diagrams/` |
| larry/* | session | `raw/sessions/deliverables-mirror/larry/<relpath>` |
| pa/led-sign | media | `raw/media/deliverables-mirror/pa/led-sign/` |
| muse/aia-aec-deck-2026-07-20.md | sop | reference home |

Junk excluded with a manifest row + reason (still counted toward "row count ≥ deliverables
count"): `__pycache__/*.pyc` (2), `*.bak-predensity` (1), `.gitignore` (1). Exclusion classes
align with mmrag's own `IGNORE_DIR_PARTS` (includes `__pycache__`) and `IGNORE_FILE_EXTS`
(mmrag.py:69-76) — mmrag would skip them at ingest anyway.

### ⚠ Open flag — client home: `clients/<slug>/` vs top-level `<slug>/`

P1.0's binding pick (plan line 95) and the shipped router both say client →
`raw/areas/clearworks/<client>/`. But the **existing taxonomy on disk** keeps clients under
`raw/areas/clearworks/clients/<slug>/` — and `clients/{alloi,msia,studio-pch,rrk,ocg-capital,
ocg-properties}` already exist with content (3–22 files each). Mirroring to top-level `<slug>/`
creates a second home per client; mirroring to `clients/<slug>/` deviates from the shipped
router mapping. **Recommendation: mirror to `clients/<slug>/` — the plan's own P1.0 text says
"into the EXISTING knowledge-sync taxonomy", and the existing taxonomy's client home is
`clients/`.** This is a one-line `dirmap.json` value reviewed at the manifest gate, so flipping
it costs nothing. Related: `deliverables/ocg` vs existing `ocg-capital`/`ocg-properties` split —
default to `clients/ocg/` (slug as-is, deterministic); consolidation is a later taxonomy task,
not a mirror-time guess. P1.0's `CONTENT_TYPE_MAPPING` alignment (clients/ prefix) is a
follow-up flag for Josh, out of P1.2 scope.

## 4. Ingest roots — the "add to ingest roots" step is a no-op

`DEFAULT_RECONCILE_ROOTS` (knowledge-base/scripts/mmrag.py:135-139) = knowledge-sync `wiki/`,
knowledge-sync **`raw/`**, `orgs/clearworksai/knowledge/`. Every mirror target above is under
`knowledge-sync/raw/` → mirrored files are **already inside the ingest roots**. No mmrag change,
no config change. The P1.1 nightly cron (kb-reconcile-nightly, PR #188; wrapper
`orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`; ledger
`orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`) picks them up on its next run.
Verification = next counts row shows raw distinct-file count increased by ≈ mirrored-row count.

All mirrored extensions except `.pbm`, `.rtf`, `.skill`, `.bin` are in mmrag `SUPPORTED_EXTS`
(mmrag.py:60-67) — those 17 files mirror fine but won't index; note in manifest, not a blocker.

## 5. Diff-verify vs frontmatter injection — the contradiction, resolved

Done-condition says "per-pair `diff` mirror vs source = empty", but the scope also says
"provenance frontmatter added at mirror time" — a literal diff on md/txt can never be empty.
Resolution (codified in the verify subcommand): for `.md`/`.txt`, strip exactly the injected
provenance keys from the mirror copy and byte-compare the remainder against the source; for all
other types the file is untouched (provenance lives in the sidecar) so plain `cmp` applies.
"Empty diff" = empty **after removing only what the tool itself added** — the strongest check
that is consistent with both clauses.

## 6. Risks / constraints

- **363 MB into knowledge-sync git** — mostly images/PDFs. Acceptable per C4 (knowledge-sync =
  THE files home) but the mirror commit will be large; commit in one PR, note size.
- **Collisions with pre-existing taxonomy files** (e.g. `clients/msia/` already has 12 files):
  never overwrite — identical → `skipped-identical`; different → `conflict` row, file written
  nowhere, verify fails loudly listing conflicts. Zero-risk means zero overwrites, period.
- **Source dirs are live** — agents still write to deliverables/ until the (out-of-scope) flip.
  Count and manifest are point-in-time; re-running `plan`+`mirror` later is idempotent and picks
  up new files (statuses: `mirrored` / `skipped-identical`).
- **Rollback** = the manifest is the undo log: delete every `target` with status `mirrored`.
  No staging env applies (file copies, additive, no prod data mutated) — but dry-run is the
  default and `--execute` is required to write, honoring the same spirit.

## 7. Explicitly OUT of P1.2-build scope

- Flip agents to write via the P1.0 helper directly (gated on 7 green kb-reconcile-ledger days).
- `deliverables/` → symlink or retire.
- P1.0 `CONTENT_TYPE_MAPPING` clients/-prefix alignment (flagged above, separate one-liner).
- ocg / ocg-capital / ocg-properties slug consolidation.
