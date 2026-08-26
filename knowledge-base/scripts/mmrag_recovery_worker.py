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


def _refuse_live_persist():
    side = os.environ.get("MMRAG_SIDE_CHROMADB_DIR", "").strip()
    if not side:
        print("WORKER_REFUSED: MMRAG_SIDE_CHROMADB_DIR required", file=sys.stderr)
        return 3
    live = os.environ.get("MMRAG_LIVE_CHROMADB_DIR", "").strip()
    if live and Path(side).resolve() == Path(live).resolve():
        print("WORKER_REFUSED: side persist must not equal live persist", file=sys.stderr)
        return 3
    return 0


def probe_side():
    """Process-boundary reopen/count. Side persist only."""
    import mmrag

    mmrag.set_mmrag_operation("query")
    name = os.environ.get("MMRAG_RECOVERY_COLLECTION", "shared-clearworksai")
    collection = mmrag.get_chroma_collection(name)
    count = collection.count()
    print(json.dumps({
        "result": "PROBE_OK",
        "pid": os.getpid(),
        "collection": name,
        "count": count,
        "chromadb_dir": str(mmrag.CHROMADB_DIR),
        "persist": os.environ.get("MMRAG_SIDE_CHROMADB_DIR"),
    }, separators=(",", ":")))


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


def export_side_source_ids():
    """Unique source_file IDs only. Side persist. No live path."""
    import mmrag

    mmrag.set_mmrag_operation("query")
    name = os.environ.get("MMRAG_RECOVERY_COLLECTION", "shared-clearworksai")
    collection = mmrag.get_chroma_collection(name)
    rows = mmrag._get_all_collection_rows(collection, include=["metadatas"])
    metadatas = rows.get("metadatas") or []
    ids = rows.get("ids") or []
    sources = []
    seen = set()
    for metadata in metadatas:
        source = mmrag._metadata_source(metadata)
        if source and source not in seen:
            seen.add(source)
            sources.append(source)
    print(json.dumps({
        "result": "SOURCE_IDS_OK",
        "source_files": sources,
        "unique_source_count": len(sources),
        "chunk_count": len(ids),
        "collection": name,
    }, separators=(",", ":")))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in {"export-side", "probe-side", "export-source-ids"}:
        print("usage: mmrag_recovery_worker.py export-side|probe-side|export-source-ids", file=sys.stderr)
        return 2
    if os.environ.get("MMRAG_ISOLATED_CHROMA_WORKER", "").strip() != "1":
        print("WORKER_REFUSED: command requires isolated worker env", file=sys.stderr)
        return 3
    refused = _refuse_live_persist()
    if refused:
        return refused
    if argv[0] == "probe-side":
        probe_side()
        return 0
    if argv[0] == "export-source-ids":
        export_side_source_ids()
        return 0
    export_side_oracle_b()
    return 0


if __name__ == "__main__":
    sys.exit(main())
