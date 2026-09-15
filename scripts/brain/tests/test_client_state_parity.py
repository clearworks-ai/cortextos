"""G-PARITY-1: for every projection in the C6 module
(scripts/brain/client_state_projections.py), what the --dry-run PREVIEWS is
byte-identical to what the LIVE path actually executes.

The method (G0A2-4 / G0B2-3 / G0B-24): run the REAL orchestrator
(client_state_gmail.run) twice over the SAME message -- once with
dry_run=True against one --state-dir, once with dry_run=False against a fresh
one -- and compare the preview text to the argv/text the live run's real
consumers received (client_state_writes.ensure_contact / write_interaction /
create_task via runner.run, writeback_email.apply_history via the page on
disk, the send-telegram argv, and client_state_digest.gmail_section for the
digest lines). No projection is asserted by calling its planner twice; the
consumer is always executed. No skips.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

from helpers_client_state import FakeRunner, make_crm_dir, make_vault  # noqa: E402

import client_state_digest as cs_digest  # noqa: E402
import client_state_gmail as csg  # noqa: E402
import client_state_projections as csp  # noqa: E402
import single_flight  # noqa: E402
from observation_ledger import Ledger  # noqa: E402

CONTACTS = [{"id": "lori-bodenhamer", "name": "Lori", "emails": ["lori@acme.org"]}]


def _payload(subject="Re: Q4 budget + SOW"):
    return {
        "id": "19a1b2c3d4e5f", "threadId": "thread-1",
        "from": {"name": "Lori Bodenhamer", "email": "lori@acme.org"},
        "to": ["josh@clearworks.ai"], "cc": [],
        "subject": subject, "date": "2026-09-14T11:58:00Z",
        "body": "Confirmed the Q4 budget. Can you send the revised SOW?",
    }


def _claude_stdout():
    model = {
        "schema": "brain.email_extraction/1",
        "summary": "Lori confirmed the Q4 budget and asked for the revised SOW.",
        "decisions": [{"text": "Q4 budget confirmed", "quote": "Confirmed the Q4 budget"}],
        "commitments": [{"text": "send the revised SOW", "owner_name": "Josh",
                         "deadline_iso": None, "quote": "send the revised SOW",
                         "matches_open_item": None}],
        "open_questions": [],
    }
    return json.dumps({
        "type": "result", "subtype": "success", "result": json.dumps(model),
        "total_cost_usd": 0.0421,
        "modelUsage": {"claude-sonnet-5": {"inputTokens": 2, "outputTokens": 4, "costUSD": 0.0421}},
    })


def _cfg(tmp_path: Path, name: str, dry_run: bool, contacts=None) -> csg.Config:
    root = tmp_path / name
    root.mkdir(parents=True, exist_ok=True)
    return csg.Config(
        repo_root=root, vault=make_vault(root),
        crm_dir=make_crm_dir(root, contacts if contacts is not None else list(CONTACTS)),
        state_dir=root / "state", days=3, query=None, dry_run=dry_run, max_usd=2.0,
        today=date(2026, 9, 14), now=datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc),
    )


def _lock_ok(runner: FakeRunner, claims_dir: Path) -> None:
    runner.record(("cortextos", "bus", "meeting-brief-claim"), rc=0, stdout="ok")
    runner.record(("cortextos", "bus", "meeting-brief-release"), rc=0, stdout="ok")
    lock = single_flight.lock_path(claims_dir, "client-state-gmail")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.touch()


def _interaction_stdout(contact_id="lori-bodenhamer"):
    return json.dumps({"contact_id": contact_id, "type": "email", "source_ref": "gmail:19a1b2c3d4e5f"})


def _base_runner(cfg: csg.Config) -> FakeRunner:
    runner = FakeRunner()
    _lock_ok(runner, cfg.state_dir / "claims")
    runner.record(("gws", "gmail", "+triage"), rc=0,
                  stdout=json.dumps([{"id": "19a1b2c3d4e5f", "threadId": "thread-1"}]))
    runner.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_payload()))
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "human"), rc=0, stdout="[]")
    runner.record(("cortextos", "bus", "list-tasks", "--open", "--class", "build"), rc=0, stdout="[]")
    runner.record(("claude",), rc=0, stdout=_claude_stdout())
    return runner


def _run_pair(tmp_path, contacts=None):
    """Runs the REAL orchestrator dry then live over the same message and
    returns (dry_previews_text, live_runner, live_cfg)."""
    cfg_dry = _cfg(tmp_path, "dry", dry_run=True, contacts=contacts)
    r_dry = _base_runner(cfg_dry)
    dry = csg.run(cfg_dry, r_dry)
    assert dry.exit_code == 0, dry

    cfg_live = _cfg(tmp_path, "live", dry_run=False, contacts=contacts)
    r_live = _base_runner(cfg_live)
    r_live.record(("python3", str(cfg_live.crm_dir / "upsert-contact.py")), rc=0, stdout="lori-bodenhamer\n")
    r_live.record(("python3", str(cfg_live.crm_dir / "add-interaction.py")), rc=0, stdout=_interaction_stdout())
    r_live.record(("cortextos", "bus", "create-task"), rc=0, stdout="task_1757800000_00000001\n")
    live = csg.run(cfg_live, r_live)
    assert live.exit_code == 0, live
    return "\n".join(dry.previews), r_live, cfg_live, cfg_dry


def _preview_argv(block: str, marker: str) -> list[str]:
    """Pull the argv list back out of a `... argv=[...]` preview line."""
    line = next(l for l in block.splitlines() if marker in l)
    return json.loads(line.split("argv=", 1)[1].replace("'", '"'))


def _strip_dir(argv: list[str]) -> list[str]:
    """Two scratch trees are involved (one per run), so the leading crm_dir
    differs by construction; the argv SHAPE is what the projection owns."""
    return [Path(p).name if p.startswith("/") else p for p in argv]


def test_add_interaction_argv_parity_preview_equals_executed_argv(tmp_path):
    block, r_live, cfg_live, _ = _run_pair(tmp_path)
    previewed = _preview_argv(block, "CRM row: contact=")
    executed = next(c for c in r_live.calls if len(c) > 1 and "add-interaction.py" in c[1])
    assert _strip_dir(previewed) == _strip_dir(executed)
    assert "gmail:19a1b2c3d4e5f" in executed


def test_upsert_contact_argv_parity_preview_equals_executed_argv(tmp_path):
    block, r_live, cfg_live, _ = _run_pair(tmp_path, contacts=[])  # unknown sender => auto-create
    previewed = _preview_argv(block, "CRM: would create contact")
    executed = next(c for c in r_live.calls if len(c) > 1 and "upsert-contact.py" in c[1])
    assert _strip_dir(previewed) == _strip_dir(executed)
    assert "--match-email" in executed


def test_task_create_argv_parity_preview_equals_executed_argv(tmp_path):
    block, r_live, _, _ = _run_pair(tmp_path)
    previewed = _preview_argv(block, "(create) argv=")
    executed = next(c for c in r_live.calls if c[:3] == ["cortextos", "bus", "create-task"])
    assert previewed == executed
    assert "--type" in executed and executed[executed.index("--type") + 1] == "human"


def test_history_entry_parity_preview_diff_equals_live_page_write(tmp_path):
    """The dry-run's unified diff of the page and the live run's actual page
    write are produced by the SAME plan_history_entry -> apply_history pair.
    Every `+` line the preview showed must appear verbatim in the page the
    live run persisted (writeback_email.apply_history is the real consumer)."""
    block, _, cfg_live, _ = _run_pair(tmp_path)
    added = [l[1:] for l in block.splitlines() if l.startswith("+") and not l.startswith("+++")]
    assert added, "dry-run produced no page diff"
    page = cfg_live.vault / "raw" / "areas" / "clearworks" / "org-brain" / "clients" / "acme.md"
    live_text = page.read_text(encoding="utf-8")
    for line in added:
        assert line in live_text, line
    assert "[source: gmail:19a1b2c3d4e5f]" in live_text


def test_escalation_text_parity_preview_equals_send_telegram_argv(tmp_path):
    """The escalation text previewed in a dry-run IS the 5th element of the
    live `cortextos bus send-telegram` argv."""
    ambiguous = [{"id": "c1", "name": "Lori", "emails": ["lori@acme.org"], "company": "Alloy"}]
    cfg_dry = _cfg(tmp_path, "esc-dry", dry_run=True, contacts=ambiguous)
    r_dry = FakeRunner()
    _lock_ok(r_dry, cfg_dry.state_dir / "claims")
    r_dry.record(("gws", "gmail", "+triage"), rc=0,
                 stdout=json.dumps([{"id": "19a1b2c3d4e5f", "threadId": "thread-1"}]))
    r_dry.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_payload()))
    dry = csg.run(cfg_dry, r_dry)
    assert dry.escalated == 1
    previewed = next(l for l in "\n".join(dry.previews).splitlines() if l.strip().startswith("escalation:"))
    previewed_text = previewed.split("escalation:", 1)[1].strip()

    cfg_live = _cfg(tmp_path, "esc-live", dry_run=False, contacts=ambiguous)
    r_live = FakeRunner()
    _lock_ok(r_live, cfg_live.state_dir / "claims")
    r_live.record(("gws", "gmail", "+triage"), rc=0,
                  stdout=json.dumps([{"id": "19a1b2c3d4e5f", "threadId": "thread-1"}]))
    r_live.record(("gws", "gmail", "+read"), rc=0, stdout=json.dumps(_payload()))
    r_live.record(("cortextos", "bus", "send-telegram"), rc=0, stdout="sent")
    assert csg.run(cfg_live, r_live).escalated == 1

    sent = next(c for c in r_live.calls if c[:3] == ["cortextos", "bus", "send-telegram"])
    assert sent[3] == csp.TELEGRAM_CHAT_ID
    assert sent[4] == previewed_text


def test_digest_line_parity_preview_equals_real_digest_section(tmp_path):
    """plan_digest_line has TWO consumers: the dry-run's own digest preview
    (client_state_gmail) and the daily digest (client_state_digest.gmail_section).
    Both are executed here and their lines compared -- the only difference is
    the `[simulated]` tag the dry-run row carries by design."""
    block, _, cfg_live, cfg_dry = _run_pair(tmp_path)
    previewed = [l.split("digest preview:", 1)[1].strip()
                 for l in block.splitlines() if "digest preview:" in l]
    assert previewed, "dry-run emitted no digest preview lines"

    # the REAL digest consumer, over the LIVE ledger
    ledger = Ledger(cfg_live.state_dir / "observations.jsonl")
    lines = cs_digest.gmail_section(
        cfg_live.state_dir, cfg_live.vault, ledger,
        datetime(2026, 9, 14, 12, 30, tzinfo=timezone.utc), window_days=3, runner=FakeRunner(),
    )
    live_change_lines = [l for l in lines if l.startswith("- ") and not l.startswith("- invariants")]

    def canon(line: str) -> str:
        # live ids ('crm:lori-bodenhamer', 'task:task_...') vs the dry-run's
        # prospective placeholders ('crm:<new:...>', 'task:<new>') are the only
        # legitimate difference; the RENDERING must be identical.
        out = (line.replace(" [simulated]", "")
                   .replace("crm:<new:lori@acme.org>", "crm:lori-bodenhamer")
                   .replace("task:<new>", "task:X"))
        # the two runs live in different scratch trees, so an absolute page
        # path differs by construction -- compare the page BASENAME.
        return re.sub(r"/\S+/(\w[\w-]*\.md)", r"\1", re.sub(r"task:task_\d+_\d+", "task:X", out))

    for line in previewed:
        assert canon(line) in [canon(l) for l in live_change_lines], (line, live_change_lines)
    assert all(l.endswith("[simulated]") for l in previewed)


def test_message_preview_is_pure_and_carries_the_g4_fields(tmp_path):
    """plan_message_preview is the artifact G4 item 3 is read from: same
    inputs -> byte-identical block, and it carries the literal `source_ref`
    token the checker binds to (G0B2-5)."""
    block, _, _, _ = _run_pair(tmp_path)
    assert "=== source_ref=gmail:19a1b2c3d4e5f thread_id=thread-1 ===" in block
    for token in ("From: Lori Bodenhamer <lori@acme.org>", "resolution: slug='acme'",
                  "cost_usd=0.0421", "model_receipt=claude-sonnet-5",
                  "[quote: Confirmed the Q4 budget]", "CRM row: contact=", "page diff for",
                  "task: send the revised SOW (create)", "digest preview:"):
        assert token in block, token

    cfg2 = _cfg(tmp_path, "pure2", dry_run=True)
    again = "\n".join(csg.run(cfg2, _base_runner(cfg2)).previews)
    assert again.replace(str(cfg2.crm_dir), "").replace(str(cfg2.vault), "") == \
        block.replace(str(_cfg_dir(tmp_path, "dry")), "").replace(str(_cfg_vault(tmp_path, "dry")), "")


def _cfg_dir(tmp_path: Path, name: str) -> Path:
    return tmp_path / name / "crm"


def _cfg_vault(tmp_path: Path, name: str) -> Path:
    return tmp_path / name / "vault"
