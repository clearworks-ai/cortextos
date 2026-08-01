# Spec 01 — agent-memory mirror + nightly-reconcile integration (P1.5)

Buildable directly by codexer. Context: `../01-research.md`, `../02-master-plan.md`.
Design is DECIDED (mirror pattern — research proves literal root addition is a no-op and a
symlink oscillates; do not re-litigate, do not touch mmrag.py).

Working repo: `/Users/joshweiss/code/cortextos` (referred to as `<repo>`).
Source dir (READ-ONLY, harness-owned — never write/delete/rename anything in it):
`~/.claude/projects/-Users-joshweiss-code-cortextos/memory/`
Mirror dir (created by the script): `~/code/knowledge-sync/raw/areas/clearworks/agent-memory/`
knowledge-sync repo: write the mirrored FILES only — run NO git commands there, commit
NOTHING there.

## Evidence discipline (this spec's "tests")

Filesystem + shell change — no new unit-test framework. EVERY step has a verification
command; paste REAL output into the build notes / completion message. A step without
captured output is not done.

## Step 0 — branch + preflights

```bash
cd <repo> && git checkout main && git pull && git checkout -b feature/p1-5-agent-memory-index
```
Branch name must be exactly `feature/p1-5-agent-memory-index` (PR-gate: branch == slug).

Preflights (capture all outputs):
```bash
ls ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/*.md | wc -l   # expect ~743, MUST be > 0
ls -d ~/code/knowledge-sync/raw/areas/clearworks/agent-memory 2>&1          # expect: No such file (fresh dir)
find ~/code/knowledge-sync/raw ~/code/knowledge-sync/wiki -type l           # expect: EMPTY (no symlink already reaches the memory dir → no double-index)
grep -n '".claude"' <repo>/knowledge-base/scripts/mmrag.py | head -3        # confirm .claude still in IGNORE_DIR_PARTS (design premise)
```
If the symlink scan is non-empty and any link resolves into `~/.claude/`, STOP and report —
the double-index premise changed.

## Step 1 — mirror script (new file)

`<repo>/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh`, mode 755, bash, `set -u`.
Behavior (keep it ~40 lines, stdlib/rsync only, style-match `kb-reconcile-nightly.sh`):

1. `SRC="$HOME/.claude/projects/-Users-joshweiss-code-cortextos/memory"` ,
   `DST="$HOME/code/knowledge-sync/raw/areas/clearworks/agent-memory"`.
2. **Safety gate:** if `$SRC` is not a directory OR `find "$SRC" -maxdepth 1 -name '*.md' | wc -l`
   is 0 → print `{"error":"source missing or empty","exit":1}` and exit 1. (Never lets
   `--delete` run against a missing/empty source and wipe the mirror.)
3. `mkdir -p "$DST"`.
4. The mirror — top-level `*.md` ONLY, one-way, deletions propagate:
   ```bash
   rsync -a --delete --include='/*.md' --exclude='*' "$SRC/" "$DST/"
   ```
   The anchored `--include='/*.md'` + `--exclude='*'` combination transfers only top-level
   `.md` files and never descends into `handoffs/` or `memory-archive/`; `--delete` removes
   mirror files whose source was pruned/renamed. Do NOT add `--delete-excluded`,
   `--copy-links`, or recursion-widening filters. Capture rsync `--stats` or `-i` itemized
   output if useful, but the JSON below is the contract.
5. Emit ONE final JSON line on stdout (wrapper parses it):
   `{"mirrored": <files in DST after>, "deleted": <rsync deletions>, "source_count": <top-level *.md in SRC>, "exit": 0}`
   Computing `deleted` exactly from rsync output is optional — if fiddly, set it from
   `rsync -i` lines starting with `*deleting`; correctness bar is `mirrored == source_count`.
6. Exit 0 only if rsync exited 0 AND `mirrored == source_count`; otherwise exit 1 with
   `"exit": 1` in the JSON.

Idempotency requirement: second consecutive run transfers nothing and still exits 0 with the
same counts.

Evidence: script content, then
```bash
<repo>/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh          # run 1
<repo>/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh          # run 2 (idempotent)
ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory | wc -l        # == source_count
ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory | grep -c handoff   # MUST be 0
ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.json 2>&1    # MUST be no-match
diff <(ls ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/*.md | xargs -n1 basename) \
     <(ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.md | xargs -n1 basename)   # MUST be empty
```

## Step 2 — wrapper integration (surgical edit)

File: `<repo>/orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` (132 lines today).
Three additions, nothing else restructured:

1. **Step 0 block** before the existing reconcile step:
   ```bash
   # Step 0 — mirror agent-memory topic files into knowledge-sync (P1.5)
   MIRROR_OUT="$("$REPO/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh" 2>>/tmp/kb-reconcile-nightly.err)"
   MIRROR_STATUS=$?
   ```
   Mirror failure must NOT abort the wrapper (reconcile still runs; the red ledger row is
   the alarm — matches existing wrapper philosophy: `set -u`, no `set -e`).
2. **Ledger field:** pass `MIRROR_OUT`/`MIRROR_STATUS` into the existing embedded python
   (same env-var + argv pattern used for `RECON_OUT`/`RECON_STATUS`), parse the last JSON
   line with the same tolerant fallback-to-`{}` approach, and add to the composed row:
   ```python
   "memory_mirror": {"status": mirror_status, "mirrored": ..., "deleted": ..., "source_count": ...}
   ```
3. **Green computation:** extend the existing `green = (...)` with `mirror_status == 0`.

Evidence: `git diff orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` — the diff
must show ONLY these three additions.

## Step 3 — first reconcile run (proof of ingestion)

Run the full wrapper exactly as the cron does:
```bash
<repo>/orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
tail -1 <repo>/orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl
```
Expected in the new ledger row: `memory_mirror.status == 0`,
`reconcile.new_files` ≥ ~700 more than the previous row's steady state (the agent-memory
files are all new to the index), `green: true`. Note: reconcile embeds ~743 new files — allow
minutes, not seconds; the wrapper already handles long runs. Evidence: the full ledger row.

## Step 4 — index + retrieval post-checks (done-condition)

1. **Chunk count for memory paths > 0** (P1 done-block pattern). Locate the live db, then:
   ```bash
   source <repo>/orgs/clearworksai/secrets.env 2>/dev/null || true
   export MMRAG_DIR="$HOME/.cortextos/${CTX_INSTANCE_ID:-default}/orgs/clearworksai/knowledge-base"
   DB=$(find "$MMRAG_DIR" -name chroma.sqlite3 | head -1)
   sqlite3 "$DB" "SELECT COUNT(DISTINCT string_value) FROM embedding_metadata
                  WHERE key='source_file' AND string_value LIKE '%/raw/areas/clearworks/agent-memory/%';"
   ```
   Pass bar: > 0, expected ≈ mirrored file count. If the `embedding_metadata` table/key name
   differs in the live chroma schema, adapt the query to the actual schema (inspect with
   `.tables`/`.schema`) and record the adapted query — the CHECK is binding, the exact SQL is
   not. Fallback proof if sqlite is unworkable: `reconcile.new_files` delta from Step 3 plus
   check 2 below.
2. **kb-query cites a memory file.** Run both (memory-only facts):
   ```bash
   cortextos bus kb-query --org clearworksai "Why is UID a dangerous variable name in bash scripts?"
   cortextos bus kb-query --org clearworksai "What was the root cause of the duplicate Telegram back-ping messages?"
   ```
   Pass bar: at least one answer cites a `raw/areas/clearworks/agent-memory/...` source.
   (Exact flags: match how P1.1/P1.3 evidence invoked kb-query — read those evidence files
   if the CLI shape differs; do not invent flags.)
3. **Negative checks — no leakage, no double-index:**
   ```bash
   sqlite3 "$DB" "SELECT COUNT(*) FROM embedding_metadata WHERE key='source_file' AND string_value LIKE '%/.claude/%';"   # MUST be 0
   sqlite3 "$DB" "SELECT COUNT(*) FROM embedding_metadata WHERE key='source_file' AND string_value LIKE '%/agent-memory/handoffs/%';"   # MUST be 0
   ```
Evidence: all outputs. Save copies beside the P1.1/P1.3 evidence pattern under
`orgs/clearworksai/agents/larry/state/` (untracked is fine).

## Step 5 — frontmatter sanity (no changes expected — verify only)

Pick one mirrored file (e.g. `agent-memory/feedback_bash_reserved_uid_var.md`) and confirm
byte-identity with its source (`diff` empty) — the mirror is VERBATIM; no provenance
frontmatter merge is performed (decided in research: existing `name`/`description`/nested
`metadata:` frontmatter is compatible with mmrag's shallow parser as-is; `description`
becomes the doc summary). Evidence: the empty diff.

## Step 6 — commit + push branch (NOT main, NO PR)

```bash
git add orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh \
        orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
git commit -m "P1.5 agent-memory fold-in: mirror memory topic files into knowledge-sync + nightly ledger field"
git push -u origin feature/p1-5-agent-memory-index
```
Commit contents: exactly the two files. No knowledge-sync commit, no ledger/state files, no
mmrag.py. Evidence: `git show --stat HEAD`.
**Do NOT open the PR and do NOT merge** — return diff + all evidence to Larry for
adversarial review; Larry opens the PR (must state the "mirror instead of literal root"
divergence from the plan-line wording), Josh merges.

## Rollback

Revert the wrapper edit (or the merge), delete
`~/code/knowledge-sync/raw/areas/clearworks/agent-memory/`, re-run reconcile — stale chunks
purge as `missing_from_disk`. The live memory dir is never touched, so nothing else to
restore.

## Out of scope (do not build)

Any mmrag.py change (esp. `IGNORE_DIR_PARTS`/`_is_ignored`), any `DEFAULT_RECONCILE_ROOTS`
edit, any new cron/config.json change, `handoffs/` or `memory-archive/` ingestion, any
`.jsonl` read (binding P1.6 exclusion), other projects' memory dirs, claude-mem anything,
frontmatter rewriting, git operations inside knowledge-sync, writes to the source memory dir.
