# Review — Spec 01: Outputs Router Skill + Helper (P1.0)

**Method:** Static review only — read spec, diff, and on-disk files (`file_output.py`, `SKILL.md`,
convention doc). Did not execute the script. Diff (`04-implement.diff`) was diffed conceptually
against on-disk state and matches exactly (no drift between committed diff and working tree).

## Verdict: PASS-WITH-NOTES

Core CLI contract (flags, routing table, copy-never-move, frontmatter/sidecar split, stdlib-only)
is implemented correctly and the three owned artifacts all exist at their exact spec'd paths. Found
one real security gap (`--client` path traversal / absolute-path override), one explicit spec-text
gap (frontmatter "merge" not implemented, injection only), one error-path polish gap (unknown
`--content-type` isn't a clean one-liner), and one style-precedent deviation (SKILL.md missing the
YAML frontmatter header the spec told it to copy). None of these corrupt data in the documented
happy-path or 2 documented error-path checks; they're real but non-blocking for a P1.0 first cut.

## Findings

1. **[Security] `--client` value is not sanitized against path traversal / absolute-path override**
   — `file_output.py:65-66`:
   ```python
   if args.content_type == "client":
       dest_dir = os.path.join(base_dest, args.client)
   ```
   `os.path.join` discards all prior components when a later component is itself absolute. So
   `--client /etc/cron.d` (or any value starting with `/`) makes `dest_dir` become `/etc/cron.d` —
   completely escaping `knowledge-sync/raw/areas/clearworks/`. A relative value containing `..`
   segments (`--client ../../../etc`) also escapes the intended tree since neither `--client` nor
   the joined path is validated or normalized/contained anywhere in `get_destination_path` (line
   63-71) or `main()`. `--source`'s basename is correctly stripped via `os.path.basename` (line 70)
   so that vector is safe, but `--client` has no equivalent guard. Not one of the spec's four listed
   error conditions, so not a contract violation per se, but it is a genuine security gap the task
   asked to check for, and worth a follow-up fix (reject `--client` values containing `/` or `..`).

2. **[Spec conformance] Frontmatter is injected, never merged** — spec line 46-47: *"Frontmatter
   (...): for .md/.txt sources, inject/merge a YAML frontmatter block in the filed copy."*
   `inject_frontmatter()` (`file_output.py:74-85`) unconditionally prepends a fresh `---...---`
   block regardless of whether the source file already begins with its own frontmatter block. If a
   source `.md` already has frontmatter, the result is two adjacent `---` blocks, which most YAML
   frontmatter parsers (front-matter libs, Jekyll-style, Obsidian) will mis-parse (either reading
   only the first block and treating the second as body content with literal `---` fences, or
   erroring). The spec's own word "merge" implies detecting and combining with existing frontmatter;
   that logic doesn't exist. Low likelihood in the P1.0 scratch-file dry run (spec's own test file
   has no pre-existing frontmatter) but real for any agent filing an already-frontmattered doc.

3. **[Spec conformance, minor] Unknown `--content-type` doesn't produce a "clear one-line stderr
   message"** — spec line 51-55 requires all four error conditions to "Exit non-zero with a clear
   one-line stderr message (no traceback)". Three of the four (`--client` missing, source missing,
   destination exists) have hand-written one-line messages (`file_output.py:55`, `:59`, `:109`).
   The fourth — unknown `--content-type` — is delegated entirely to argparse's `choices=` mechanism
   (`file_output.py:29`), which on an invalid value prints a multi-line `usage: ...` block plus a
   separate `error: argument --content-type: invalid choice: ...` line, and exits with code `2`
   (not the `1` used everywhere else in the script). This satisfies "non-zero" and "no traceback"
   but not "one-line" or consistent exit-code behavior with the other three conditions.

4. **[Spec-precedent deviation] `SKILL.md` has no YAML frontmatter header** — spec step 1
   (line 69-72) explicitly names `orgs/clearworksai/skills/knowledge-base/SKILL.md` as the "style
   precedent" including its "frontmatter block". `knowledge-base/SKILL.md` opens with a `---\nname:
   knowledge-base\ndescription: "..."\n---` header used by the skill registry/picker. The shipped
   `orgs/clearworksai/skills/outputs-router/SKILL.md` has no such header — it opens directly with
   `# Outputs Router Skill` (`SKILL.md:1`). Checked the sibling skill dirs on disk: 5 of 7 org
   skills have the `name:`/`description:` frontmatter (`knowledge-base`, `meeting-intelligence-
   engineer`, `followup-coordinator`, `skilltree-audit`, `the-humanizer`); 2 do not
   (`outputs-router`, `proof-editor`). So this isn't a universal hard rule in this repo, but it is a
   direct deviation from the specific precedent the spec named, and `outputs-router` does not
   currently appear in the invokable skills list surfaced to agents (consistent with — though not
   conclusively caused by — the missing header). Worth adding for consistency and to make the skill
   discoverable via the picker rather than by direct-path invocation only.

5. **[Minor robustness] Provenance sidecar write has no overwrite guard** — `main()` only checks
   `os.path.exists(dest_path)` for the primary artifact (`file_output.py:108-110`) before writing.
   `create_provenance_sidecar()` (`:88-98`) opens `<dest>.provenance.md` in `"w"` mode unconditionally
   — if a stale sidecar from a prior run already exists at that path (e.g. dest file was deleted out
   of band but its sidecar wasn't), it is silently clobbered. This is outside the spec's four listed
   conditions but arguably contradicts the stated design principle "never silently overwrite" applied
   inconsistently between the two write paths.

6. **[Nit] Unused import** — `from datetime import datetime` (`file_output.py:5`) is never
   referenced; `--date` is passed through as a plain string, correctly per spec (script must not call
   the system clock). Dead import only, no functional effect.

## Explicit contract checklist

- **CLI flags** (`--content-type`, `--source`, `--agent`, `--job`, `--source-task`, `--date`,
  `--client`): all present, matching names/semantics, `--client` optional — **confirmed** (
  `file_output.py:22-50`).
- **Content-type → destination mapping** (7 types, exact paths incl. `sop` landing one level above
  `all-docs/`): matches spec table exactly, and matches both `SKILL.md` and the knowledge-sync
  convention doc's routing tables verbatim — **confirmed** (`file_output.py:11-19`; convention doc
  lines 9-19; `SKILL.md` lines 21-29).
- **4 error conditions exit non-zero, no traceback**: all four do exit non-zero with no Python
  traceback — **confirmed**, but see Finding 3 for the "one-line" / exit-code-1-vs-2 inconsistency
  on the unknown-`--content-type` path.
- **Frontmatter injection for `.md`/`.txt`, sidecar `.provenance.md` for everything else**: branch
  logic on `file_ext in [".md", ".txt"]` is correct and matches spec — **confirmed** (
  `file_output.py:115-119`); the "merge" half of "inject/merge" is not implemented — see Finding 2.
- **`shutil.copy2` (never move), stdlib only, no new pip dependency**: confirmed — only `argparse`,
  `os`, `shutil`, `sys`, `datetime` (stdlib) are imported; `shutil.move` is never called; source file
  is left in place — **confirmed** (`file_output.py:1-5`, `:113`).
- **stdout contract** ("prints the final destination path to stdout, single line, nothing else"):
  confirmed — the only `print()` to stdout is `print(dest_path)` at the end of `main()`; all error
  messages route to `sys.stderr` via `file=sys.stderr` — **confirmed** (`file_output.py:121`).
- **Convention doc exists and matches routing table**: confirmed at
  `/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/all-docs/outputs-router-convention.md`,
  routing table is byte-identical in structure/content to `SKILL.md` and `file_output.py`'s mapping
  — **confirmed**.
- **Path traversal via `--source`**: safe — `os.path.basename(args.source)` strips any directory
  components before joining into the destination — **confirmed safe** (`file_output.py:70`).
- **Path traversal via `--client`**: **not safe** — see Finding 1.
- **Shell injection**: no shell is invoked anywhere in the script (no `os.system`, `subprocess`,
  `os.popen`); all file operations are direct `os`/`shutil` stdlib calls — **confirmed no shell
  injection surface**.

## Not executed (static review only)

Did not run the manual dry run or the two error-path checks from the spec's "Validation
requirements" section. Based on static trace of the code, the happy-path dry run (`--content-type
sop`) should produce the exact expected stdout path and frontmatter fields, and both listed
error-path checks (missing `--source`, missing `--client` for `content-type=client`) should exit
non-zero with the documented one-line messages — but this has not been proven by execution, only by
reading. Recommend running the spec's exact dry-run + error-path commands before closing out P1.0,
given Finding 1 (`--client` traversal) and Finding 2 (frontmatter merge) are the kind of gaps that
only surface with adversarial/edge-case inputs, not the documented happy path.
