"""FR-012 run_meeting --dry-run: apply refused; no gws/bus; diffs + reason line."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_apply_exits_64() -> None:
    from run_meeting import main

    assert main(["--meeting-id", "x", "--apply"]) == 15  # R2: d09-signed gate (FR-012 sign-check)
    assert main(["--meeting-id", "x"]) == 64
    assert main(["--meeting-id", "fireflies:../etc/passwd", "--dry-run"]) == 64


def _seed(tmp_path: Path) -> tuple[Path, Path, str]:
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n\n## History (dated, newest first)\n\n- old\n",
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-03.md").write_text(
        """# Client: Alloi — Tactical Reports

## Node
id: alloi-03
kind: project
client: alloi
parent: alloi-01
title: Tactical Reports
aliases: tacticals, tactical report, arch tactical
domains: alloi.us
delivery_state: active

## History (dated, newest first)

- old

## Open Items
""",
        encoding="utf-8",
    )
    mid = "01M1MW2GAZ1DQ0C6PG3KJ557JA"
    env = vault / "raw/media/transcripts/fireflies" / mid
    env.mkdir(parents=True)
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": mid},
        "title": "Weekly tacticals review",
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 12,
        "participants": [
            {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Marcos", "email": "marcos@alloi.us", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            # F-1 FINAL review fixture: a real external speaker with no email.
            # FR-004 fills a bare NAME string for them in fanout-meeting.json's
            # attendees; event.json's attendees (email-only, FR-004) omits them
            # entirely. The dry-run "crm interaction rows:" count must stay at
            # 1 (Marcos only) — this participant must never appear as a row.
            {"name": "Sam Speaker", "email": "", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
        ],
        "text_units": [{"i": 0, "speaker": "Marcos", "text": "hello tacticals", "ts": 0}],
        "native_summary": {"overview": "hello tacticals"},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (env / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (env / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    extraction = {
        "schema": "brain.extraction/1",
        "inputSha": sha,
        "promptSha": "p",
        "model": "sonnet",
        "cost_usd": 0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {
            "org_name": "Alloi",
            "domain": "alloi.us",
            "relationship": "client",
            "confidence": 0.9,
            "evidence": "hello tacticals",
        },
        "summary": {"overview": "hello tacticals", "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": "hello"}],
        "commitments": [
            {
                "text": "Ship dry-run",
                "owner_participant": 0,
                "owner_name": "Josh Weiss",
                "deadline_iso": "2026-12-01",
                "quote": "hello",
            }
        ],
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
    }
    (env / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text('{"contacts":[]}', encoding="utf-8")
    return vault, repo, mid


def test_dry_run_prints_nouns_and_diffs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    from run_meeting import main

    vault, repo, mid = _seed(tmp_path)
    trap = tmp_path / "trap"
    trap.mkdir()
    for name in ("gws", "bus", "meeting-crm-sync", "meeting-fanout"):
        p = trap / name
        p.write_text("#!/bin/sh\necho TRAPPED \"$0\" >> \"$TRAP_LOG\"\n", encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "trap.log"
    monkeypatch.setenv("TRAP_LOG", str(log))
    monkeypatch.setenv("PATH", str(trap) + os.pathsep + os.environ.get("PATH", ""))

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr("run_meeting.fetch_main", fake_fetch)
    monkeypatch.setattr("run_meeting.extract_main", fake_extract)
    rc = main(
        [
            "--meeting-id",
            f"fireflies:{mid}",
            "--dry-run",
            "--repo-root",
            str(repo),
            "--vault",
            str(vault),
        ]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert "home=" in out and "node=alloi-03" in out and "rule=2" in out
    assert "created=" in out and "promotion=" in out
    assert "---" in out and "+++" in out
    assert "meetings/" in out
    assert "quotes kept decisions=1 commitments=1" in out
    assert "open_questions=0" in out
    assert "crm interaction rows:" in out
    # F-1 FINAL review: the fixture has 2 external participants but only 1
    # has an email (Marcos; "Sam Speaker" is email-less) — the preview's
    # "crm interaction rows:" count must equal the number of EMAIL attendees,
    # not the number of external participants.
    crm_section = out.split("crm interaction rows:", 1)[1].split("tasks:", 1)[0]
    assert crm_section.count('"contact":') == 1
    assert '"contact": "marcos@alloi.us"' in crm_section
    assert "Sam Speaker" not in crm_section
    assert "Ship dry-run · owner: Josh · due 2026-12-01" in out
    assert "task payloads:" in out
    assert "subject:" in out.lower() or "Recap:" in out
    assert not log.exists() or log.read_text(encoding="utf-8").strip() == ""
    # no progress.json
    assert not (vault / "raw/media/transcripts/_state").exists()


def test_dry_run_node_parse_failure_exits_6_no_phase3_preview(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """G2-P1-1: a malformed ## Node block must fail the dry-run closed —
    exit 6 with 'FAILED at rollup: <reason>' on stderr, and stdout must
    NOT carry the phase-3 preview nouns (no signable preview on failure)."""
    from run_meeting import main

    vault, repo, mid = _seed(tmp_path)
    (vault / "raw/areas/clearworks/org-brain/projects/broken.md").write_text(
        "# Broken\n\n## Node\nid: broken\n",  # missing required kind/client keys
        encoding="utf-8",
    )

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr("run_meeting.fetch_main", fake_fetch)
    monkeypatch.setattr("run_meeting.extract_main", fake_extract)
    rc = main(
        [
            "--meeting-id",
            f"fireflies:{mid}",
            "--dry-run",
            "--repo-root",
            str(repo),
            "--vault",
            str(vault),
        ]
    )
    assert rc == 6
    captured = capsys.readouterr()
    assert "FAILED at rollup:" in captured.err
    assert "would-touch:" not in captured.out
    assert "would-write:" not in captured.out
    assert "would-file:" not in captured.out


def _fake_binary(tmp_path: Path, name: str, rc: int, stderr_msg: str) -> Path:
    script = tmp_path / name
    script.write_text(
        f"import sys\nsys.stderr.write({stderr_msg!r} + \"\\n\")\nsys.exit({rc})\n",
        encoding="utf-8",
    )
    return script


def _run_dry_with_fake_fetch_extract(monkeypatch: pytest.MonkeyPatch, mid: str, repo: Path, vault: Path):
    from run_meeting import main

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr("run_meeting.fetch_main", fake_fetch)
    monkeypatch.setattr("run_meeting.extract_main", fake_extract)
    return main(
        ["--meeting-id", f"fireflies:{mid}", "--dry-run", "--repo-root", str(repo), "--vault", str(vault)]
    )


@pytest.mark.parametrize("wb_rc", [1, 64])
def test_dry_run_writeback_failure_exits_7_with_stderr_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys, wb_rc: int
) -> None:
    """CH-8: _run_dry previously returned the writeback dry-run subprocess's
    OWN raw exit code (1, 64, ...) instead of the FR-012 exit-code table's
    fixed 7 — exactly the leak --apply's writeback path already closed."""
    import run_meeting

    vault, repo, mid = _seed(tmp_path)
    fake_wb = _fake_binary(tmp_path, "fake_writeback.py", wb_rc, "writeback dry-run exploded")
    monkeypatch.setattr(run_meeting, "WRITEBACK", fake_wb)

    rc = _run_dry_with_fake_fetch_extract(monkeypatch, mid, repo, vault)
    assert rc == 7
    err = capsys.readouterr().err
    assert f"FAILED at writeback: rc={wb_rc}" in err
    assert "writeback dry-run exploded" in err


@pytest.mark.parametrize("rec_rc", [1, 64])
def test_dry_run_recap_failure_exits_9_with_stderr_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys, rec_rc: int
) -> None:
    """CH-8: same leak on the recap dry-run subprocess — must map to the
    FR-012 table's fixed 9, not the recap script's own raw return code."""
    import run_meeting

    vault, repo, mid = _seed(tmp_path)
    fake_rec = _fake_binary(tmp_path, "fake_recap.py", rec_rc, "recap dry-run exploded")
    monkeypatch.setattr(run_meeting, "RECAP", fake_rec)

    rc = _run_dry_with_fake_fetch_extract(monkeypatch, mid, repo, vault)
    assert rc == 9
    err = capsys.readouterr().err
    assert f"FAILED at recap: rc={rec_rc}" in err
    assert "recap dry-run exploded" in err


def _seed_alloi_engagement(vault: Path) -> None:
    """Gives alloi-03's `parent: alloi-01` a real, kind:engagement target
    so `_run_dry`'s FR-011 lookup resolves a non-empty eng_id and actually
    reaches the STATUS_PLAN subprocess call (none of the base `_seed()`
    fixtures seed this page — see the parallel apply-test comment)."""
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    (proj / "alloi-01.md").write_text(
        "# Client: Alloi — Managed Services\n\n## Node\nid: alloi-01\nkind: engagement\n"
        "client: alloi\nparent:\ntitle: Managed Services\ndomains: alloi.us\n"
        "delivery_state: active\n\n## Reporting\ncadence: weekly\nchannel: email\n"
        "contact: marcos@alloi.us\nlast_update:\n\n## History (dated, newest first)\n\n"
        "## Open Items\n",
        encoding="utf-8",
    )


def test_dry_run_status_subprocess_failure_exits_14_no_would_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """G2R2-P1-1: a non-zero STATUS_PLAN preview rc must map to the FR-012
    exit-code table's fixed 14 (with a stderr tail), exactly like every
    other phase-3/dry-run subprocess failure already does — not be
    swallowed while the capture keeps printing further phase3-preview
    nouns (would-file:) that would make a failed preview look signable."""
    import run_meeting

    vault, repo, mid = _seed(tmp_path)
    _seed_alloi_engagement(vault)
    fake_status = _fake_binary(tmp_path, "fake_status.py", 1, "status preview exploded")
    monkeypatch.setattr(run_meeting, "_status_plan_argv", lambda: [sys.executable, str(fake_status)])

    rc = _run_dry_with_fake_fetch_extract(monkeypatch, mid, repo, vault)
    assert rc == 14
    captured = capsys.readouterr()
    assert "FAILED at status: rc=1" in captured.err
    assert "status preview exploded" in captured.err
    assert "would-file:" not in captured.out


def test_dry_run_status_subprocess_timeout_exits_14_no_would_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """G2R2-P1-1: an uncaught TimeoutExpired from the STATUS_PLAN preview
    subprocess must not crash `_run_dry` — it must map to the same fixed
    exit 14 as an explicit non-zero rc, with a distinct 'timeout' reason,
    and must not let the capture continue printing further nouns."""
    import subprocess

    import run_meeting

    vault, repo, mid = _seed(tmp_path)
    _seed_alloi_engagement(vault)
    original_run = subprocess.run

    def fake_run(cmd, *a, **kw):
        if any(str(run_meeting.STATUS_PLAN) in str(c) for c in cmd):
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=kw.get("timeout", 0))
        return original_run(cmd, *a, **kw)

    monkeypatch.setattr(run_meeting.subprocess, "run", fake_run)

    rc = _run_dry_with_fake_fetch_extract(monkeypatch, mid, repo, vault)
    assert rc == 14
    captured = capsys.readouterr()
    assert "FAILED at status: timeout" in captured.err
    assert "would-file:" not in captured.out


def _fake_resolve_writing(source_dir_holder: dict, counterparty_slug: str):
    """Builds a `resolve_main` replacement that writes a resolution.json
    (and the validated.json adapt_meeting.main() requires to already
    exist) with an attacker-controlled `counterparty_slug`, so a test can
    drive `_run_dry`'s client-slug handling without needing real
    resolve_meeting.py org/domain matching to produce a traversal value."""

    def fake_resolve(argv=None) -> int:
        source_dir = Path(argv[argv.index("--source") + 1])
        source_dir_holder["path"] = source_dir
        resolution = {
            "home_path": "clients/mal.md",
            "node": "none",
            "created": False,
            "relationship": "client",
            "confidence": 0.9,
            "counterparty_slug": counterparty_slug,
            "rule": 7,
        }
        (source_dir / "resolution.json").write_text(json.dumps(resolution), encoding="utf-8")
        validated = {
            "decisions": [{"text": "Keep cadence", "quote": "hello"}],
            "commitments": [
                {
                    "text": "Ship dry-run",
                    "owner_participant": 0,
                    "owner_name": "Josh Weiss",
                    "deadline_iso": "2026-12-01",
                    "quote": "hello",
                }
            ],
            "open_questions": [],
            "dropped": {},
        }
        (source_dir / "validated.json").write_text(json.dumps(validated), encoding="utf-8")
        return 0

    return fake_resolve


def test_dry_run_rejects_client_slug_path_traversal_before_reading_client_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """CH2-new-1: `_run_dry` previously built/read the clients/<slug>.md
    page directly from a node's untrusted `client:` value, bypassing the
    SAME brain_rollup.validate_client_slug guard brain_rollup.main()
    already runs for the identical write. A node with `client:
    ../../outside` (matching resolve's own resolved counterparty_slug)
    must fail closed — exit 6, FAILED at rollup, no phase3 write-target
    noun ever printed — never read/write outside org-brain/clients/."""
    import run_meeting

    vault, repo, mid = _seed(tmp_path)
    proj = vault / "raw/areas/clearworks/org-brain/projects"
    (proj / "malicious.md").write_text(
        "# Malicious\n\n## Node\nid: mal-01\nkind: project\nclient: ../../outside\n"
        "parent:\ntitle: Malicious\n",
        encoding="utf-8",
    )
    sentinel = vault / "raw/areas/outside.md"
    sentinel.write_text("SENTINEL: must never be read by _run_dry", encoding="utf-8")
    sentinel_mtime = sentinel.stat().st_mtime_ns

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr(run_meeting, "fetch_main", fake_fetch)
    monkeypatch.setattr(run_meeting, "extract_main", fake_extract)
    monkeypatch.setattr(
        run_meeting, "resolve_main", _fake_resolve_writing({}, "../../outside")
    )

    rc = run_meeting.main(
        ["--meeting-id", f"fireflies:{mid}", "--dry-run", "--repo-root", str(repo), "--vault", str(vault)]
    )
    assert rc == 6
    captured = capsys.readouterr()
    assert "FAILED at rollup: invalid client slug '../../outside'" in captured.err
    assert "would-touch:" not in captured.out
    assert "would-write:" not in captured.out
    assert "would-file:" not in captured.out
    assert sentinel.stat().st_mtime_ns == sentinel_mtime
    assert sentinel.read_text(encoding="utf-8") == "SENTINEL: must never be read by _run_dry"


def test_dry_run_state_preview_uses_apply_state_generated_region_end_placement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Preview/apply parity fold: brain_rollup.main() writes STATE.md via
    apply_state_generated_region (CH-3/FR-007 — strips any existing
    generated:state block wherever it sits, always re-appends a fresh one
    at the END). The dry-run preview must call the SAME function, not the
    generic in-place apply_generated_region, so the signed preview's
    would-touch diff actually matches what --apply produces."""
    import brain_rollup
    from run_meeting import main

    vault, repo, mid = _seed(tmp_path)
    state_path = vault / "raw/areas/clearworks/org-brain/STATE.md"
    state_path.write_text(
        "# Brain State\n\n"
        "<!-- generated: state -->\n"
        "generated-from: deadbeef\n\nold body\n"
        "<!-- /generated -->\n"
        "## Legacy Notes\n\nkeep me\n",
        encoding="utf-8",
    )

    real_generic = brain_rollup.apply_generated_region
    real_state = brain_rollup.apply_state_generated_region
    captured_state: dict = {}

    def guarded_generic(old_text, name, body, **kwargs):
        assert name != "state", "STATE.md preview must use apply_state_generated_region, not apply_generated_region"
        return real_generic(old_text, name, body, **kwargs)

    def spy_state(old_text, body):
        result = real_state(old_text, body)
        captured_state["new_state"] = result
        return result

    monkeypatch.setattr(brain_rollup, "apply_generated_region", guarded_generic)
    monkeypatch.setattr(brain_rollup, "apply_state_generated_region", spy_state)

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr("run_meeting.fetch_main", fake_fetch)
    monkeypatch.setattr("run_meeting.extract_main", fake_extract)

    rc = main(
        ["--meeting-id", f"fireflies:{mid}", "--dry-run", "--repo-root", str(repo), "--vault", str(vault)]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert "would-touch: STATE.md (state)" in out

    new_state = captured_state["new_state"]
    # The pre-existing "## Legacy Notes" section used to sit AFTER the
    # generated block; apply_state_generated_region always moves the
    # (re-)generated block to the end, so it must now sit BEFORE it.
    assert new_state.index("## Legacy Notes") < new_state.index("<!-- generated: state -->")
    assert new_state.rstrip().endswith("<!-- /generated -->")


def test_dry_run_state_unterminated_generated_region_exits_6(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """A STATE.md with an opening `<!-- generated: state -->` marker and no
    matching `<!-- /generated -->` must fail the dry-run closed — exit 6,
    same as any other rollup failure — not silently treat some unrelated
    later `<!-- /generated -->` as this region's close."""
    from run_meeting import main

    vault, repo, mid = _seed(tmp_path)
    state_path = vault / "raw/areas/clearworks/org-brain/STATE.md"
    state_path.write_text(
        "# Brain State\n\n<!-- generated: state -->\nno closing marker here\n",
        encoding="utf-8",
    )

    def fake_fetch(argv=None):
        return 0

    def fake_extract(argv=None):
        return 0

    monkeypatch.setattr("run_meeting.fetch_main", fake_fetch)
    monkeypatch.setattr("run_meeting.extract_main", fake_extract)

    rc = main(
        ["--meeting-id", f"fireflies:{mid}", "--dry-run", "--repo-root", str(repo), "--vault", str(vault)]
    )
    assert rc == 6
    captured = capsys.readouterr()
    assert "FAILED at rollup:" in captured.err
    assert "unterminated generated region" in captured.err
    assert "would-write:" not in captured.out
    assert "would-file:" not in captured.out


def test_defaults_are_shared_checkout() -> None:
    from run_meeting import DEFAULT_REPO_ROOT, DEFAULT_VAULT
    from pathlib import Path as P

    assert str(DEFAULT_REPO_ROOT) == "/Users/joshweiss/code/cortextos"
    assert Path.home() / "code/knowledge-sync" == DEFAULT_VAULT or str(DEFAULT_VAULT).endswith("knowledge-sync")
    _ = P
