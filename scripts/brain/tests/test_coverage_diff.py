"""Tests for coverage-diff.py (docs/pipeline/run-artifacts/client-state-gmail-v1/).
Imported by path: the ops script lives outside the scripts/brain package and
its filename has a hyphen, so it cannot be a normal module import. Inserts its
own directory on sys.path in ADDITION to scripts/brain/tests/conftest.py (C2 --
the conftest is what makes a bare `import helpers_client_state` work across this
slice; do not delete it)."""
import importlib.util
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "docs" / "pipeline" / "run-artifacts" / "client-state-gmail-v1" / "coverage-diff.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("coverage_diff_ops", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_exclusion_tokens_splits_from_and_subject():
    module = _load_module()
    query = ('-category:promotions -category:social -from:notify.railway.app '
             '-from:notifications@github.com -from:noreply -from:no-reply '
             '-from:donotreply -from:do-not-reply -from:mailer-daemon '
             '-subject:"Accepted:" -subject:"Declined:" -subject:"Tentative:" '
             '-subject:"out of office" -subject:"auto-reply"')
    from_tokens, subject_tokens = module.exclusion_tokens(query)
    assert "notify.railway.app" in from_tokens
    assert "notifications@github.com" in from_tokens
    assert "noreply" in from_tokens
    assert "out of office" in [t.lower() for t in subject_tokens]


def test_parse_subject_strips_sent_and_received_prefixes():
    module = _load_module()
    assert module.parse_subject("SENT: Re: proposal | snippet text") == "Re: proposal"
    assert module.parse_subject("RECEIVED: Invoice #4 | snippet") == "Invoice #4"
    assert module.parse_subject("no prefix here") == "no prefix here"


def test_classify_and_old_path_rows_end_to_end(tmp_path, monkeypatch):
    module = _load_module()

    old_interactions = tmp_path / "interactions.jsonl"
    rows = [
        {"contact_id": "marcos-r", "source_ref": "gmail:sent1", "summary": "SENT: kickoff notes | hey", "ts": "2026-09-10T00:00:00Z"},
        {"contact_id": "robot-1", "source_ref": "gmail:auto1", "summary": "RECEIVED: build failed | ci", "ts": "2026-09-10T00:00:00Z"},
        {"contact_id": "unknown-1", "source_ref": "gmail:unk1", "summary": "RECEIVED: hello | hi", "ts": "2026-09-10T00:00:00Z"},
        {"contact_id": "already-new", "source_ref": "gmail:new1", "summary": "RECEIVED: covered | already", "ts": "2026-09-10T00:00:00Z"},
        {"contact_id": "too-old", "source_ref": "gmail:old1", "summary": "RECEIVED: before window | x", "ts": "2026-09-01T00:00:00Z"},
    ]
    with old_interactions.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")

    crm_dir = tmp_path / "crm"
    crm_dir.mkdir()
    contacts_doc = {"contacts": [
        {"id": "marcos-r", "emails": ["marcos@clientco.com"]},
        {"id": "robot-1", "emails": ["ci-bot@notify.railway.app"]},
        {"id": "unknown-1", "emails": ["stranger@example.com"]},
        {"id": "already-new", "emails": ["known@clientco.com"]},
    ]}
    (crm_dir / "contacts.json").write_text(json.dumps(contacts_doc), encoding="utf-8")

    # G0B2-12: drive the REAL Ledger. The new path here CONFIRMED a CRM write
    # for (gmail:new1, already-new) only. gmail:unk1 was OBSERVED but only
    # `ignored`, and gmail:auto1 was observed with a CRM write for a DIFFERENT
    # contact -- both are coverage LOSSES and must still be enumerated, which
    # a `distinct_refs()`-based exclusion would have hidden.
    import observation_ledger as real_ledger
    led = real_ledger.Ledger(tmp_path / "state" / "observations.jsonl")
    (tmp_path / "state").mkdir(exist_ok=True)

    def _row(ref, writes, outcome="filed", simulated=False, planned=None):
        return real_ledger.ObservationRow(
            source_ref=ref, thread_id="t", content_digest="d-" + ref,
            observed_at="2026-09-10T00:00:00Z",
            resolutions=[real_ledger.Resolution(slug="clientco", kind="client",
                                                 method="contact-email", outcome=outcome)],
            writes=writes, simulated=simulated, planned_writes=planned or [],
        )

    led.append(_row("gmail:new1", ["crm:already-new", "clients/clientco.md"]))
    led.append(_row("gmail:unk1", [], outcome="ignored"))
    led.append(_row("gmail:auto1", ["crm:someone-else"]))
    # a dry-run row PLANNED a write for gmail:sent1 but never made one
    led.append(_row("gmail:sent1", [], simulated=True, planned=["crm:marcos-r"]))

    class FakeGmailSource:
        EXCLUSION_QUERY = '-from:notify.railway.app -subject:"auto-reply"'

    monkeypatch.setitem(sys.modules, "gmail_source", FakeGmailSource)

    state_dir = tmp_path / "state"
    out_path = tmp_path / "out.json"

    rc = module.main([
        "--old-interactions", str(old_interactions),
        "--state-dir", str(state_dir),
        "--since", "2026-09-05T00:00:00Z",
        "--out", str(out_path),
        "--crm-dir", str(crm_dir),
    ])
    assert rc == 0

    doc = json.loads(out_path.read_text())
    assert doc["since"] == "2026-09-05T00:00:00Z"
    counts = doc["counts"]
    assert counts.get("sent-mail") == 1
    assert counts.get("automated-sender") == 1
    assert counts.get("unclassified") == 1
    seen_refs = {r["source_ref"] for cls in doc["classes"].values() for r in cls}
    assert doc["confirmed_new_crm_keys"] == 2  # (new1, already-new) + (auto1, someone-else)
    assert "gmail:new1" not in seen_refs       # CONFIRMED CRM write for that contact
    assert "gmail:old1" not in seen_refs       # before the window
    # G0B2-12: observed-but-not-written refs are coverage LOSSES, not coverage.
    assert "gmail:unk1" in seen_refs           # ignored by the new path
    assert "gmail:auto1" in seen_refs          # written for a DIFFERENT contact_id
    assert "gmail:sent1" in seen_refs          # only PLANNED by a dry-run, never written


def test_cron_precheck_selftest_passes_via_subprocess():
    import subprocess
    script = REPO_ROOT / "docs" / "pipeline" / "run-artifacts" / "client-state-gmail-v1" / "cron-precheck.sh"
    result = subprocess.run(["bash", str(script), "--selftest"], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_missing_or_malformed_inputs_exit_2_with_the_cause(tmp_path, capsys):
    """G0B3-7: FR-006 makes this report the prerequisite for DELETING the old
    ingest path. A missing old-interactions file used to read as "zero rows" and
    produce a clean report — a false certificate that nothing was lost."""
    module = _load_module()

    crm = tmp_path / "crm"
    crm.mkdir()
    (crm / "contacts.json").write_text(json.dumps({"contacts": []}), encoding="utf-8")
    state = tmp_path / "state"
    state.mkdir()
    (state / "observations.jsonl").write_text("", encoding="utf-8")
    old = tmp_path / "interactions.jsonl"
    old.write_text("", encoding="utf-8")
    out = tmp_path / "out.json"

    def run(**over):
        args = {
            "--old-interactions": str(over.get("old", old)),
            "--state-dir": str(over.get("state", state)),
            "--since": "2026-09-05T00:00:00Z",
            "--out": str(out),
            "--crm-dir": str(over.get("crm", crm)),
        }
        flat = [x for kv in args.items() for x in kv]
        return module.cli(flat)

    # the happy path still works
    assert run() == 0

    # 1) --old-interactions missing
    assert run(old=tmp_path / "nope.jsonl") == 2
    assert "not found" in capsys.readouterr().err

    # 2) --old-interactions malformed
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"ok": 1}\nnot json at all\n', encoding="utf-8")
    assert run(old=bad) == 2
    assert "line 2 is not JSON" in capsys.readouterr().err

    # 3) ledger missing
    empty_state = tmp_path / "empty-state"
    empty_state.mkdir()
    assert run(state=empty_state) == 2
    assert "observations.jsonl" in capsys.readouterr().err

    # 4) CRM contacts.json missing
    empty_crm = tmp_path / "empty-crm"
    empty_crm.mkdir()
    assert run(crm=empty_crm) == 2
    assert "contacts.json" in capsys.readouterr().err

    # 5) CRM contacts.json malformed
    bad_crm = tmp_path / "bad-crm"
    bad_crm.mkdir()
    (bad_crm / "contacts.json").write_text("{not json", encoding="utf-8")
    assert run(crm=bad_crm) == 2
    assert "malformed" in capsys.readouterr().err
