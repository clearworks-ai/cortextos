from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

MID = "01M1MW2GAZ1DQ0C6PG3KJ557JA"
# G0a F-2: the real production vault's FR-006 Alloi seed — three nodes, all
# delivery_state: active — verified against
# /Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/org-brain/projects/alloi-0{1,2,3}.md
REAL_PROD_CRM_DIR = Path("/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm")


def _seed_source_vault(tmp_path: Path) -> tuple[Path, Path]:
    vault = tmp_path / "vault"
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    proj.mkdir(parents=True)
    (proj / "alloi-01.md").write_text(
        "# Client: Alloi — Managed Services\n\n## Node\nid: alloi-01\nkind: engagement\n"
        "client: alloi\nparent:\ntitle: Managed Services\ndomains: alloi.us\ndelivery_state: active\n\n"
        "## Reporting\ncadence: weekly\nchannel: email\ncontact: marcos@alloi.us\nlast_update:\n\n"
        "## History (dated, newest first)\n\n## Open Items\n",
        encoding="utf-8",
    )
    (proj / "alloi-02.md").write_text(
        "# Client: Alloi — 10-Hour IT Block\n\n## Node\nid: alloi-02\nkind: engagement\n"
        "client: alloi\nparent:\ntitle: 10-Hour IT Block\ndomains: alloi.us\ndelivery_state: active\n\n"
        "## Reporting\ncadence:\nchannel:\ncontact:\nlast_update:\n\n"
        "## History (dated, newest first)\n\n## Open Items\n",
        encoding="utf-8",
    )
    (proj / "alloi-03.md").write_text(
        "# Client: Alloi — Tactical Reports\n\n## Node\nid: alloi-03\nkind: project\n"
        "client: alloi\nparent: alloi-01\ntitle: Tactical Reports\n"
        "aliases: tacticals, tactical report, arch tactical\ndomains: alloi.us\n"
        "delivery_state: active\n\n## History (dated, newest first)\n\n## Open Items\n",
        encoding="utf-8",
    )
    clients = vault / "raw/areas/clearworks/org-brain/clients"
    clients.mkdir(parents=True)
    (clients / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n\n"
        "## History (dated, newest first)\n\n## Open Items\n",
        encoding="utf-8",
    )
    orgs = vault / "raw/areas/clearworks/org-brain/orgs"
    orgs.mkdir(parents=True)
    (orgs / "_template.md").write_text(
        "# <Name>\n\nkind:\nrelationship:\ncreated_from:\nconfidence:\ndomains:\nemails:\n\n"
        "## Contacts\n\n## Current state\n\n## History (dated, newest first)\n\n## Open Items\n",
        encoding="utf-8",
    )
    env_dir = vault / "raw/media/transcripts/fireflies" / MID
    env_dir.mkdir(parents=True)
    envelope = {
        "schema": "brain.source/1", "source": {"kind": "fireflies", "id": MID},
        "title": "Alloi Tacticals Troubleshooting", "occurred_at": "2026-09-04T17:00:00Z", "duration_s": 900,
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
    # F18 (CH-17): the already-fetched short-circuit requires a coherent envelope
    # (source.json + source.sha256 + meta.json); make_variant copies the tree as-is.
    (env_dir / "meta.json").write_text(
        json.dumps({"fetched_at": "2026-09-04T17:00:00Z", "fetcher": "fetch_fireflies/1"}), encoding="utf-8",
    )
    extraction = {
        "schema": "brain.extraction/1", "inputSha": sha, "promptSha": "p", "model": "sonnet",
        "cost_usd": 0, "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {"org_name": "Alloi", "domain": "alloi.us", "relationship": "client", "confidence": 0.9, "evidence": "Let's ship the tactical report"},
        "summary": {"overview": "Scoped tactical reports.", "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": "Let's ship the tactical report"}],
        "commitments": [], "proposed_delivery_state": None, "deal_state": None, "meeting_type": "delivery",
    }
    (env_dir / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai").mkdir(parents=True)
    (repo / "orgs/clearworksai/secrets.env").write_text("", encoding="utf-8")
    return vault, repo


def _install_traps(tmp_path: Path) -> tuple[Path, Path]:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "trap.log"
    # G0a F-1: `claude` STAYS trapped — it is a genuine negative proof now
    # (extraction.json is kept+restamped by make_variant, so extract_meeting
    # never needs to shell claude at all; if that regresses, this trap
    # makes the failure loud instead of a silent live LLM call).
    for name in ("cortextos", "gws", "claude", "meeting-crm-sync", "meeting-fanout"):
        p = bindir / name
        p.write_text(f'#!/bin/sh\necho TRAPPED "$0 $@" >> "{log}"\nexit 99\n', encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return bindir, log


def _run_dry(vault: Path, repo: Path, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(BRAIN / "run_meeting.py"), "--meeting-id", MID,
         "--repo-root", str(repo), "--vault", str(vault), "--dry-run"],
        capture_output=True, text=True, env=env,
    )


def test_variant_a_dry_run_resolves_to_client_page_no_node(tmp_path: Path) -> None:
    from make_variant import make_variant

    source_vault, repo = _seed_source_vault(tmp_path)
    copy_a = tmp_path / "copy-a"
    make_variant(source_vault=source_vault, dest_vault=copy_a, kind="fireflies", meeting_id=MID, variant="A")
    bindir, log = _install_traps(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"

    r = _run_dry(copy_a, repo, env)
    assert r.returncode == 0, r.stderr + r.stdout
    assert "home=clients/alloi.md node=none rule=3" in r.stdout
    assert not log.exists() or log.read_text(encoding="utf-8").strip() == ""

    # production (source) vault untouched
    assert not (source_vault / "raw/media/transcripts/_state").exists()
    original_node = (source_vault / "raw/areas/clearworks/org-brain/projects/alloi-03.md").read_text(encoding="utf-8")
    assert "tacticals" in original_node


def test_variant_b_dry_run_resolves_to_new_org_zero_prod_writes(tmp_path: Path) -> None:
    from make_variant import make_variant

    source_vault, repo = _seed_source_vault(tmp_path)
    before_files = sorted(p.relative_to(source_vault) for p in source_vault.rglob("*") if p.is_file())
    copy_b = tmp_path / "copy-b"
    make_variant(source_vault=source_vault, dest_vault=copy_b, kind="fireflies", meeting_id=MID, variant="B")
    bindir, log = _install_traps(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"

    r = _run_dry(copy_b, repo, env)
    assert r.returncode == 0, r.stderr + r.stdout
    assert "home=orgs/newco-fixture.md node=none rule=6" in r.stdout
    assert "created=org:newco-fixture" in r.stdout
    assert not log.exists() or log.read_text(encoding="utf-8").strip() == ""

    assert not (source_vault / "raw/media/transcripts/_state").exists()
    # G0a N-2: `_seed_source_vault` already creates raw/.../orgs (the
    # `_template.md` fixture), so asserting it doesn't exist can never pass.
    # Assert the real intent instead: no NEW file (e.g. orgs/newco-fixture.md)
    # landed under the SOURCE vault from variant B's org-creation path.
    after_files = sorted(p.relative_to(source_vault) for p in source_vault.rglob("*") if p.is_file())
    assert after_files == before_files


def test_both_variants_leave_repo_crm_fixture_byte_identical(tmp_path: Path) -> None:
    """G4 acceptance #3 (goal file), invocation half: --dry-run never
    invokes meeting-crm-sync.py or meeting-fanout.py at all (FR-012's own
    dry-run path, unchanged since R1) -- proven here empirically against a
    tmp CRM fixture under --repo-root, since a real production --repo-root
    is never passed to these test invocations at all."""
    source_vault, repo = _seed_source_vault(tmp_path)
    crm_dir = repo / "orgs/clearworksai/agents/crm/crm"
    crm_dir.mkdir(parents=True)
    (crm_dir / "contacts.json").write_text("[]", encoding="utf-8")
    (crm_dir / "interactions.jsonl").write_text("", encoding="utf-8")
    before_contacts = (crm_dir / "contacts.json").stat().st_mtime_ns
    before_interactions_size = (crm_dir / "interactions.jsonl").stat().st_size

    from make_variant import make_variant

    bindir, log = _install_traps(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    for variant, name in (("A", "copy-a2"), ("B", "copy-b2")):
        dest = tmp_path / name
        make_variant(source_vault=source_vault, dest_vault=dest, kind="fireflies", meeting_id=MID, variant=variant)
        r = _run_dry(dest, repo, env)
        assert r.returncode == 0, r.stderr + r.stdout

    assert (crm_dir / "contacts.json").stat().st_mtime_ns == before_contacts
    assert (crm_dir / "interactions.jsonl").stat().st_size == before_interactions_size
    assert not log.exists() or log.read_text(encoding="utf-8").strip() == ""


def test_both_variants_leave_real_production_crm_and_bus_unchanged(tmp_path: Path) -> None:
    """G0a F-10: the goal's own G4 acceptance (3) wording is about
    PRODUCTION contacts.json/interactions.jsonl/bus mtimes+counts, not a
    synthetic tmp fixture -- this test snapshots the REAL files (read-only
    os.stat, never a write) around the two real variant dry-run commands.
    Gracefully skipped (not failed) when the real files/binary aren't
    present in the executing environment, matching _worker_guard's own
    "daemon down, skipped" pattern -- this test can never legitimately fail
    a CI box that has neither the real checkout nor a running daemon."""
    import pytest

    contacts = REAL_PROD_CRM_DIR / "contacts.json"
    interactions = REAL_PROD_CRM_DIR / "interactions.jsonl"
    if not contacts.is_file() or not interactions.is_file():
        pytest.skip("real production CRM files not present in this environment")

    before = {
        "contacts": (contacts.stat().st_mtime_ns, contacts.stat().st_size),
        "interactions": (interactions.stat().st_mtime_ns, interactions.stat().st_size),
    }
    try:
        before_bus = subprocess.run(
            ["cortextos", "bus", "list-tasks", "--status", "pending"],
            capture_output=True, text=True, timeout=5,
        )
        before_pending = len(before_bus.stdout.splitlines()) if before_bus.returncode == 0 else None
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        before_pending = None

    source_vault, repo = _seed_source_vault(tmp_path)
    from make_variant import make_variant

    bindir, log = _install_traps(tmp_path)
    env = os.environ.copy()
    env["PATH"] = f"{bindir}:{env['PATH']}"
    for variant, name in (("A", "copy-a3"), ("B", "copy-b3")):
        dest = tmp_path / name
        make_variant(source_vault=source_vault, dest_vault=dest, kind="fireflies", meeting_id=MID, variant=variant)
        r = _run_dry(dest, repo, env)
        assert r.returncode == 0, r.stderr + r.stdout
    assert not log.exists() or log.read_text(encoding="utf-8").strip() == ""

    after = {
        "contacts": (contacts.stat().st_mtime_ns, contacts.stat().st_size),
        "interactions": (interactions.stat().st_mtime_ns, interactions.stat().st_size),
    }
    assert after == before

    if before_pending is not None:
        # use the REAL, non-trapped PATH for this real read -- the trapped
        # bindir above is never merged into this second env
        after_bus = subprocess.run(
            ["cortextos", "bus", "list-tasks", "--status", "pending"],
            capture_output=True, text=True, timeout=5,
        )
        after_pending = len(after_bus.stdout.splitlines()) if after_bus.returncode == 0 else None
        assert after_pending == before_pending