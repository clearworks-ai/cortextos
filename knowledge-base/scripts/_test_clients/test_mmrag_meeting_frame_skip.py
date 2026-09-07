"""Meeting-frame skip-caption: conserve the source path without Gemini Flash."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-frame-skip-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


class _ExplodingDescribe:
    def __call__(self, *_args, **_kwargs):
        raise AssertionError("describe_media must not run for skip-caption frames")


class _RecordingCollection:
    def __init__(self):
        self.upserts = []

    def upsert(self, **kwargs):
        self.upserts.append(kwargs)


def test_detects_derived_frames_and_periodic_names(tmp_path):
    frame = tmp_path / "derived" / "frames" / "part" / "periodic-0860s.jpg"
    other = tmp_path / "photos" / "headshot.jpg"
    frame.parent.mkdir(parents=True)
    other.parent.mkdir(parents=True)
    frame.write_bytes(b"jpeg")
    other.write_bytes(b"jpeg")
    assert mmrag._is_meeting_frame_image(frame) is True
    assert mmrag._is_meeting_frame_image(other) is False


def test_skip_caption_upserts_without_describe_media(tmp_path, monkeypatch):
    frame = tmp_path / "derived" / "frames" / "frame-0001.jpg"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"fake-jpeg-bytes")
    monkeypatch.setenv("MMRAG_SKIP_MEETING_FRAME_CAPTION", "1")
    monkeypatch.setattr(mmrag, "already_exists", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(mmrag, "describe_media", _ExplodingDescribe())
    monkeypatch.setattr(mmrag, "embed_content", lambda *_args, **_kwargs: [0.1, 0.2])
    monkeypatch.setattr(mmrag, "_common_source_metadata", lambda path, **_kwargs: {
        "source_file": str(path.resolve()),
        "source": str(path.resolve()),
    })
    collection = _RecordingCollection()
    count = mmrag.ingest_image(SimpleNamespace(), {}, collection, frame)
    assert count == 1
    assert len(collection.upserts) == 1
    row = collection.upserts[0]
    assert row["documents"][0].startswith("meeting-frame")
    assert str(frame.resolve()) in row["documents"][0]
    assert row["metadatas"][0]["source_file"] == str(frame.resolve())
    assert row["metadatas"][0]["caption_skipped"] is True


def test_without_env_flag_still_calls_describe_media(tmp_path, monkeypatch):
    frame = tmp_path / "derived" / "frames" / "frame-0002.jpg"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"fake-jpeg-bytes")
    monkeypatch.delenv("MMRAG_SKIP_MEETING_FRAME_CAPTION", raising=False)
    monkeypatch.setattr(mmrag, "already_exists", lambda *_args, **_kwargs: False)
    called = {"describe": 0}

    def fake_describe(*_args, **_kwargs):
        called["describe"] += 1
        return "caption", b"bytes", "image/jpeg"

    monkeypatch.setattr(mmrag, "describe_media", fake_describe)
    monkeypatch.setattr(mmrag, "embed_multimodal", lambda *_args, **_kwargs: [0.3])
    monkeypatch.setattr(mmrag, "_common_source_metadata", lambda path, **_kwargs: {
        "source_file": str(path.resolve()),
    })
    collection = _RecordingCollection()
    mmrag.ingest_image(SimpleNamespace(), {}, collection, frame)
    assert called["describe"] == 1
    assert collection.upserts[0]["metadatas"][0]["caption_skipped"] is False
