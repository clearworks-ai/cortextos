import importlib
import os
import sys
import time


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


def _ts(value):
    return time.mktime(time.strptime(value, "%Y-%m-%dT%H:%M:%S"))


def test_recency_gap_keeps_older_more_similar_doc_first():
    now = _ts("2026-06-30T12:00:00")
    results = [
        {
            "id": "older-strong",
            "content": "older",
            "similarity": 0.72,
            "metadata": {"created_at": "2026-03-01T12:00:00", "doc_type": "reference"},
        },
        {
            "id": "fresh-weak",
            "content": "fresh",
            "similarity": 0.55,
            "metadata": {"created_at": "2026-06-30T12:00:00", "doc_type": "note"},
        },
    ]

    reranked = mmrag._apply_recency_rerank(results, enabled=True, now=now)

    assert [result["id"] for result in reranked] == ["older-strong", "fresh-weak"]


def test_recency_near_tie_still_prefers_fresher_doc():
    now = _ts("2026-06-30T12:00:00")
    results = [
        {
            "id": "older-slightly-better",
            "content": "older",
            "similarity": 0.71,
            "metadata": {"created_at": "2026-03-01T12:00:00", "doc_type": "note"},
        },
        {
            "id": "fresh-near-tie",
            "content": "fresh",
            "similarity": 0.70,
            "metadata": {"created_at": "2026-06-30T12:00:00", "doc_type": "note"},
        },
    ]

    reranked = mmrag._apply_recency_rerank(results, enabled=True, now=now)

    assert [result["id"] for result in reranked] == ["fresh-near-tie", "older-slightly-better"]


def test_authoritative_floor_keeps_strong_doc_above_fresh_weaker_doc():
    now = _ts("2026-06-30T12:00:00")
    results = [
        {
            "id": "authoritative",
            "content": "older",
            "similarity": 0.72,
            "metadata": {"created_at": "2026-03-01T12:00:00", "doc_type": "reference"},
        },
        {
            "id": "fresh-but-weaker",
            "content": "fresh",
            "similarity": 0.69,
            "metadata": {"created_at": "2026-06-30T12:00:00", "doc_type": "note"},
        },
    ]

    reranked = mmrag._apply_recency_rerank(results, enabled=True, now=now)

    assert [result["id"] for result in reranked] == ["authoritative", "fresh-but-weaker"]


def test_recency_constants_are_overridable_via_env(monkeypatch):
    monkeypatch.setenv("MMRAG_RECENCY_TIE_BAND", "0.01")
    monkeypatch.setenv("MMRAG_RECENCY_MAX_LIFT", "0.02")
    monkeypatch.setenv("MMRAG_AUTHORITATIVE_SIM", "0.8")

    reloaded = importlib.reload(mmrag)
    assert reloaded.RECENCY_TIE_BAND == 0.01
    assert reloaded.RECENCY_MAX_LIFT == 0.02
    assert reloaded.AUTHORITATIVE_SIM == 0.8

    monkeypatch.delenv("MMRAG_RECENCY_TIE_BAND")
    monkeypatch.delenv("MMRAG_RECENCY_MAX_LIFT")
    monkeypatch.delenv("MMRAG_AUTHORITATIVE_SIM")
    importlib.reload(reloaded)
