"""FR-001 fetch_fireflies: envelope + sha256 + meta; exit 2 on fetch fail."""
from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path
from urllib.error import HTTPError

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def _transcript(**over: object) -> dict:
    t = {
        "id": "abc12345zzzz",
        "title": "Tacticals",
        "date": "2026-09-04T17:00:00.000Z",
        "duration": 12.0,
        "organizer_email": "josh@clearworks.ai",
        "participants": ["Josh Weiss"],
        "meeting_attendees": [
            {"displayName": "Josh Weiss", "email": "josh@clearworks.ai"},
            {"displayName": "Marcos", "email": "marcos@alloi.us"},
        ],
        "sentences": [
            {
                "index": i,
                "speaker_name": "Josh Weiss",
                "text": f"hello {i}",
                "start_time": float(i),
            }
            for i in range(20)
        ],
        "summary": {
            "overview": "Talked tacticals.",
            "action_items": "",
            "keywords": "",
            "bullet_gist": "",
            "short_summary": "",
        },
    }
    t.update(over)
    return t


class _Resp:
    def __init__(self, payload: dict) -> None:
        self._raw = json.dumps({"data": {"transcript": payload}}).encode()

    def read(self) -> bytes:
        return self._raw

    def __enter__(self) -> "_Resp":
        return self

    def __exit__(self, *_a: object) -> bool:
        return False


def test_missing_key_exits_2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fetch_fireflies import main

    monkeypatch.delenv("FIREFLIES_API_KEY", raising=False)
    secrets = tmp_path / "orgs/clearworksai/secrets.env"
    secrets.parent.mkdir(parents=True)
    secrets.write_text("OTHER=1\n", encoding="utf-8")
    rc = main(
        [
            "--meeting-id",
            "x",
            "--vault",
            str(tmp_path / "vault"),
            "--repo-root",
            str(tmp_path),
        ]
    )
    assert rc == 2


def test_graphql_errors_exit_2_write_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fetch_fireflies import main

    class Err:
        def read(self) -> bytes:
            return json.dumps({"errors": [{"message": "nope"}], "data": None}).encode()

        def __enter__(self) -> "Err":
            return self

        def __exit__(self, *_a: object) -> bool:
            return False

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: Err())
    vault = tmp_path / "vault"
    rc = main(["--meeting-id", "x", "--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 2
    assert not (vault / "raw/media/transcripts/fireflies/x/source.json").exists()


def test_short_transcript_exits_2_unless_allow_short(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fetch_fireflies import main

    short = _transcript(sentences=[{"index": 0, "speaker_name": "A", "text": "hi", "start_time": 0}])
    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: _Resp(short))
    vault = tmp_path / "vault"
    rc = main(["--meeting-id", "abc12345zzzz", "--vault", str(vault)])
    assert rc == 2
    env_dir = vault / "raw/media/transcripts/fireflies/abc12345zzzz"
    assert not (env_dir / "source.json").exists()
    rc2 = main(["--meeting-id", "abc12345zzzz", "--vault", str(vault), "--allow-short"])
    assert rc2 == 0
    assert (env_dir / "source.json").is_file()


def test_iso_from_fireflies_date_variants() -> None:
    from datetime import datetime, timezone

    from fetch_fireflies import _iso_from_fireflies_date

    ms = 1788548400000
    expected = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")
    assert _iso_from_fireflies_date(ms) == expected
    assert _iso_from_fireflies_date(str(ms)) == expected
    assert _iso_from_fireflies_date("2026-09-04T17:00:00.000Z") == "2026-09-04T17:00:00.000Z"
    assert _iso_from_fireflies_date(None) is None


def test_envelope_converts_epoch_ms_date() -> None:
    from datetime import datetime, timezone

    from fetch_fireflies import envelope_from_transcript

    ms = 1788548400000
    tr = _transcript(date=ms)
    env = envelope_from_transcript(tr)
    expected = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")
    assert env["occurred_at"] == expected


def test_spoke_matching_is_case_insensitive() -> None:
    from fetch_fireflies import envelope_from_transcript

    tr = _transcript(
        meeting_attendees=[{"displayName": "Joseph Chang", "email": "joseph@example.com"}],
        sentences=[{"index": 0, "speaker_name": "joseph chang", "text": "hi", "start_time": 0.0}],
    )
    env = envelope_from_transcript(tr)
    part = next(p for p in env["participants"] if p["email"] == "joseph@example.com")
    assert part["spoke"] is True


def test_writes_canonical_envelope_and_skips_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from fetch_fireflies import main

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: _Resp(_transcript()))
    vault = tmp_path / "vault"
    mid = "abc12345zzzz"
    rc = main(["--meeting-id", mid, "--vault", str(vault)])
    assert rc == 0
    env_dir = vault / "raw/media/transcripts/fireflies" / mid
    raw = (env_dir / "source.json").read_bytes()
    assert raw == json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    envelope = json.loads(raw)
    assert envelope["schema"] == "brain.source/1"
    sha = hashlib.sha256(raw).hexdigest()
    assert (env_dir / "source.sha256").read_text(encoding="utf-8").strip() == sha
    meta = json.loads((env_dir / "source.json").with_name("meta.json").read_text(encoding="utf-8"))
    assert "fetched_at" in meta
    first = capsys.readouterr().out.strip()
    assert sha in first
    # second run does not overwrite
    (env_dir / "source.json").write_bytes(raw + b"")
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not refetch")),
    )
    rc2 = main(["--meeting-id", mid, "--vault", str(vault)])
    assert rc2 == 0
    assert capsys.readouterr().out.strip() == sha


def test_load_enabled_agents_returns_enabled_names_only(tmp_path: Path) -> None:
    from paths import load_enabled_agents

    roster = tmp_path / "enabled-agents.json"
    roster.write_text(
        json.dumps({"larry": {"enabled": True, "status": "configured"}, "frank2": {"enabled": False}}),
        encoding="utf-8",
    )
    assert load_enabled_agents(roster) == {"larry"}


def test_load_enabled_agents_missing_file_returns_empty_set(tmp_path: Path) -> None:
    from paths import load_enabled_agents

    assert load_enabled_agents(tmp_path / "nope.json") == set()


def test_load_enabled_agents_unparseable_returns_empty_set(tmp_path: Path) -> None:
    from paths import load_enabled_agents

    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert load_enabled_agents(bad) == set()


def test_load_enabled_agents_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from paths import load_enabled_agents

    roster = tmp_path / "enabled-agents.json"
    roster.write_text(json.dumps({"scout": {"enabled": True}}), encoding="utf-8")
    monkeypatch.setenv("BRAIN_ENABLED_AGENTS_JSON", str(roster))
    assert load_enabled_agents() == {"scout"}


def test_enabled_fleet_agent_speaker_is_side_ours(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D-08/D-17: an enabled fleet-agent name (not a Josh alias, not clearworks.ai
    domain) still resolves side=ours; a disabled one with an external domain does not."""
    from fetch_fireflies import envelope_from_transcript

    roster = tmp_path / "enabled-agents.json"
    roster.write_text(
        json.dumps({"larry": {"enabled": True}, "frank2": {"enabled": False}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("BRAIN_ENABLED_AGENTS_JSON", str(roster))
    tr = _transcript(
        meeting_attendees=[
            {"displayName": "Larry", "email": "larry@example.com"},
            {"displayName": "Frank2", "email": "frank2@example.com"},
        ],
    )
    env = envelope_from_transcript(tr)
    larry = next(p for p in env["participants"] if p["email"] == "larry@example.com")
    frank2 = next(p for p in env["participants"] if p["email"] == "frank2@example.com")
    assert larry["side"] == "ours"
    assert frank2["side"] == "theirs"


def test_missing_roster_speaker_side_defaults_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Roster file missing -> empty enabled set, never raises; behavior unchanged."""
    from fetch_fireflies import envelope_from_transcript

    monkeypatch.setenv("BRAIN_ENABLED_AGENTS_JSON", str(tmp_path / "does-not-exist.json"))
    tr = _transcript(
        meeting_attendees=[{"displayName": "Larry", "email": "larry@example.com"}],
    )
    env = envelope_from_transcript(tr)
    larry = next(p for p in env["participants"] if p["email"] == "larry@example.com")
    assert larry["side"] == "theirs"


def test_speaker_only_participants_appended_in_first_appearance_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """F-4: nondeterministic set iteration order must not leak into participant
    order — speaker-only participants are appended in first-appearance order over
    `sentences`, independent of hash-seed/set ordering."""
    from fetch_fireflies import envelope_from_transcript

    sentences = [
        {"index": 0, "speaker_name": "Zed", "text": "a", "start_time": 0.0},
        {"index": 1, "speaker_name": "Amy", "text": "b", "start_time": 1.0},
        {"index": 2, "speaker_name": "Mona", "text": "c", "start_time": 2.0},
        {"index": 3, "speaker_name": "Zed", "text": "d", "start_time": 3.0},
        {"index": 4, "speaker_name": "Amy", "text": "e", "start_time": 4.0},
    ]
    tr = _transcript(meeting_attendees=[], sentences=sentences)
    env = envelope_from_transcript(tr)
    names = [p["name"] for p in env["participants"]]
    assert names == ["Zed", "Amy", "Mona"]

    # Shuffled input order must still yield the same first-appearance order and
    # byte-identical canonical output (envelope sha stability across processes).
    shuffled = [sentences[2], sentences[0], sentences[4], sentences[3], sentences[1]]
    tr2 = _transcript(meeting_attendees=[], sentences=shuffled)
    env2 = envelope_from_transcript(tr2)
    names2 = [p["name"] for p in env2["participants"]]
    assert names2 == ["Mona", "Zed", "Amy"]


def test_path_traversal_meeting_id_rejected_exit_64(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from fetch_fireflies import main

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("must not make network call")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    vault = tmp_path / "vault"
    rc = main(["--meeting-id", "../../target", "--vault", str(vault)])
    assert rc == 64
    assert "invalid meeting id" in capsys.readouterr().err
    assert not vault.exists() or not any(vault.rglob("source.json"))
    # M2 (Spec M-3): the exit-64 usage error is refused before any envelope
    # dir even exists — it must never leave a fetch-error.json behind.
    assert not vault.exists() or not any(vault.rglob("fetch-error.json"))


# --- R4 (FR-015): list query + backoff -------------------------------------
import io as _io
import json as _json
import urllib.error as _uerr
import urllib.request as _ureq


class _RawResp:  # the file already defines a _Resp that wraps {'data': {'transcript': …}}; this one dumps the payload raw
    def __init__(self, payload):
        self._raw = _json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _page(ids):
    return {"data": {"transcripts": [
        {"id": i, "title": f"T {i}", "date": 1756684800000 + n, "duration": 12.5, "participants": ["a@x.io"]}
        for n, i in enumerate(ids)]}}


def test_list_transcripts_pages_until_short_page_and_throttles(monkeypatch):
    import fetch_fireflies as ff

    calls = []
    pages = [_page([f"id{n}" for n in range(50)]), _page([f"id{n}" for n in range(50, 100)]), _page(["id100"])]

    def fake_urlopen(req, timeout=0):
        body = _json.loads(req.data.decode())
        calls.append(body["variables"])
        return _RawResp(pages[len(calls) - 1])

    slept = []
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(ff, "_sleep", lambda s: slept.append(s))
    rows = ff.list_transcripts("key", throttle_s=2.0)
    assert [r["id"] for r in rows][:3] == ["id0", "id1", "id2"] and len(rows) == 101
    assert calls == [{"limit": 50, "skip": 0}, {"limit": 50, "skip": 50}, {"limit": 50, "skip": 100}]
    assert slept == [2.0, 2.0]  # throttle between pages, not after the last


def test_post_query_backs_off_on_429_then_succeeds(monkeypatch):
    import fetch_fireflies as ff

    attempts = []

    def fake_urlopen(req, timeout=0):
        attempts.append(1)
        if len(attempts) < 3:
            raise _uerr.HTTPError(ff.GRAPHQL_URL, 429, "Too Many Requests", {}, _io.BytesIO(b""))
        return _RawResp({"data": {"transcript": {"id": "X"}}})

    slept = []
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(ff, "_sleep", lambda s: slept.append(s))
    payload = ff._post_query("key", ff.QUERY, {"id": "X"})
    assert payload["data"]["transcript"]["id"] == "X"
    assert slept == [1, 2]


def test_post_query_gives_up_after_three_retries_on_5xx(monkeypatch):
    import fetch_fireflies as ff
    import pytest

    def fake_urlopen(req, timeout=0):
        raise _uerr.HTTPError(ff.GRAPHQL_URL, 503, "Service Unavailable", {}, _io.BytesIO(b""))

    slept = []
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(ff, "_sleep", lambda s: slept.append(s))
    with pytest.raises(_uerr.HTTPError) as exc:
        ff._post_query("key", ff.QUERY, {"id": "X"})
    assert exc.value.code == 503 and slept == [1, 2, 4]


def test_post_query_does_not_retry_401(monkeypatch):
    import fetch_fireflies as ff
    import pytest

    def fake_urlopen(req, timeout=0):
        raise _uerr.HTTPError(ff.GRAPHQL_URL, 401, "Unauthorized", {}, _io.BytesIO(b""))

    slept = []
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(ff, "_sleep", lambda s: slept.append(s))
    with pytest.raises(_uerr.HTTPError):
        ff._post_query("key", ff.QUERY, {"id": "X"})
    assert slept == []


def test_list_transcripts_raises_on_graphql_errors(monkeypatch):
    import fetch_fireflies as ff
    import pytest

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp({"errors": [{"message": "Unauthorized"}]}))
    with pytest.raises(ff.FirefliesListError) as exc:
        ff.list_transcripts("key")
    assert "Unauthorized" in str(exc.value)


# --- R4 (FR-017 slice, G-109/G-125): fetch-error.json --------------------------
def _fe(vault, mid):
    p = vault / "raw/media/transcripts/_state" / f"fireflies-{mid}" / "fetch-error.json"
    return _json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def test_fetch_error_missing_api_key_is_auth(tmp_path, monkeypatch):
    import fetch_fireflies as ff

    monkeypatch.delenv("FIREFLIES_API_KEY", raising=False)
    repo = tmp_path / "repo"; (repo / "orgs/clearworksai").mkdir(parents=True)
    (repo / "orgs/clearworksai/secrets.env").write_text("OTHER=1\n", encoding="utf-8")
    vault = tmp_path / "vault"
    assert ff.main(["--meeting-id", "FE1", "--vault", str(vault), "--repo-root", str(repo)]) == 2
    doc = _fe(vault, "FE1")
    assert doc["class"] == "auth" and doc["status"] is None and "FIREFLIES_API_KEY" in doc["message"]


def test_fetch_error_http_status_classes(tmp_path, monkeypatch):
    import fetch_fireflies as ff

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr(ff, "_sleep", lambda s: None)
    vault = tmp_path / "vault"
    for code, cls in ((401, "auth"), (403, "auth"), (429, "rate_limit"), (502, "server"), (418, "server")):
        def fake_urlopen(req, timeout=0, code=code):
            raise _uerr.HTTPError(ff.GRAPHQL_URL, code, "x", {}, _io.BytesIO(b""))
        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
        assert ff.main(["--meeting-id", f"FE{code}", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 2
        doc = _fe(vault, f"FE{code}")
        assert (doc["class"], doc["status"]) == (cls, code), code


def test_fetch_error_network_graphql_and_not_ready(tmp_path, monkeypatch):
    import fetch_fireflies as ff

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    vault = tmp_path / "vault"

    def net(req, timeout=0):
        raise _uerr.URLError("dns")
    monkeypatch.setattr("urllib.request.urlopen", net)
    assert ff.main(["--meeting-id", "NET", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 2
    assert _fe(vault, "NET")["class"] == "network"

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp({"errors": [{"message": "Not authorized"}]}))
    assert ff.main(["--meeting-id", "GQA", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 2
    assert _fe(vault, "GQA")["class"] == "auth"

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp({"errors": [{"message": "Internal"}]}))
    assert ff.main(["--meeting-id", "GQS", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 2
    assert _fe(vault, "GQS")["class"] == "server"

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp({"data": {"transcript": None}}))
    assert ff.main(["--meeting-id", "NOTR", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 2
    assert _fe(vault, "NOTR")["class"] == "not_ready"

    short = {"data": {"transcript": {"id": "SHORT", "title": "t", "date": 1756684800000, "duration": None,
                                     "sentences": [], "participants": [], "meeting_attendees": [], "summary": {}}}}
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp(short))
    assert ff.main(["--meeting-id", "SHORT", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 2
    assert _fe(vault, "SHORT")["class"] == "not_ready"


def test_already_fetched_short_circuit_clears_stale_fetch_error(tmp_path):
    import fetch_fireflies as ff

    vault = tmp_path / "vault"
    env = vault / "raw/media/transcripts/fireflies/SC1"; env.mkdir(parents=True)
    # F18 (CH-17): a coherent envelope — all three of source.json,
    # source.sha256 and meta.json — is what makes this short-circuit valid;
    # see test_incoherent_envelope_falls_through_to_fresh_fetch below for
    # the source.json-only (partial-write) case.
    (env / "source.json").write_bytes(b"{}")
    (env / "source.sha256").write_text(hashlib.sha256(b"{}").hexdigest() + "\n", encoding="utf-8")
    (env / "meta.json").write_text(json.dumps({"fetched_at": "x", "fetcher": "y"}), encoding="utf-8")
    ff.write_fetch_error(vault, "fireflies", "SC1", "auth", status=401, message="old")
    assert ff.main(["--meeting-id", "SC1", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 0
    assert _fe(vault, "SC1") is None


def test_incoherent_envelope_falls_through_to_fresh_fetch(tmp_path, monkeypatch):
    """F18 (CH-17): source.json existing alone (source.sha256/meta.json
    missing — a crash between the three atomic writes, each independent)
    is NOT proof of a coherent envelope; the short-circuit must fall
    through to a fresh fetch, which rewrites all three."""
    import fetch_fireflies as ff

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    vault = tmp_path / "vault"
    env = vault / "raw/media/transcripts/fireflies/INCO"; env.mkdir(parents=True)
    (env / "source.json").write_bytes(b"{}")  # source.sha256, meta.json missing
    ok = {"data": {"transcript": {"id": "INCO", "title": "t", "date": 1756684800000, "duration": 12.0,
                                  "organizer_email": "josh@clearworks.ai", "participants": ["a@x.io"],
                                  "meeting_attendees": [{"displayName": "A", "email": "a@x.io"}],
                                  "sentences": [{"index": i, "speaker_name": "A", "text": f"s{i}", "start_time": i} for i in range(25)],
                                  "summary": {"overview": "o"}}}}
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp(ok))
    rc = ff.main(["--meeting-id", "INCO", "--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 0
    assert (env / "source.sha256").is_file() and (env / "meta.json").is_file()


def test_stale_sha_sidecar_falls_through_to_fresh_fetch(tmp_path, monkeypatch):
    """B5 (G2b r2 CH-17, "not fixed" by existence-only coherence): all three
    files exist, but source.sha256 does not actually match sha256(source.json)
    — e.g. a --refetch that rewrote source.json's bytes but crashed before
    the sidecar was rewritten, or a hand-edit. Existence alone must not
    short-circuit; the mismatch must fall through to a fresh fetch, which
    rewrites the sidecar to match."""
    import fetch_fireflies as ff

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    vault = tmp_path / "vault"
    env = vault / "raw/media/transcripts/fireflies/STALE"; env.mkdir(parents=True)
    (env / "source.json").write_bytes(b"{}")
    (env / "source.sha256").write_text("f" * 64 + "\n", encoding="utf-8")  # wrong on purpose
    (env / "meta.json").write_text(json.dumps({"fetched_at": "x", "fetcher": "y"}), encoding="utf-8")
    ok = {"data": {"transcript": {"id": "STALE", "title": "t", "date": 1756684800000, "duration": 12.0,
                                  "organizer_email": "josh@clearworks.ai", "participants": ["a@x.io"],
                                  "meeting_attendees": [{"displayName": "A", "email": "a@x.io"}],
                                  "sentences": [{"index": i, "speaker_name": "A", "text": f"s{i}", "start_time": i} for i in range(25)],
                                  "summary": {"overview": "o"}}}}
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp(ok))
    rc = ff.main(["--meeting-id", "STALE", "--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 0
    new_raw = (env / "source.json").read_bytes()
    assert (env / "source.sha256").read_text(encoding="utf-8").strip() == hashlib.sha256(new_raw).hexdigest()


def test_unparseable_meta_json_falls_through_to_fresh_fetch(tmp_path, monkeypatch):
    """B5 (G2b r2 CH-17): meta.json existing but not parsing as JSON must
    also fall through — existence of the file is not proof it's coherent."""
    import fetch_fireflies as ff

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    vault = tmp_path / "vault"
    env = vault / "raw/media/transcripts/fireflies/BADMETA"; env.mkdir(parents=True)
    raw = b"{}"
    (env / "source.json").write_bytes(raw)
    (env / "source.sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n", encoding="utf-8")
    (env / "meta.json").write_text("not json{{{", encoding="utf-8")
    ok = {"data": {"transcript": {"id": "BADMETA", "title": "t", "date": 1756684800000, "duration": 12.0,
                                  "organizer_email": "josh@clearworks.ai", "participants": ["a@x.io"],
                                  "meeting_attendees": [{"displayName": "A", "email": "a@x.io"}],
                                  "sentences": [{"index": i, "speaker_name": "A", "text": f"s{i}", "start_time": i} for i in range(25)],
                                  "summary": {"overview": "o"}}}}
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp(ok))
    rc = ff.main(["--meeting-id", "BADMETA", "--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 0
    assert json.loads((env / "meta.json").read_text(encoding="utf-8"))["fetcher"] == ff.FETCHER_VERSION


def test_fetch_success_clears_stale_fetch_error(tmp_path, monkeypatch):
    import fetch_fireflies as ff

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    vault = tmp_path / "vault"
    ff.write_fetch_error(vault, "fireflies", "OK1", "server", status=500, message="old")
    assert _fe(vault, "OK1")["class"] == "server"
    ok = {"data": {"transcript": {"id": "OK1", "title": "t", "date": 1756684800000, "duration": 12.0,
                                  "organizer_email": "josh@clearworks.ai", "participants": ["a@x.io"],
                                  "meeting_attendees": [{"displayName": "A", "email": "a@x.io"}],
                                  "sentences": [{"index": i, "speaker_name": "A", "text": f"s{i}", "start_time": i} for i in range(25)],
                                  "summary": {"overview": "o"}}}}
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: _RawResp(ok))
    assert ff.main(["--meeting-id", "OK1", "--vault", str(vault), "--repo-root", str(tmp_path)]) == 0
    assert _fe(vault, "OK1") is None
