# Shard 01 — Ingest ignore-filter

**Target file:** `~/code/cortextos/knowledge-base/scripts/mmrag.py` (git-tracked, live).
**Do NOT edit** the skill mirror at `~/.claude/skills/multimodal-rag/scripts/mmrag.py` — it is a separate, divergent copy that the bus does not execute.

## The defect

`cmd_ingest`, line **1091**:
```python
files = sorted(f for f in p.rglob("*") if f.is_file() and not f.name.startswith("."))
```
`rglob("*")` recurses into dot-directories. `not f.name.startswith(".")` only
rejects a file whose **own basename** is dotted (e.g. `.DS_Store`). A normal-named
file inside `.trash/`, `.obsidian/`, `.git/`, or `node_modules/` passes and gets
embedded. That is the pollution source.

## The change

1. Add a module-level constant near the existing extension sets (lines 39–43):
   ```python
   # Directory names whose entire subtree is excluded from ingest.
   IGNORE_DIR_PARTS = {
       ".trash", ".obsidian", ".git", ".cache", ".venv", "__pycache__",
       "node_modules", ".next", ".turbo", "dist", "build",
   }
   # File extensions never worth embedding (diagram XML, lockfiles, etc.).
   IGNORE_FILE_EXTS = {".drawio", ".lock", ".log", ".tmp"}
   ```
   Keep this list narrow and documented. **Do NOT** add any image/PDF/audio/video/
   DOCX extension here — multimodal content stays in (Josh's explicit instruction).

2. Add a small, pure helper (module scope, testable in isolation):
   ```python
   def _is_ignored(path: Path) -> bool:
       """True if any path component is an ignored dir, or the file ext is ignored.
       Pure and side-effect free so it can be unit-tested without a filesystem walk."""
       if any(part in IGNORE_DIR_PARTS for part in path.parts):
           return True
       if path.suffix.lower() in IGNORE_FILE_EXTS:
           return True
       return False
   ```

3. Rewrite the walk at line 1091 to use it, and count what the filter drops so the
   ingest summary is honest (no silent truncation):
   ```python
   all_files = sorted(f for f in p.rglob("*") if f.is_file() and not f.name.startswith("."))
   files = [f for f in all_files if not _is_ignored(f)]
   filtered_out = len(all_files) - len(files)
   print(f"Ingesting directory: {p} ({len(files)} files, {filtered_out} skipped by ignore-filter)")
   ```
   (Replace the existing `print(f"Ingesting directory: ...")` on line 1092 — do not
   leave a duplicate.)

## Constraints

- Behavior for a single explicit file path (`p.is_file()` branch, ~line 1100+)
  stays unchanged — the filter applies to **directory recursion** only. If Josh
  ingests one `.drawio` by explicit path, that is his call; we only stop blind
  subtree pollution.
- No new imports beyond `pathlib.Path` (already imported).
- No `print`-debug left in; match surrounding style.

## Unit test

Place in the **existing** mmrag test location — codexer: run
`find ~/code/cortextos -path '*knowledge-base*' -name 'test_*.py' -o -name '*_test.py'`
and the `_test_clients/` dir to find where mmrag tests live; extend there. If no
test module exists yet, create `knowledge-base/scripts/test_mmrag_filter.py` as a
plain `pytest` module (the repo already uses pytest-style fault-injection clients).

Test `_is_ignored` directly (no filesystem needed) and the walk on a tmp tree:
- `tmp/.trash/old.md` → ignored
- `tmp/.obsidian/workspace.json` → ignored
- `tmp/node_modules/pkg/index.js` → ignored
- `tmp/diagram.drawio` → ignored
- `tmp/note.md` → kept
- `tmp/pic.png` → kept (multimodal stays)
- `tmp/sub/deep.md` → kept

Assert the kept set is exactly `{note.md, pic.png, sub/deep.md}` and the skipped
count is 4.

## Acceptance

- `python3 -m py_compile knowledge-base/scripts/mmrag.py` clean.
- New filter test passes.
- Diff is confined to the constant block, the helper, and the walk lines.
