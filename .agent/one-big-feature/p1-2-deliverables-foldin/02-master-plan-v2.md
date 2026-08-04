# P1.2 — Deliverables fold-in — Master Plan v2 (condensed, post-execution)

Supersedes `02-master-plan.md` for provenance purposes only — that document's phase design was
correct and is not being redesigned here. This v2 condenses the plan and adds what actually
happened: two real bugs found in the shipped tool, fixed via merged PRs, and the real execution
outcome against the live corpus. Sources: `01-research.md`, `02-master-plan.md`,
`03-specs/01-mirror-tool-spec.md`, `orgs/clearworksai/skills/outputs-router/mirror_deliverables.py`
(current, on `main`), and `git log` on that file (commits `bbcd416`, `9666c14`).

## Scope

Bulk, additive mirror of all `orgs/clearworksai/agents/*/deliverables/` files (817 at plan time,
across auditmaster/pa/larry/frank2/muse) into their content-type homes under the knowledge-sync
`raw/` taxonomy, in D4 "mirror-then-migrate" order per `MASTER-BUILD-PLAN.md` line 97: mirror
first (additive, zero-risk, provenance frontmatter added at mirror time, source→target manifest
emitted), add to ingest roots (a no-op — mirror targets already sit under mmrag's existing
`DEFAULT_RECONCILE_ROOTS`), then — only after 7 green kb-reconcile-nightly days — flip agents to
write via the P1.0 helper directly and retire/symlink `deliverables/`. That flip, the retirement,
and any `dirmap.json` rule edits are explicitly out of scope for this build; they are gated,
future work.

## Tool design

`mirror_deliverables.py` (stdlib-only Python, sibling to P1.0's `file_output.py` in
`orgs/clearworksai/skills/outputs-router/`) has three subcommands:
- `plan` — walks the five `DELIVERABLES_ROOTS`, applies `dirmap.json` rules (first-match-wins by
  `<agent>/<relpath>` prefix, `client`/`sop`/`session`/`media`/`diagram` content types), and emits
  a JSONL manifest with one row per source file (`planned` or `excluded`), sha256, and computed
  target path. Fails loudly (exit 1) on any unmapped path.
- `mirror` — dry-run by default; `--execute` writes. Copies with `shutil.copy2`. For `.md`/`.txt`
  targets it MERGES provenance frontmatter (adds `agent/job/source-task/date/mirror-of` keys only
  if absent, never double-prepends) rather than reusing P1.0's blind-prepend
  `inject_frontmatter()`. For all other extensions it copies bytes untouched and writes a
  `<target>.provenance.md` sidecar via P1.0's `create_provenance_sidecar()`. Never overwrites: an
  existing identical target is `skipped-identical`, an existing different target is `conflict`
  (nothing written).
- `verify` — exit 0 iff manifest row count ≥ live recount of the deliverables roots AND every
  `mirrored`/`skipped-identical` row diffs empty (md/txt compared after stripping exactly the
  injected provenance keys; other types byte-compared plus sidecar-existence check) AND zero
  `conflict`/`planned` rows remain.

Reuses P1.0's `CONTENT_TYPE_MAPPING` and `create_provenance_sidecar()` by import; does not modify
`file_output.py`.

## Two bugs found and fixed (both merged to `main`)

1. **REPO_ROOT off-by-one — PR #248 (commit `9666c14`).** `REPO_ROOT` is derived from `__file__`
   by walking up from `orgs/clearworksai/skills/outputs-router/` to the repo root — that path is
   4 directories up (`outputs-router → skills → clearworksai → orgs → repo root`), not 3. The
   original code used 3 `".."` hops, resolving one level too shallow. Real effect: every entry in
   `DELIVERABLES_ROOTS` pointed at a nonexistent directory, so `plan_subcommand`'s
   `os.path.exists(root)` check silently skipped all five agent roots — the tool produced an
   empty, successful-looking manifest (0 rows) instead of erroring, which would have masked total
   failure as success.
2. **`plan_subcommand` exclusion check gap — PR #250 (commit `bbcd416`).** `plan_subcommand`
   originally only checked `dirmap["exclude"]["dir_parts"]` before deciding a matched file was
   `planned`; it never checked `dirmap["exclude"]["name_globs"]` (`*.pyc`, `*.bak*`, `.gitignore`,
   `.DS_Store`) at that stage, even though `compute_target_path()` did check both and would
   return `target=None` for a name_glob match. Real effect: files like a stray `.gitignore` under
   a deliverables subtree got a self-contradictory row — `status=planned, target=None` — which
   later crashed `mirror_subcommand` on `os.path.exists(None)`. Fixed by checking both
   `dir_parts` and `name_globs` in `plan_subcommand` itself, so excluded files get
   `status=excluded` with a reason at plan time, matching what `compute_target_path()` already
   computed.

## Real execution outcome (this session, live corpus)

`plan` → 817 files planned, 3 excluded (820 total under the five deliverables roots, matching an
independently-verified live `find` count). `mirror --execute` → 817/817 mirrored, 0 errors, 0
conflicts. A subsequent `verify` run flagged 3/817 rows as "provenance-stripped diff non-empty."
Investigated and confirmed a false positive in `strip_provenance_frontmatter()`: it strips lines
by key-name match across the five injected keys rather than tracking which lines it actually
injected, so a source file whose own pre-existing frontmatter already contained a `date:` key
(correctly left untouched by `merge_frontmatter()`, per the "add key only if absent" rule) gets
that pre-existing line incorrectly stripped from the target during the verify diff, producing a
spurious mismatch even though the mirrored file content is byte-correct. This is a known,
non-blocking edge case in the verify tool's diff logic — not data corruption — and is flagged as
follow-up, not fixed in this pass.

## Explicitly out of scope (unchanged from original plan)

Agent write-path flip to the P1.0 helper (gated on 7 green kb-reconcile-nightly days),
`deliverables/` retirement/symlinking, any `dirmap.json` rule edits, and fixing the
`strip_provenance_frontmatter()` verify false-positive itself.
