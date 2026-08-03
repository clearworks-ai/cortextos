# Round 2 Adversarial Review — kb-reconcile 504 retry + quarantine fix

**Commit reviewed:** d6170d1da7edb04bd55606f25e06c8ff7d71b514 ("Fix 504 retry + corrupt-file quarantine")
**Prior round (FAILED):** d768729 — classifier checked `error_type == "APIError"` by exact string, missed real `ClientError`/`ServerError` subclasses. See `04-review.md`.

## Verdict: **PASS**

## 1. Diff scope (`git show d6170d1 --stat`)

```
.../test_kb_reconcile_504_quarantine.py | 299 +++++++++++++++++----
knowledge-base/scripts/mmrag.py         |  51 ++--
2 files changed, 271 insertions(+), 79 deletions(-)
```

Only the test file and `mmrag.py` changed. `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` is **not** in the diff — confirmed unchanged (see #6).

## 2. `_is_quarantine_worthy(exc)` helper (mmrag.py:379-405)

```python
def _is_quarantine_worthy(exc):
    from google.genai import errors as _genai_errors
    error_message = " ".join(str(exc).split()) or "<no message>"
    if isinstance(exc, _genai_errors.APIError):
        if "INVALID_ARGUMENT" in error_message and "no pages" in error_message.lower():
            return True
    error_type = type(exc).__name__
    if any(keyword in error_type.lower() for keyword in ["pdf", "stream", "eof", "read", "corrupt"]):
        return True
    return False
```

- Uses `isinstance(exc, _genai_errors.APIError)` — **not** exact-string class-name match. This is the actual root-cause fix from round 1: `ClientError`/`ServerError` are subclasses of `APIError` in `google.genai.errors`, so `isinstance` now catches them where `error_type == "APIError"` never would.
- Both original call sites now delegate to the shared helper instead of duplicating classification logic:
  - `_reconcile_collection` — mmrag.py:1732: `if _is_quarantine_worthy(exc):`
  - `_build_collection_from_disk` — mmrag.py:1788: `if _is_quarantine_worthy(exc):`
- Confirmed via diff that both sites previously had ~10 lines of duplicated `is_quarantined = False / if .../elif error_type == "APIError"...` logic, now collapsed to a single-line call. DRY violation from round 1 also resolved as a side effect.

## 3. Test suite — live run

```
cd knowledge-base/scripts && MMRAG_DIR=/tmp/mmrag-review2-<pid> \
  .../knowledge-base/venv/bin/python3 -m _test_clients.test_kb_reconcile_504_quarantine
```

Output: **ALL PASS (4 scenarios)**, exit 0.

- test 1 (transient_504_and_deadline): PASS — 504/DEADLINE_EXCEEDED both retried.
- test 2 (quarantine_parse_errors): PASS — verified by reading source (not just trusting PASS text):
  - Constructs a **real** `google.genai.errors.ClientError` via `genai_errors.APIError.raise_error(400, {'message': 'The document has no pages.', 'status': 'INVALID_ARGUMENT'}, None)` inside a try/except — not a fake/mock class.
  - Asserts `isinstance(real_client_error, genai_errors.APIError)` is True (proves it's a real subclass instance, matching the actual bug scenario from round 1).
  - Calls the real `mmrag._is_quarantine_worthy(real_client_error)` (not a re-implementation) and asserts True.
  - Also separately tests a local `PdfStreamError` (keyword-name path) and a plain `ValueError` (negative case) through the same real helper.
- test 3 (transient_network_still_fails): PASS — regression check, 503 still exhausts retries and raises.
- test 4 (ledger_includes_paths): PASS — see #5 for the noted gap.

## 4. Live proof against the real corrupt PDF (real Gemini API call, quota used)

```python
config = mmrag.load_config()
client = mmrag.get_genai_client(mmrag.get_api_key(config))
mmrag.ingest_pdf(client, config, None, ".../The AI Discovery Blueprint.pdf")
```

Result:
```
Exception type: ClientError
Exception message: 400 INVALID_ARGUMENT. {'error': {'code': 400, 'message': 'The document has no pages.', 'status': 'INVALID_ARGUMENT'}}
_is_quarantine_worthy result: True
ASSERTION PASSED: exception is quarantine-worthy
```

This is the decisive check. Against the real API and the real corrupt file, Gemini raises `ClientError` (exactly the class the round-1 bug missed, since `type(exc).__name__ == "ClientError"`, not `"APIError"`). `_is_quarantine_worthy` returns `True` via the `isinstance(exc, _genai_errors.APIError)` branch. The round-1 defect is fixed and proven live, not just unit-tested.

## 5. Known residual gap (test 4 / ledger composer) — noted, not a fail condition per review scope

Test 4 (`ledger_includes_paths`) still runs a **hand-reimplemented copy** of the ledger-row composer logic (an inline Python string executed via `subprocess.run`) rather than extracting and executing the actual heredoc from `kb-reconcile-nightly.sh`. I independently diffed the reimplementation's field list and green-status logic against the real heredoc (lines ~100-170 of `kb-reconcile-nightly.sh`) and they match structurally (`failed_paths`, `quarantined_paths`, `green` computed from `failed_files == 0 and delete_failures.* == 0 and edges errors == 0`, etc.). Per instructions this is a known minor gap and does not fail the review on its own — flagging for future hardening (extract-and-exec the real heredoc instead of a parallel copy) so the test can't silently drift from the shell script.

## 6. `.sh` file unchanged

```
$ bash -n orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
(no output — syntax OK)
```

`git show d6170d1 --stat` confirms only `mmrag.py` and `test_kb_reconcile_504_quarantine.py` changed — `kb-reconcile-nightly.sh` untouched in this commit.

## 7. Build / typecheck

```
$ npx tsc --noEmit          → exit 0, no output
$ npm run build             → CJS build success in 133ms, exit 0
```

Both clean, re-confirmed.

## Summary

The round-1 defect (exact-string `error_type == "APIError"` missing real `ClientError`/`ServerError` subclasses) is fixed via `isinstance(exc, _genai_errors.APIError)` in a new shared `_is_quarantine_worthy` helper, used identically at both original call sites (`_reconcile_collection`, `_build_collection_from_disk`), eliminating the prior duplicated/divergent classification logic. Unit tests (4/4 PASS) exercise the real helper against a real `ClientError` instance and a real negative case. Most importantly, a live call against the actual Gemini API with the real corrupt PDF (`The AI Discovery Blueprint.pdf`) raises `ClientError` and `_is_quarantine_worthy` correctly returns `True` — the exact scenario that failed in round 1 now works end-to-end, not just in a mock. `tsc --noEmit` and `npm run build` are clean. The only residual issue is a known, pre-accepted minor gap: test 4 exercises a hand-copied reimplementation of the ledger composer rather than the real heredoc (verified separately to match). **Verdict: PASS.**
