"""Isolated recovery worker. Invoked only as a subprocess.

This file may construct a Chroma client against the approved side persist
path. The parent recovery driver must not import these helpers.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


def export_side_oracle_b():
    import mmrag

    mmrag.set_mmrag_operation("query")
    name = os.environ.get("MMRAG_RECOVERY_COLLECTION", "shared-clearworksai")
    collection = mmrag.get_chroma_collection(name)
    rows = mmrag._get_all_collection_rows(collection, include=["metadatas", "documents"])
    chunks = []
    ids = rows.get("ids") or []
    metadatas = rows.get("metadatas") or []
    documents = rows.get("documents") or []
    for index, doc_id in enumerate(ids):
        metadata = metadatas[index] if index < len(metadatas) else {}
        document = documents[index] if index < len(documents) else ""
        text = document if isinstance(document, str) else str(document or "")
        chunks.append({
            "id": doc_id,
            "source_file": mmrag._metadata_source(metadata),
            "chunk_index": None if metadata is None else metadata.get("chunk_index"),
            "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        })
    print(json.dumps({"result": "ORACLE_B_OK", "chunks": chunks}, separators=(",", ":")))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] != "export-side":
        print("usage: mmrag_recovery_worker.py export-side", file=sys.stderr)
        return 2
    if os.environ.get("MMRAG_ISOLATED_CHROMA_WORKER", "").strip() != "1":
        print("WORKER_REFUSED: export-side requires isolated worker env", file=sys.stderr)
        return 3
    side = os.environ.get("MMRAG_SIDE_CHROMADB_DIR", "").strip()
    if not side:
        print("WORKER_REFUSED: MMRAG_SIDE_CHROMADB_DIR required", file=sys.stderr)
        return 3
    if Path(side).resolve() == Path(os.environ.get("MMRAG_LIVE_CHROMADB_DIR", "")).resolve():
        print("WORKER_REFUSED: side persist must not equal live persist", file=sys.stderr)
        return 3
    export_side_oracle_b()
    return 0


if __name__ == "__main__":
    sys.exit(main())
