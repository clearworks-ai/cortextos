# Spec 01 — Re-verify outputs-router: add committed test coverage for file_output.py

## Objective

`orgs/clearworksai/skills/outputs-router/file_output.py` is already shipped, merged, and stable in
production (PR #187 / `0fb86f6`, path-traversal fix folded in from `13695fa`). This spec does
**not** change its behavior. It defines the test cases a later build stage must implement in a new
file, `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py`, to close the one real
gap found by this session's adversarial re-verification (`04-review.md`): `tests/` currently
contains only `test_mirror_deliverables.py` (coverage for a different tool, P1.2's
`mirror_deliverables.py`), so the claim "unit test suite passes" has never been substantiated for
`file_output.py` — no such suite has ever existed in this repo's git history.

## Owned files (build stage only — not written by this planning pass)

- `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py` (new file)

## Files read but not edited

- `orgs/clearworksai/skills/outputs-router/file_output.py` (145 lines — the file under test; do
  not modify)
- `orgs/clearworksai/skills/outputs-router/tests/test_mirror_deliverables.py` (existing sibling
  test file — follow its structural conventions, e.g. pytest style, fixtures, imports, if it
  establishes a house style worth matching; do not modify it)

## Hard constraint: do not touch production data or `file_output.py`

`file_output.py`'s module-level constants are computed at import time from the real filesystem:

```python
KNOWLEDGE_SYNC_BASE = os.path.expanduser("~/code/knowledge-sync/")
CONTENT_TYPE_MAPPING = {
    "client": os.path.join(KNOWLEDGE_SYNC_BASE, "raw/areas/clearworks/"),
    ...
}
```

`parse_arguments()` reads `sys.argv` directly via `argparse`. The test suite must **never** write
into the real `~/code/knowledge-sync` tree, and must **never** shell out against the real,
production-path routing table. Required approach:

1. Import `file_output` as a module (`import file_output` or equivalent, adding the skill dir to
   `sys.path` if needed — follow whatever import mechanism `test_mirror_deliverables.py` already
   uses, for consistency).
2. In each test (or via a fixture), **monkeypatch the module-level `CONTENT_TYPE_MAPPING` dict**
   (e.g. `monkeypatch.setattr(file_output, "CONTENT_TYPE_MAPPING", {...})`) to point every
   content-type key at subdirectories under pytest's `tmp_path` fixture, not at the real
   `~/code/knowledge-sync` paths. Do this fresh per test (or per fixture) so tests don't leak state
   into each other.
3. Construct inputs to `validate_arguments()` / `get_destination_path()` / `main()`'s internals
   directly as `argparse.Namespace(...)` objects (e.g.
   `argparse.Namespace(content_type="sop", source=str(src), agent="test-agent", job="test-job",
   source_task="test-task", date="2026-08-03", client=None)`), rather than shelling out to
   `python3 file_output.py ...` as a subprocess against real paths. This is the only viable way to
   exercise the real routing/validation/frontmatter logic while keeping all I/O confined to
   `tmp_path`.
   - Alternative (acceptable if it better matches the existing test file's style): monkeypatch
     `sys.argv` to a synthetic argv list and call `file_output.parse_arguments()` directly to
     obtain the `Namespace`, then proceed as above. Either construction method is fine as long as
     no real filesystem path outside `tmp_path` is ever touched.
4. Do not monkeypatch or bypass `validate_arguments()`'s traversal checks or
   `get_destination_path()`'s `commonpath` backstop — those are exactly what several test cases
   below must exercise for real.

## Test cases (minimum required coverage)

All test cases operate against a `tmp_path`-rooted `CONTENT_TYPE_MAPPING` per the constraint above.
Each source file used as input should itself be created under `tmp_path` (a sibling scratch
location, not inside any of the routed destination dirs).

1. **SOP branch, `.md`, successful write.**
   Create a scratch `notes.md` under `tmp_path` with arbitrary body text. Call the filing flow
   with `content_type="sop"` (no `client` needed). Assert:
   - Exit/return indicates success (no `SystemExit`, or `SystemExit` not raised / code 0,
     depending on how the test invokes `main()` vs. calling the internal functions directly).
   - The destination file exists at the expected path (`<mocked sop dir>/notes.md`).
   - The destination file's content starts with a well-formed YAML frontmatter block containing
     exactly `agent:`, `job:`, `source-task:`, `date:` with the values passed in, followed by the
     original body text unchanged.

2. **Binary branch, sidecar provenance file.**
   Create a scratch binary file under `tmp_path` (e.g. a `.png` or arbitrary `.bin` file — real
   non-text bytes, not something coercible to UTF-8 text) with known byte content. Route it through
   any content type (e.g. `media`). Assert:
   - The destination binary file exists and its bytes are **byte-for-byte identical** to the
     source (confirms `shutil.copy2` copied without corruption and frontmatter injection did not
     touch it).
   - A sidecar file `<dest_path>.provenance.md` exists alongside it.
   - The sidecar's content is exactly the frontmatter block (`agent:`, `job:`, `source-task:`,
     `date:`) with the values passed in, and nothing else.
   - The original source file (outside the destination dir) is untouched/still present (copy, not
     move).

3. **Missing `--client` when `content_type="client"` → refusal.**
   Call with `content_type="client"` and `client=None` (or omitted). Assert:
   - The call exits non-zero (e.g. `pytest.raises(SystemExit)` with `.value.code != 0`, matching
     how `validate_arguments()` calls `sys.exit(1)`).
   - No traceback / unhandled exception — only the intentional `sys.exit(1)` path via the
     `Error: --client missing when --content-type=client` message on stderr (capture via
     `capsys` and assert the one-line message, or at minimum assert clean `SystemExit(1)` with no
     other exception type).

4. **Duplicate destination → refusal, no silent overwrite.**
   Run the SOP-branch-style successful write once (per case 1) so a destination file already
   exists at the computed path. Run the identical filing operation a second time with the same
   inputs. Assert:
   - Second call raises `SystemExit` with non-zero code (matching `main()`'s
     `if os.path.exists(dest_path): ... sys.exit(1)` guard).
   - The original destination file's content is unchanged after the second (refused) attempt —
     confirms no silent overwrite occurred.

5. **`--client` path-traversal payloads — all rejected.**
   Parametrize (or write three discrete tests) over:
   - An absolute path value, e.g. `/etc/passwd` or `/tmp/evil`.
   - A value containing a `..` component, e.g. `../../etc`.
   - A value with an embedded path separator, e.g. `foo/bar` (and, if feasible in the test
     environment, `foo\\bar` for `os.altsep` coverage — only if meaningful on the test platform).
   For each, call with `content_type="client"` and the payload as `client`. Assert each raises
   `SystemExit` with non-zero code via `validate_arguments()`'s sanitization checks (lines
   62–71 of `file_output.py`), and that no destination file is created anywhere (in particular,
   confirm nothing is written outside the mocked `tmp_path` mapping — a targeted assertion that
   e.g. `/etc/passwd` was not modified is unnecessary/unsafe to attempt for real; it is sufficient
   to assert the early non-zero exit prevented `get_destination_path()`/`main()`'s write path from
   ever running, e.g. via a spy/monkeypatch on `shutil.copy2` asserting it was never called for
   the traversal cases).

6. **Legitimate flat `--client` slug → succeeds at the exact expected path.**
   Call with `content_type="client"`, `client="acme-co"` (a plain flat slug, no separators). Assert:
   - Call succeeds (no `SystemExit`, or exit 0).
   - Destination path is exactly `<mocked client base dir>/acme-co/<source basename>` — assert the
     literal computed path, not just "no error," to pin the routing contract
     (`get_destination_path()`'s `dest_dir = os.path.join(base_dest, args.client)` behavior for
     the `client` content type).

## Test infrastructure notes

- Use `pytest` (already the suite's framework, per `test_mirror_deliverables.py`) and the built-in
  `tmp_path` / `monkeypatch` fixtures — no new third-party test dependency.
- Keep the `CONTENT_TYPE_MAPPING` monkeypatch fixture reusable across test cases (e.g. a shared
  `pytest.fixture` that builds a fresh dict of `tmp_path` subdirectories per test) to avoid
  duplication and avoid any cross-test path leakage.
- Every test must be fully hermetic: no network, no dependency on real `~/code/knowledge-sync`
  contents or existence, no ordering dependency between tests (each must pass in isolation and in
  any run order).

## Non-goals for this spec

- Does not require (and must not add) any change to `file_output.py` itself.
- Does not need to test `SKILL.md` or the knowledge-sync convention doc (not code, not testable by
  pytest, out of scope).
- Does not need to cover `mirror_deliverables.py` (already covered by
  `test_mirror_deliverables.py`, a separate tool, separate spec history).
- Does not need to add regression coverage for the known, separately-tracked
  `os.path.realpath()` symlink gap (`p1-0-outputs-router-hardening` branch) — that is a distinct,
  out-of-scope hardening question, not part of closing this test-coverage gap. If the build stage
  wants to add a symlink-specific test anyway as a documented "expected to currently pass because
  no symlink is involved" case, that is acceptable but not required by this spec.

## Validation requirements (for the later build/true-verify stage, not this planning pass)

- `pytest orgs/clearworksai/skills/outputs-router/tests/test_file_output.py -v` must show all
  cases above passing (at minimum 6 test functions, more if payload cases 5 are split into
  separate parametrized cases).
- Running the full existing suite, `pytest orgs/clearworksai/skills/outputs-router/tests/ -v`,
  must continue to show `test_mirror_deliverables.py`'s existing tests passing unchanged (proves
  the new file is additive, not disruptive).
- Confirm no test run wrote, modified, or deleted anything under the real
  `~/code/knowledge-sync` tree (spot-check via `git status` / directory listing in that sibling
  repo before and after the run being identical).
- `file_output.py` itself must show zero diff (`git diff --stat orgs/clearworksai/skills/outputs-router/file_output.py`
  empty) before and after this pass.

## Handoff requirements

Standard OBF handoff for the build stage: files changed (should be exactly the one new test file),
`pytest -v` output pasted in full, confirmation `file_output.py` has zero diff, branch name equal
to the OBF slug (`wave-b-p1-0-outputs-router`, no prefix), PR opened against
`clearworks-ai/cortextos`, Josh approves merge — never push to main directly.
