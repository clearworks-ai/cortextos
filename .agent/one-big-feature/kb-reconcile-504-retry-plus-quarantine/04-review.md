# Adversarial Review — kb-reconcile-504-retry-plus-quarantine

Branch: `kb-reconcile-504-retry-plus-quarantine` @ `d768729`
Reviewer: independent adversarial pass (no trust of prior self-report)

## Verdict: **FAIL**

The headline change (#2, quarantine unrecoverable parse errors) does not work for
the real-world case it was built to fix. The self-reported "4/4 PASS" test run is
misleading: 2 of the 4 tests do not exercise the shipped code at all — they
duplicate the implementation's logic inline and assert it against itself, or
construct an unrelated mock dict. Independently driving the real production
function (`_build_collection_from_disk`) with the actual exception type the
Gemini SDK raises for an INVALID_ARGUMENT/"no pages" response proves the bug:
that file lands in `failed_paths`, not `quarantined_paths` — exactly the
behavior this spec exists to eliminate.

---

## 1. Diff review — `git show HEAD --stat` / `git show HEAD`

Confirmed exactly 3 files touched, matching spec scope:

```
knowledge-base/scripts/_test_clients/test_kb_reconcile_504_quarantine.py | 178 ++++++
knowledge-base/scripts/mmrag.py                                          |  49 ++-
orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh               |   4 +-
```

### Change 1 (transient classifier) — CORRECT
```python
TRANSIENT_HTTP_CODES = {429, 500, 503, 504}
TRANSIENT_STATUS_NAMES = {"UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED"}
```
Matches spec exactly, at the correct location (module-level constants feeding
`_retry_api_call`'s `is_transient` check). No other lines touched in this
region.

### Change 2 (quarantine classifier) — **BROKEN, verified live**

The implementation added to both `_reconcile_collection` (~line 1698) and
`_build_collection_from_disk` (~line 1763):

```python
error_type = type(exc).__name__
is_quarantined = False
if any(keyword in error_type.lower() for keyword in ["pdf", "stream", "eof", "read", "corrupt"]):
    is_quarantined = True
elif error_type == "APIError" and "INVALID_ARGUMENT" in error_message and "no pages" in error_message.lower():
    is_quarantined = True
```

**Bug found:** the Gemini `google-genai` SDK never raises the literal
`APIError` class for real HTTP error responses. `APIError.raise_error()`
(the method the SDK actually calls internally) dispatches to a *subclass*
based on status code:

```python
if 400 <= status_code < 500:
    raise ClientError(status_code, response_json, response)
elif 500 <= status_code < 600:
    raise ServerError(status_code, response_json, response)
else:
    raise cls(status_code, response_json, response)   # bare APIError only outside 4xx/5xx
```

Verified directly against the installed SDK in this repo's venv:

```
$ knowledge-base/venv/bin/python3 -c "
from google.genai import errors
try:
    errors.APIError.raise_error(400, {'message': 'no pages found in document', 'status': 'INVALID_ARGUMENT'}, None)
except Exception as e:
    print('type name:', type(e).__name__)
"
type name: ClientError
```

So `type(exc).__name__` for a real INVALID_ARGUMENT/"no pages" Gemini error is
`"ClientError"`, never `"APIError"`. The check `error_type == "APIError"` is
**always False** for this scenario in production. This is precisely the
scenario named in the commit message ("1 [file] is byte-truncated and
unrecoverable... quarantine unrecoverable parse errors instead of retrying
forever") — and it does not work.

**Live proof against the actual shipped function** (not a mock of the logic,
the real `mmrag._build_collection_from_disk`, with only `ingest_file`
monkeypatched to raise the exact exception the SDK raises for this case):

```
$ knowledge-base/venv/bin/python3 -c "
import mmrag
from google.genai import errors
def fake_ingest_file(client, config, collection, file_path):
    errors.APIError.raise_error(400, {'message': 'no pages found in document', 'status': 'INVALID_ARGUMENT'}, None)
mmrag.ingest_file = fake_ingest_file
class FakeCollection:
    def count(self): return 0
result = mmrag._build_collection_from_disk(None, {}, FakeCollection(), ['/tmp/mmrag-verify-src'])
print(result['failed_paths'], result['quarantined_paths'])
"
  SKIP (error): /private/tmp/mmrag-verify-src/corrupt.pdf — ClientError: 400 INVALID_ARGUMENT. {...}
failed_paths: ['/private/tmp/mmrag-verify-src/corrupt.pdf']
quarantined_paths: []
```

Result: the file lands in `failed_paths`, not `quarantined_paths`. Nightly
`green` will remain `false` for this file forever — the exact bug this spec
was written to close is NOT closed.

**Secondary concern (the keyword branch):** `mmrag.py` does not use pypdf,
PyPDF2, or any local PDF-parsing library anywhere — `ingest_pdf` reads raw
bytes and ships them straight to Gemini via `types.Part.from_bytes` (confirmed
by `grep -n "pypdf\|PyPDF2\|PdfReader" mmrag.py` — no hits). So the keyword
list `["pdf", "stream", "eof", "read", "corrupt"]`, matched against
**exception class name**, doesn't correspond to any exception this ingest path
actually raises today — it's speculative/dead code for its stated purpose.
It's also a latent false-positive risk: it matches on substring of the class
name, not the message, so any exception whose type name happens to contain
one of those fragments (e.g. builtin `EOFError`, or `http.client.IncompleteRead`
if any dependency's HTTP layer surfaces it, or a hypothetical `StreamClosed`
type from a transport library) would be silently quarantined instead of
retried, even if it were actually a transient network condition. Not proven to
fire today, but it's an unsound classification mechanism (keyed to guessed
class-name substrings instead of specific known exception types or message
content) sitting right next to a confirmed-broken check.

The duplicate copy-paste of this whole block between `_reconcile_collection`
and `_build_collection_from_disk` (DRY violation, same bug in both places) is
a maintainability smell but not separately scored — it's the same bug twice.

### Change 3 (ledger row) — mechanically correct, undermined by #2

```python
"failed_paths": recon_data.get("failed_paths", []),
"quarantined_paths": recon_data.get("quarantined_paths", []) if recon_data.get("quarantined_paths") else [],
```

Independently re-ran the exact heredoc body (extracted verbatim) with a
synthetic `RECON_OUT='{"failed_files": 1, "failed_paths": ["/tmp/x.pdf"], "quarantined_paths": ["/tmp/y.pdf"]}'`:

```
{"ts": "...", "run": "kb-reconcile-nightly", ...,
 "reconcile": {..., "failed_paths": ["/tmp/x.pdf"], "quarantined_paths": ["/tmp/y.pdf"], ...},
 "green": false}
```

Both keys appear, both are arrays, values pass through correctly — this part
is mechanically sound. `quarantined_paths` is always present as an array
(`[]` when empty) rather than omitted when empty; spec text ("quarantined_paths
... when non-empty") is ambiguous on omit-vs-empty-array, this reading is
defensible and arguably safer for readers. Not a blocking issue, noted as a
minor spec-interpretation nit.

Given change #2 is broken, in practice `quarantined_paths` will rarely
populate for the real corrupt-PDF case this spec targets, so change #3's
correctness doesn't rescue the overall fix — the ledger will faithfully
report the corrupt file under `failed_paths` forever, same as before this
patch, and `green` stays `false`.

### Incidental unrelated edit (minor)

```diff
 except json.JSONDecodeError:
-    edges_data = {}
+        edges_data = {}
```
A stray indentation change (4→8 spaces) inside the pre-existing
`json.JSONDecodeError` except block, unrelated to any of the 3 named changes.
Confirmed harmless (Python only requires internal consistency of the block,
not a specific indent width) via `py_compile` below, but it's scope creep the
spec explicitly said should not happen ("no changes to backoff timing... no
other changes needed"). Cosmetic only, not a functional bug.

---

## 2. Independent test suite run

```
$ cd knowledge-base/scripts && MMRAG_DIR=/tmp/mmrag-review-$$ \
    /Users/joshweiss/code/cortextos/knowledge-base/venv/bin/python3 -m _test_clients.test_kb_reconcile_504_quarantine
...
ALL PASS (4 scenarios)
EXIT_CODE=0
```

Reproduced the reported 4/4 PASS. **However, on inspection the test file
itself (`_test_clients/test_kb_reconcile_504_quarantine.py`) is materially
compromised for exactly the two changes with real implementation risk:**

- **Test 2 (`test_quarantine_parse_errors`)** does not call any mmrag function.
  It re-declares the *same* keyword list (`["pdf", "stream", "eof", "read",
  "corrupt"]`) inline in the test and asserts it against itself:
  ```python
  is_quarantineworthy = any(
      keyword in error_type.lower()
      for keyword in ["pdf", "stream", "eof", "read", "corrupt"]
  )
  ```
  This is tautological — it will pass regardless of what
  `_reconcile_collection`/`_build_collection_from_disk` actually do, and it
  never exercises the `APIError`-literal branch at all (the one proven broken
  above). It would still say PASS if the production keyword list were deleted
  entirely, or if the `APIError` string-equality bug were introduced,
  unchanged, or fixed.

- **Test 4 (`test_ledger_includes_paths`)** never invokes the bash script or
  its embedded Python heredoc. It manually constructs a `mock_recon_data`
  dict and asserts that dict's own keys are lists:
  ```python
  mock_recon_data = {"failed_paths": [...], "quarantined_paths": [...], ...}
  _check("failed_paths is present and is a list", "failed_paths" in mock_recon_data and isinstance(...))
  ```
  This can never fail and proves nothing about
  `kb-reconcile-nightly.sh`'s actual composer logic.

- **Tests 1 and 3** are real — they call `mmrag._retry_generate_content`
  through the fault-injection client, exercising the actual production retry
  path. These are trustworthy.

Net: the test suite's 4/4 is only genuine evidence for change #1 (retry
classifier). It provides zero real coverage of change #2's core logic and
zero real coverage of change #3, both of which is why the `ClientError` vs
`APIError` bug shipped undetected.

---

## 3. Heredoc syntax check

```
$ awk '/<<.PYTHON_SCRIPT.$/{flag=1;next}/^PYTHON_SCRIPT$/{flag=0}flag' \
    orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh > /tmp/heredoc_extract.py
$ python3 -m py_compile /tmp/heredoc_extract.py
PY_COMPILE_OK
```
Embedded Python is syntactically valid (including the stray extra
indentation noted above).

## 4. Bash syntax check

```
$ bash -n orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
BASH_SYNTAX_OK
```

## 5. Scope discipline

```
$ git show HEAD --name-only
knowledge-base/scripts/_test_clients/test_kb_reconcile_504_quarantine.py
knowledge-base/scripts/mmrag.py
orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
```
Exactly 3 files (1 new test file, 2 modified), matches spec. Confirmed:
- `bin/kb-reconcile-nightly.sh` at repo root does **not** exist (`ls` → No
  such file or directory) — spec correctly says this path doesn't exist.
- `orgs/clearworksai/agents/larry-codex/bin/kb-reconcile-nightly.sh` mirror
  exists on disk but was **not** touched by this commit (absent from `git
  show HEAD --name-only`, and `git show HEAD --stat | grep -i codex` returns
  nothing) — correctly left alone per spec.

---

## Summary of findings

| # | Item | Status |
|---|------|--------|
| 1 | 504/DEADLINE_EXCEEDED added to transient classifier | PASS — correct, verified via real retry path |
| 2 | Quarantine unrecoverable parse errors | **FAIL** — `error_type == "APIError"` never matches real SDK errors (`ClientError`/`ServerError` are the actual raised types); live-verified the real corrupt-PDF/no-pages scenario lands in `failed_paths`, not `quarantined_paths`. Keyword-based file-error branch doesn't correspond to any exception actually raised in this codebase (no local PDF parser is used) and is an unsound classification mechanism besides. |
| 3 | Ledger row includes `failed_paths`/`quarantined_paths` | PASS mechanically, but moot for the real-world case since #2 doesn't populate `quarantined_paths` for it |
| Tests | 4/4 reported PASS | Reproduced, but 2 of 4 tests (2 and 4 — precisely the two changes with real risk) don't exercise the shipped code; they're tautological/mocked and would pass even if the shipped logic were wrong (as it is) |
| Scope | 3 files, no stray files created | PASS, plus one incidental unrelated whitespace edit (harmless, cosmetic) |

**Overall: FAIL.** The fix does not solve the problem it was built for. Ship
blocker: change #2's `elif error_type == "APIError"` branch must check for
`ClientError`/`ServerError` (or better, inspect `exc` via
`isinstance(exc, google.genai.errors.APIError)` and read `.code`/`.status`
rather than comparing `type(exc).__name__` to a literal string), and the
keyword-based branch should be re-scoped to something that maps to an actual
exception this codebase raises, or removed if it protects against nothing
real. The test suite needs tests 2 and 4 rewritten to call the actual
production functions (`_build_collection_from_disk`/`_reconcile_collection`
and the actual bash/heredoc composer) with real exception objects/real
subprocess output, not hand-duplicated logic or mock dicts.
