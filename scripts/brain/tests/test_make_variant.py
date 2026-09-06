from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

MID = "01M1MW2GAZ1DQ0C6PG3KJ557JA"


def _seed_source_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    proj.mkdir(parents=True)
    (proj / "alloi-03.md").write_text(
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\nkind: project\n"
        "client: alloi\nparent: alloi-01\ntitle: Tactical Reports\n"
        "aliases: tacticals, tactical report, arch tactical\ndomains: alloi.us\n"
        "delivery_state: active\n",
        encoding="utf-8",
    )
    env_dir = vault / "raw/media/transcripts/fireflies" / MID
    env_dir.mkdir(parents=True)
    envelope = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": MID},
        "title": "Alloi Tacticals Troubleshooting",
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 900,
        "participants": [
            {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Marcos", "email": "marcos@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
        ],
        "text_units": [{"i": 0, "speaker": "Marcos", "text": "Let's ship the tactical report", "ts": 0}],
        "native_summary": {},
    }
    raw = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (env_dir / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (env_dir / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    (env_dir / "extraction.json").write_text(
        json.dumps({
            "schema": "brain.extraction/1", "inputSha": sha, "promptSha": "p", "model": "sonnet",
            "cost_usd": 0, "extracted_at": "2026-09-05T00:00:00Z",
            "classification": {"org_name": "Alloi", "domain": "alloi.us", "relationship": "client", "confidence": 0.9, "evidence": "Let's ship the tactical report"},
            "summary": {"overview": "x", "bullets": []}, "decisions": [], "commitments": [],
            "proposed_delivery_state": None, "deal_state": None, "meeting_type": "delivery",
        }),
        encoding="utf-8",
    )
    for name in ("validated.json", "resolution.json", "event.json"):
        (env_dir / name).write_text("{}", encoding="utf-8")
    state_dir = vault / "raw/media/transcripts/_state" / f"fireflies-{MID}"
    state_dir.mkdir(parents=True)
    (state_dir / "receipt.json").write_text("{}", encoding="utf-8")
    return vault


def test_variant_a_strips_aliases_keeps_extraction_recomputes_sha(tmp_path: Path) -> None:
    from make_variant import make_variant

    source_vault = _seed_source_vault(tmp_path)
    dest = tmp_path / "copy-a"
    sha = make_variant(source_vault=source_vault, dest_vault=dest, kind="fireflies", meeting_id=MID, variant="A")

    node_text = (dest / "raw/areas/clearworks/org-brain/projects/alloi-03.md").read_text(encoding="utf-8")
    assert "aliases:\n" in node_text or node_text.rstrip().endswith("aliases:")
    assert "tacticals" not in node_text

    env_dir = dest / "raw/media/transcripts/fireflies" / MID
    env_path = env_dir / "source.json"
    assert hashlib.sha256(env_path.read_bytes()).hexdigest() == sha
    assert not (dest / "raw/media/transcripts/_state" / f"fireflies-{MID}").exists()
    # G0a F-1: extraction.json is KEPT (not a derived artifact), the other
    # true derived artifacts ARE deleted
    extraction = json.loads((env_dir / "extraction.json").read_text(encoding="utf-8"))
    assert extraction["inputSha"] == sha  # variant A doesn't change envelope bytes -> unchanged sha, but restamped anyway
    assert extraction["variant"] is True
    for name in ("validated.json", "resolution.json", "event.json"):
        assert not (env_dir / name).exists()

    # source vault (production stand-in) is untouched
    source_node = (source_vault / "raw/areas/clearworks/org-brain/projects/alloi-03.md").read_text(encoding="utf-8")
    assert "tacticals" in source_node
    assert (source_vault / "raw/media/transcripts/_state" / f"fireflies-{MID}").exists()
    source_extraction = json.loads((source_vault / "raw/media/transcripts/fireflies" / MID / "extraction.json").read_text(encoding="utf-8"))
    assert "variant" not in source_extraction


def test_variant_b_replaces_alloi_domain_participants_and_restamps_extraction(tmp_path: Path) -> None:
    from make_variant import make_variant

    source_vault = _seed_source_vault(tmp_path)
    dest = tmp_path / "copy-b"
    sha = make_variant(source_vault=source_vault, dest_vault=dest, kind="fireflies", meeting_id=MID, variant="B")

    env_dir = dest / "raw/media/transcripts/fireflies" / MID
    envelope = json.loads((env_dir / "source.json").read_text(encoding="utf-8"))
    emails = [p["email"] for p in envelope["participants"]]
    assert "marcos@alloi.us" not in emails
    assert "sam@newco-fixture.test" in emails
    assert "josh@clearworks.ai" in emails  # non-alloi.us participant untouched

    # G0a F-1: Variant B's participant rewrite changes source.json's bytes,
    # so the kept extraction.json's inputSha MUST be restamped to the new
    # sha or extract_meeting.py would shell a live `claude` call.
    extraction = json.loads((env_dir / "extraction.json").read_text(encoding="utf-8"))
    assert extraction["inputSha"] == sha
    assert extraction["variant"] is True


def test_make_variant_rejects_unknown_variant(tmp_path: Path) -> None:
    import pytest
    from make_variant import make_variant

    source_vault = _seed_source_vault(tmp_path)
    with pytest.raises(ValueError):
        make_variant(source_vault=source_vault, dest_vault=tmp_path / "copy-c", kind="fireflies", meeting_id=MID, variant="C")


def test_make_variant_refuses_dest_equals_source(tmp_path: Path) -> None:
    import pytest
    from make_variant import UnsafeDestinationError, make_variant

    source_vault = _seed_source_vault(tmp_path)
    with pytest.raises(UnsafeDestinationError):
        make_variant(source_vault=source_vault, dest_vault=source_vault, kind="fireflies", meeting_id=MID, variant="A")
    # nothing was deleted from the "destination" (== source)
    assert (source_vault / "raw/media/transcripts/_state" / f"fireflies-{MID}").exists()


def test_make_variant_refuses_dest_inside_source(tmp_path: Path) -> None:
    import pytest
    from make_variant import UnsafeDestinationError, make_variant

    source_vault = _seed_source_vault(tmp_path)
    with pytest.raises(UnsafeDestinationError):
        make_variant(source_vault=source_vault, dest_vault=source_vault / "nested-copy", kind="fireflies", meeting_id=MID, variant="A")
    assert not (source_vault / "nested-copy").exists()


def test_make_variant_refuses_source_inside_dest(tmp_path: Path) -> None:
    import pytest
    from make_variant import UnsafeDestinationError, make_variant

    source_vault = _seed_source_vault(tmp_path)
    dest = source_vault.parent  # source_vault is itself a child of dest
    with pytest.raises(UnsafeDestinationError):
        make_variant(source_vault=source_vault, dest_vault=dest, kind="fireflies", meeting_id=MID, variant="A")
    # dest (source_vault.parent == tmp_path) was never rmtree'd — source
    # vault, still inside it, survives untouched
    assert (source_vault / "raw/media/transcripts/_state" / f"fireflies-{MID}").exists()


def test_make_variant_refuses_protected_vault_destination(tmp_path: Path, monkeypatch) -> None:
    import pytest
    import make_variant as mv
    from make_variant import UnsafeDestinationError, make_variant

    fake_protected = tmp_path / "protected-knowledge-sync"
    fake_protected.mkdir()
    monkeypatch.setattr(mv, "PROTECTED_VAULTS", (fake_protected,))
    source_vault = _seed_source_vault(tmp_path)
    with pytest.raises(UnsafeDestinationError):
        make_variant(source_vault=source_vault, dest_vault=fake_protected / "copy", kind="fireflies", meeting_id=MID, variant="A")
    assert list(fake_protected.iterdir()) == []  # nothing written under it


def test_make_variant_default_protected_vaults_names_real_knowledge_sync() -> None:
    from make_variant import PROTECTED_VAULTS

    assert any(str(p) == "/Users/joshweiss/code/knowledge-sync" for p in PROTECTED_VAULTS)
