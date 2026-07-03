"""Behavioral test for the MMRAG_INGEST_RECEIPT machine-readable final line.

Run from knowledge-base/scripts:

    python -m _test_clients.test_ingest_receipt

Exits 0 on all-pass, 1 on any failure. Zero external calls: the Gemini client
is a fake injected via MMRAG_GEMINI_CLIENT_FACTORY, the chroma layer is an
in-memory stub, and all paths are tempdirs.

Scenario: ingest a tempdir containing
  - good.txt   -> embeds fine            -> added
  - boom.txt   -> embed raises timeout   -> SKIP (error) + errored
  - empty.txt  -> empty file             -> skipped
then capture stdout, parse the final MMRAG_INGEST_RECEIPT line, and assert
{"added": 1, "updated": 0, "skipped": 1, "errored": 1, "duration_ms": >=0}
with the receipt as the LAST stdout line and cmd_ingest returning normally
(exit code stays 0 even with errored > 0 — the TS wrapper escalates on the
count, not the exit code).
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

# Sandbox all mmrag data paths BEFORE importing mmrag. Sentinel-guarded: the
# MMRAG_GEMINI_CLIENT_FACTORY loader re-imports this module under its real
# name while we run as __main__, and that re-import must not move the sandbox.
if not os.environ.get("_MMRAG_RECEIPT_TEST_SANDBOX"):
    _TMP = tempfile.mkdtemp(prefix="mmrag_receipt_test_")
    os.environ["MMRAG_DIR"] = os.path.join(_TMP, "mmrag")
    os.environ["MMRAG_CONFIG"] = os.path.join(_TMP, "config.json")
    os.environ["MMRAG_CHROMADB_DIR"] = os.path.join(_TMP, "chromadb")
    os.environ["_MMRAG_RECEIPT_TEST_SANDBOX"] = "1"

import mmrag


FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


# ---------------------------------------------------------------------------
# Fake client: embeds succeed unless the content contains "BOOM"
# ---------------------------------------------------------------------------
class _StubEmbeddingResult:
    class _Emb:
        values = [0.0] * 8

    def __init__(self):
        self.embeddings = [self._Emb()]


class _MarkerModels:
    def generate_content(self, model=None, contents=None, **kwargs):
        raise RuntimeError("receipt test only ingests .txt files; generate_content must not be called")

    def embed_content(self, model=None, contents=None, config=None, **kwargs):
        if isinstance(contents, str) and "BOOM" in contents:
            raise TimeoutError("injected embed timeout for BOOM file")
        return _StubEmbeddingResult()


class _MarkerClient:
    def __init__(self):
        self.models = _MarkerModels()


def make_marker_client(api_key=None):
    """Factory entry point for MMRAG_GEMINI_CLIENT_FACTORY."""
    return _MarkerClient()


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


def test_receipt_line():
    print("\n[test 1/1] MMRAG_INGEST_RECEIPT: counts + last-line + valid JSON")
    workdir = tempfile.mkdtemp(prefix="mmrag_receipt_src_")
    with open(os.path.join(workdir, "good.txt"), "w") as f:
        f.write("plain content that embeds fine")
    with open(os.path.join(workdir, "boom.txt"), "w") as f:
        f.write("this file goes BOOM at embed time")
    with open(os.path.join(workdir, "empty.txt"), "w") as f:
        f.write("")

    with open(os.environ["MMRAG_CONFIG"], "w") as f:
        json.dump({"gemini_api_key": "fake-key-never-used", "default_collection": "default"}, f)

    os.environ["MMRAG_GEMINI_CLIENT_FACTORY"] = (
        "_test_clients.test_ingest_receipt:make_marker_client"
    )
    os.environ["MMRAG_RETRY_BACKOFFS"] = "0,0,0"

    fake_collection = FakeCollection()
    orig_get_collection = mmrag.get_chroma_collection
    mmrag.get_chroma_collection = lambda collection_name="default": fake_collection

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
    _check(
        "cmd_ingest returns normally despite errored file (exit code stays 0)",
        raised is None,
        detail=f"raised {type(raised).__name__ if raised else None}: {raised}",
    )
    _check(
        "boom.txt logged as SKIP (error) with exception type",
        "SKIP (error):" in out and "TimeoutError:" in out,
        detail=f"stdout was: {out!r}",
    )

    lines = [l for l in out.strip().splitlines() if l.strip()]
    last = lines[-1] if lines else ""
    _check(
        "receipt is the LAST stdout line",
        last.startswith("MMRAG_INGEST_RECEIPT "),
        detail=f"last line: {last!r}",
    )
    _check(
        "receipt prefix appears exactly once",
        out.count("MMRAG_INGEST_RECEIPT ") == 1,
        detail=f"count: {out.count('MMRAG_INGEST_RECEIPT ')}",
    )

    receipt = None
    if last.startswith("MMRAG_INGEST_RECEIPT "):
        payload = last[len("MMRAG_INGEST_RECEIPT "):]
        try:
            receipt = json.loads(payload)
        except json.JSONDecodeError as e:
            _check("receipt payload is valid JSON", False, detail=f"{e}: {payload!r}")

    if receipt is not None:
        _check("receipt payload is valid JSON", isinstance(receipt, dict))
        _check(
            "receipt has exactly the expected keys",
            set(receipt.keys()) == {"added", "updated", "skipped", "errored", "duration_ms"},
            detail=f"keys: {sorted(receipt.keys())}",
        )
        _check("added == 1 (good.txt)", receipt.get("added") == 1, detail=f"receipt: {receipt}")
        _check("updated == 0", receipt.get("updated") == 0, detail=f"receipt: {receipt}")
        _check("skipped == 1 (empty.txt)", receipt.get("skipped") == 1, detail=f"receipt: {receipt}")
        _check("errored == 1 (boom.txt)", receipt.get("errored") == 1, detail=f"receipt: {receipt}")
        _check(
            "duration_ms is a non-negative int",
            isinstance(receipt.get("duration_ms"), int) and receipt["duration_ms"] >= 0,
            detail=f"receipt: {receipt}",
        )

    _check(
        "good.txt actually landed in the collection",
        fake_collection.count() == 1,
        detail=f"rows: {fake_collection.count()}",
    )


if __name__ == "__main__":
    test_receipt_line()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (1 scenario)")
    sys.exit(0)
