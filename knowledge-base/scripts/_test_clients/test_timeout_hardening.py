"""Behavioral tests for spec 09 timeout/transport hardening in mmrag.

Run from knowledge-base/scripts:

    python -m _test_clients.test_timeout_hardening

Exits 0 on all-pass, 1 on any failure. Zero external calls: fake clients only
(MMRAG_GEMINI_CLIENT_FACTORY / direct construction), tempdirs only, and the
chroma layer is replaced with an in-memory stub.

NOTE: unlike test_ingest_receipt (which is SDK-free by construction), this
suite REQUIRES google-genai to be importable (run it with the knowledge-base
venv python): scenario 3 exercises the real google.genai.errors.APIError
subclass via fault_injection, and scenario 5 constructs a real genai.Client
with HttpOptions(timeout=...). Neither makes a network call. Scenarios:

  1. hang->timeout is bounded: a client that raises TimeoutError on every call
     makes _retry_generate_content AND embed_content retry exactly
     len(backoffs) times (backoffs (0,0,0)) then re-raise — control RETURNS,
     nothing hangs.
  2. transient-then-success: one timeout then success -> no exception
     surfaces, the scripted response comes back.
  3. non-transient APIError (400) -> re-raised immediately, no retries.
  4. ingest-loop isolation: with an always-timeout fake client, cmd_ingest
     over a tempdir logs `SKIP (error): ... TimeoutError ...`, counts the file
     as errored in the MMRAG_INGEST_RECEIPT line, and returns normally.
  5. get_genai_client (no factory) constructs a real genai.Client with
     HttpOptions(timeout=MMRAG_GEMINI_TIMEOUT_MS) without raising. No API
     call is made — construction only.
"""

import contextlib
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

# Point every mmrag data path at a throwaway tempdir BEFORE importing mmrag
# (module-level constants read these env vars at import time). Guarded by a
# sentinel: mmrag's MMRAG_GEMINI_CLIENT_FACTORY loader imports this module a
# second time (under its real name, while we run as __main__), and that
# re-import must NOT re-point the sandbox mid-test.
if not os.environ.get("_MMRAG_TIMEOUT_TEST_SANDBOX"):
    _TMP = tempfile.mkdtemp(prefix="mmrag_timeout_test_")
    os.environ["MMRAG_DIR"] = os.path.join(_TMP, "mmrag")
    os.environ["MMRAG_CONFIG"] = os.path.join(_TMP, "config.json")
    os.environ["MMRAG_CHROMADB_DIR"] = os.path.join(_TMP, "chromadb")
    os.environ["_MMRAG_TIMEOUT_TEST_SANDBOX"] = "1"

import mmrag
from _test_clients import fault_injection


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


# ---------------------------------------------------------------------------
# Fakes (no network, ever)
# ---------------------------------------------------------------------------
class _StubEmbeddingResult:
    class _Emb:
        values = [0.0] * 8

    def __init__(self):
        self.embeddings = [self._Emb()]


class AlwaysTimeoutModels:
    """Simulates a hung socket surfacing as a client-side timeout on EVERY call."""

    def __init__(self):
        self.generate_attempts = 0
        self.embed_attempts = 0

    def generate_content(self, model=None, contents=None, **kwargs):
        self.generate_attempts += 1
        raise TimeoutError("injected hang (client-side read timeout)")

    def embed_content(self, model=None, contents=None, config=None, **kwargs):
        self.embed_attempts += 1
        raise TimeoutError("injected hang (client-side read timeout)")


class TimeoutThenSuccessModels:
    """First call times out, second succeeds."""

    def __init__(self):
        self.generate_attempts = 0

    def generate_content(self, model=None, contents=None, **kwargs):
        self.generate_attempts += 1
        if self.generate_attempts == 1:
            raise TimeoutError("injected transient timeout")
        return fault_injection._StubResponse("recovered after timeout")


class FakeClient:
    def __init__(self, models):
        self.models = models


def make_always_timeout_client(api_key=None):
    """Factory entry point for MMRAG_GEMINI_CLIENT_FACTORY (ingest-loop test)."""
    return FakeClient(AlwaysTimeoutModels())


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_bounded_timeout_generate():
    print("\n[test 1a/5] always-timeout: _retry_generate_content is bounded")
    client = FakeClient(AlwaysTimeoutModels())
    raised = None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            mmrag._retry_generate_content(
                client, model="x", contents=["x"], backoffs=(0, 0, 0)
            )
    except Exception as e:
        raised = e
    out = buf.getvalue()
    _check("raises after exhausting retries (control returns, no hang)", raised is not None)
    _check(
        "raised is TimeoutError",
        isinstance(raised, TimeoutError),
        detail=f"got {type(raised).__name__}",
    )
    _check(
        "consumed exactly len(backoffs)=3 attempts",
        client.models.generate_attempts == 3,
        detail=f"got {client.models.generate_attempts}",
    )
    _check(
        "log line uses timeout/transport style",
        "Transient error (timeout/transport: TimeoutError); retrying in 0s (attempt 1/3)" in out,
        detail=f"stdout was: {out!r}",
    )


def test_bounded_timeout_embed():
    print("\n[test 1b/5] always-timeout: embed_content is bounded")
    client = FakeClient(AlwaysTimeoutModels())
    raised = None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            mmrag.embed_content(client, {}, "hello world", backoffs=(0, 0, 0))
    except Exception as e:
        raised = e
    _check("embed raises after exhausting retries", isinstance(raised, TimeoutError),
           detail=f"got {type(raised).__name__ if raised else None}")
    _check(
        "embed consumed exactly len(backoffs)=3 attempts",
        client.models.embed_attempts == 3,
        detail=f"got {client.models.embed_attempts}",
    )


def test_transient_then_success():
    print("\n[test 2/5] timeout once -> success, no exception surfaces")
    client = FakeClient(TimeoutThenSuccessModels())
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        response = mmrag._retry_generate_content(
            client, model="x", contents=["x"], backoffs=(0, 0, 0)
        )
    _check(
        "response.text matches",
        getattr(response, "text", None) == "recovered after timeout",
        detail=f"got {getattr(response, 'text', None)!r}",
    )
    _check(
        "consumed exactly 2 attempts",
        client.models.generate_attempts == 2,
        detail=f"got {client.models.generate_attempts}",
    )


def test_nontransient_fast_fail():
    print("\n[test 3/5] non-transient APIError (400) -> re-raised immediately")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("400:invalid argument,200:should not reach")
    )
    raised = None
    try:
        mmrag._retry_generate_content(
            client, model="x", contents=["x"], backoffs=(0, 0, 0)
        )
    except Exception as e:
        raised = e
    _check("raises immediately", raised is not None)
    if raised is not None:
        _check("raised.code is 400", getattr(raised, "code", None) == 400)
    _check(
        "did NOT retry (only 1 attempt consumed)",
        client.models._index == 1,
        detail=f"got {client.models._index}",
    )


class FakeCollection:
    """In-memory stand-in for a chroma collection (no live chromadb)."""

    def __init__(self):
        self.rows = {}

    def get(self, ids=None, include=None):
        found = [i for i in (ids or []) if i in self.rows]
        return {"ids": found, "metadatas": [self.rows[i] for i in found]}

    def upsert(self, ids, embeddings, documents, metadatas):
        for i, m in zip(ids, metadatas):
            self.rows[i] = m

    def count(self):
        return len(self.rows)


def test_ingest_loop_isolation():
    print("\n[test 4/5] ingest loop: always-timeout -> SKIP (error) + errored count, run completes")
    workdir = tempfile.mkdtemp(prefix="mmrag_ingest_src_")
    with open(os.path.join(workdir, "doc.txt"), "w") as f:
        f.write("some content that needs an embedding call")

    with open(os.environ["MMRAG_CONFIG"], "w") as f:
        json.dump({"gemini_api_key": "fake-key-never-used", "default_collection": "default"}, f)

    os.environ["MMRAG_GEMINI_CLIENT_FACTORY"] = (
        "_test_clients.test_timeout_hardening:make_always_timeout_client"
    )
    os.environ["MMRAG_RETRY_BACKOFFS"] = "0,0,0"

    orig_get_collection = mmrag.get_chroma_collection
    mmrag.get_chroma_collection = lambda collection_name="default": FakeCollection()

    class Args:
        paths = [workdir]
        collection = None
        force = False

    raised = None
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            mmrag.cmd_ingest(Args())
    except Exception as e:
        raised = e
    finally:
        mmrag.get_chroma_collection = orig_get_collection
        os.environ.pop("MMRAG_GEMINI_CLIENT_FACTORY", None)
        os.environ.pop("MMRAG_RETRY_BACKOFFS", None)

    out = buf.getvalue()
    _check("cmd_ingest returns normally (never re-raises from the loop)",
           raised is None, detail=f"raised {type(raised).__name__ if raised else None}: {raised}")
    _check(
        "logs SKIP (error) with exception type",
        "SKIP (error):" in out and "TimeoutError:" in out,
        detail=f"stdout was: {out!r}",
    )
    lines = [l for l in out.strip().splitlines() if l.strip()]
    last = lines[-1] if lines else ""
    _check("receipt line is last", last.startswith("MMRAG_INGEST_RECEIPT "), detail=f"last line: {last!r}")
    if last.startswith("MMRAG_INGEST_RECEIPT "):
        receipt = json.loads(last[len("MMRAG_INGEST_RECEIPT "):])
        _check("errored == 1", receipt.get("errored") == 1, detail=f"receipt: {receipt}")
        _check("added == 0", receipt.get("added") == 0, detail=f"receipt: {receipt}")


def test_client_timeout_construction():
    print("\n[test 5/5] get_genai_client constructs with HttpOptions(timeout=...) — no API call")
    os.environ.pop("MMRAG_GEMINI_CLIENT_FACTORY", None)
    os.environ["MMRAG_GEMINI_TIMEOUT_MS"] = "5000"
    raised = None
    client = None
    try:
        client = mmrag.get_genai_client("fake-key-never-used")
    except Exception as e:
        raised = e
    finally:
        os.environ.pop("MMRAG_GEMINI_TIMEOUT_MS", None)
    _check(
        "genai.Client accepts http_options=HttpOptions(timeout=ms)",
        raised is None and client is not None,
        detail=f"raised {type(raised).__name__ if raised else None}: {raised}",
    )
    # Best-effort introspection (SDK internals vary across versions; only
    # assert when the attribute path exists).
    timeout_val = None
    api_client = getattr(client, "_api_client", None)
    http_opts = getattr(api_client, "_http_options", None)
    if http_opts is not None:
        timeout_val = getattr(http_opts, "timeout", None)
    if timeout_val is not None:
        _check("configured timeout is 5000 ms", timeout_val == 5000, detail=f"got {timeout_val}")
    else:
        print("  NOTE  SDK internals not introspectable in this version; construction check only")


if __name__ == "__main__":
    test_bounded_timeout_generate()
    test_bounded_timeout_embed()
    test_transient_then_success()
    test_nontransient_fast_fail()
    test_ingest_loop_isolation()
    test_client_timeout_construction()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (5 scenarios)")
    sys.exit(0)
