"""FR-002/FR-003 gmail_source: exclusion query, day windows, gws transport, parsing."""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from helpers_client_state import FakeRunner, email_row, ensure_gmail_fixtures  # noqa: E402

FIXTURES = TESTS_DIR / "fixtures" / "client_state"


def _ok(stdout: str):
    import subprocess

    return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


def _err(code: int, stderr: str):
    import subprocess

    return subprocess.CompletedProcess(args=[], returncode=code, stdout="", stderr=stderr)


def _triage_argv(query: str, max_results: int = 50) -> list[str]:
    return ["gws", "gmail", "+triage", "--query", query, "--format", "json", "--max", str(max_results)]


def test_exclusion_query_matches_comms_check_worker_verbatim() -> None:
    # G-SWEEP-7
    from gmail_source import EXCLUSION_QUERY

    assert EXCLUSION_QUERY == (
        '-category:promotions -category:social -from:notify.railway.app '
        '-from:notifications@github.com -from:noreply -from:no-reply '
        '-from:donotreply -from:do-not-reply -from:mailer-daemon '
        '-subject:"Accepted:" -subject:"Declined:" -subject:"Tentative:" '
        '-subject:"out of office" -subject:"auto-reply"'
    )
    assert "is:unread" not in EXCLUSION_QUERY
    assert "newer_than" not in EXCLUSION_QUERY


def test_ours_domains_is_clearworks_only() -> None:
    from gmail_source import OURS_DOMAINS

    assert OURS_DOMAINS == frozenset({"clearworks.ai"})


def test_counterparties_excludes_ours_domain_dedupes_and_lowercases() -> None:
    # G-SWEEP-4
    from gmail_source import Message

    msg = Message(
        id="m1",
        thread_id="t1",
        from_name="Lori",
        from_email="Lori@Abundowealth.com",
        to=["josh@clearworks.ai", "lori@abundowealth.com", "second@abundowealth.com"],
        cc=["Second@Abundowealth.com"],
        subject="s",
        date_iso="2026-09-14T00:00:00Z",
        body_text="b",
    )
    assert msg.counterparties() == ["lori@abundowealth.com", "second@abundowealth.com"]


def test_window_queries_covers_every_day_no_gaps_no_overlaps_3_days() -> None:
    # G-SWEEP-1
    from gmail_source import EXCLUSION_QUERY, window_queries

    today = date(2026, 9, 14)
    rows = window_queries(3, today)
    labels = [label for label, _ in rows]
    assert labels == ["2026-09-12", "2026-09-13", "2026-09-14"]
    assert len(set(labels)) == 3
    for label, query in rows:
        y, m, d = (int(p) for p in label.split("-"))
        after = date(y, m, d)
        before = after + timedelta(days=1)
        assert query.startswith(f"after:{after:%Y/%m/%d} before:{before:%Y/%m/%d} ")
        assert query.endswith(EXCLUSION_QUERY)


def test_window_queries_covers_every_day_no_gaps_no_overlaps_14_days() -> None:
    # G-SWEEP-1
    from gmail_source import window_queries

    today = date(2026, 9, 14)
    rows = window_queries(14, today)
    labels = [label for label, _ in rows]
    expected = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(13, -1, -1)]
    assert labels == expected
    assert len(set(labels)) == 14


def test_full_window_query_spans_the_whole_range_inclusive_exclusive() -> None:
    from gmail_source import EXCLUSION_QUERY, full_window_query

    q = full_window_query(3, date(2026, 9, 14))
    assert q == f"after:2026/09/12 before:2026/09/15 {EXCLUSION_QUERY}"


def test_parse_message_flat_shape_strips_quoted_tail_and_lowercases_addresses() -> None:
    # G-SWEEP-5
    from gmail_source import parse_message

    payload = {
        "id": "m001",
        "threadId": "t001",
        "from": "Lori Bodenhamer <Lori@Abundowealth.com>",
        "to": "Josh Weiss <josh@clearworks.ai>",
        "cc": "",
        "subject": "Q3 plan check-in",
        "date": "2026-09-12T14:03:00Z",
        "body": (
            "Hi Josh,\n\nCan we push kickoff to next week?\n\nThanks,\nLori\n\n"
            "On Fri, Sep 11, 2026 at 3:14 PM Josh Weiss <josh@clearworks.ai> wrote:\n"
            "> Sounds good, let's plan for the 15th.\n> Talk soon.\n"
        ),
    }
    msg = parse_message(payload)
    assert msg.id == "m001"
    assert msg.thread_id == "t001"
    assert msg.from_email == "lori@abundowealth.com"
    assert msg.from_name == "Lori Bodenhamer"
    assert msg.to == ["josh@clearworks.ai"]
    assert "wrote:" not in msg.body_text
    assert not any(line.lstrip().startswith(">") for line in msg.body_text.splitlines())
    assert "Can we push kickoff" in msg.body_text


def test_parse_message_accepts_gmail_api_nested_payload_headers_shape() -> None:
    import base64

    from gmail_source import parse_message

    body = base64.urlsafe_b64encode(b"Hostile-safe plain body.").decode("ascii")
    payload = {
        "id": "m002",
        "threadId": "t002",
        "payload": {
            "headers": [
                {"name": "From", "value": "Dana Iyer <Dana@Svaraworks.com>"},
                {"name": "To", "value": "josh@clearworks.ai"},
                {"name": "Cc", "value": ""},
                {"name": "Subject", "value": "Re: invoice"},
                {"name": "Date", "value": "2026-09-13T10:00:00Z"},
            ],
            "mimeType": "text/plain",
            "body": {"data": body},
        },
    }
    msg = parse_message(payload)
    assert msg.id == "m002"
    assert msg.from_email == "dana@svaraworks.com"
    assert msg.body_text == "Hostile-safe plain body."


def test_parse_message_from_as_dict_and_to_cc_as_string_list() -> None:
    # Pins the shape the S-03/S-04 writer's +read fixtures actually use: "from" is
    # {"name","email"}, "to"/"cc" are lists of bare address strings (03-s03-s04.md
    # _msg_payload, ~line 694). The live +triage shape (probes G-88) has "from" as a
    # plain string — parse_message must accept both.
    from gmail_source import parse_message

    payload = {
        "id": "m010",
        "threadId": "t010",
        "from": {"name": "Dana Iyer", "email": "Dana@Svaraworks.com"},
        "to": ["josh@clearworks.ai", "Second@Abundowealth.com"],
        "cc": [],
        "subject": "s",
        "date": "2026-09-13T10:00:00Z",
        "body": "hi",
    }
    msg = parse_message(payload)
    assert msg.from_name == "Dana Iyer"
    assert msg.from_email == "dana@svaraworks.com"
    assert msg.to == ["josh@clearworks.ai", "second@abundowealth.com"]
    assert msg.cc == []


def test_parse_message_to_cc_as_list_of_dicts_and_from_address_key() -> None:
    from gmail_source import parse_message

    payload = {
        "id": "m011",
        "threadId": "t011",
        "from": {"name": "Lori Bodenhamer", "address": "Lori@Abundowealth.com"},
        "to": [{"name": "Josh Weiss", "email": "josh@clearworks.ai"}],
        "cc": [{"name": "Second Contact", "email": "Second@Abundowealth.com"}, "third@abundowealth.com"],
        "subject": "s",
        "date": "2026-09-13T10:00:00Z",
        "body": "hi",
    }
    msg = parse_message(payload)
    assert msg.from_name == "Lori Bodenhamer"
    assert msg.from_email == "lori@abundowealth.com"
    assert msg.to == ["josh@clearworks.ai"]
    assert msg.cc == ["second@abundowealth.com", "third@abundowealth.com"]


def test_list_messages_parses_dict_with_messages_key() -> None:
    from gmail_source import list_messages

    runner = FakeRunner([(["gws", "gmail", "+triage"], _ok(json.dumps({"messages": [{"id": "a"}, {"id": "b"}]})))])
    rows = list_messages(runner, "q", max_results=50)
    assert [r["id"] for r in rows] == ["a", "b"]
    assert runner.calls == [["gws", "gmail", "+triage", "--query", "q", "--format", "json", "--max", "50"]]


def test_list_messages_parses_dict_with_emails_key() -> None:
    # G-SWEEP-8: live gws-dwd returns {"emails": [...], "total": N} (probes G-88), not
    # {"messages": [...]} — support both.
    from gmail_source import list_messages

    runner = FakeRunner([(["gws", "gmail", "+triage"], _ok(json.dumps({"emails": [{"id": "x"}], "total": 1})))])
    rows = list_messages(runner, "q", max_results=50)
    assert [r["id"] for r in rows] == ["x"]


def test_list_messages_parses_bare_list() -> None:
    from gmail_source import list_messages

    runner = FakeRunner([(["gws", "gmail", "+triage"], _ok(json.dumps([{"id": "c"}])))])
    rows = list_messages(runner, "q", max_results=50)
    assert [r["id"] for r in rows] == ["c"]


def test_read_message_calls_plus_read_with_id_and_returns_parsed_message() -> None:
    from gmail_source import read_message

    payload = {
        "id": "m001", "threadId": "t001", "from": "a@b.com", "to": "josh@clearworks.ai",
        "subject": "s", "date": "2026-09-14T00:00:00Z", "body": "hi",
    }
    runner = FakeRunner([(["gws", "gmail", "+read"], _ok(json.dumps(payload)))])
    msg = read_message(runner, "m001")
    assert msg.id == "m001"
    assert runner.calls == [["gws", "gmail", "+read", "--id", "m001", "--format", "json"]]


def test_list_messages_nonzero_rc_raises_gmail_source_error() -> None:
    # G-SWEEP-6
    from gmail_source import GmailSourceError, list_messages

    runner = FakeRunner([(["gws", "gmail", "+triage"], _err(1, "insufficient scopes"))])
    with pytest.raises(GmailSourceError, match="insufficient scopes"):
        list_messages(runner, "q", max_results=50)


def test_read_message_nonzero_rc_raises_gmail_source_error() -> None:
    # G-SWEEP-6
    from gmail_source import GmailSourceError, read_message

    runner = FakeRunner([(["gws", "gmail", "+read"], _err(3, "gws timeout"))])
    with pytest.raises(GmailSourceError, match="gws timeout"):
        read_message(runner, "m001")
# --- appended for Task 5 (reuses the TESTS_DIR sys.path insert + FakeRunner import above) ---


def test_sweep_under_cap_returns_messages_and_no_truncation() -> None:
    ensure_gmail_fixtures()
    from gmail_source import full_window_query, sweep

    today = date(2026, 9, 14)
    days = 3
    payload = json.loads((FIXTURES / "triage_3.json").read_text())
    runner = FakeRunner([(_triage_argv(full_window_query(days, today)), _ok(json.dumps(payload)))])

    messages, truncation = sweep(runner, days, today)

    assert len(messages) == 3
    assert truncation == []
    assert runner.calls == [_triage_argv(full_window_query(days, today))]


def test_sweep_at_cap_day_sweeps_every_day_unions_by_id_and_reports_full_days() -> None:
    # G-SWEEP-2 / G-SWEEP-3
    ensure_gmail_fixtures()
    from gmail_source import full_window_query, sweep, window_queries

    today = date(2026, 9, 14)
    days = 3
    full_payload = json.loads((FIXTURES / "triage_50.json").read_text())
    responses = [(_triage_argv(full_window_query(days, today)), _ok(json.dumps(full_payload)))]

    for label, query in window_queries(days, today):
        if label == "2026-09-13":
            rows = [email_row(f"d13-{i:03d}", "t13", "a@abundowealth.com", "2026-09-13T00:00:00Z") for i in range(50)]
        elif label == "2026-09-12":
            rows = [email_row("d12-001", "t12", "b@abundowealth.com", "2026-09-12T00:00:00Z")]
        else:
            rows = [email_row("d14-001", "t14", "c@abundowealth.com", "2026-09-14T00:00:00Z")]
        responses.append((_triage_argv(query), _ok(json.dumps({"total": len(rows), "emails": rows}))))

    runner = FakeRunner(responses)
    messages, truncation = sweep(runner, days, today)

    ids = {m["id"] for m in messages}
    assert "d13-000" in ids
    assert "d13-049" in ids
    assert "d12-001" in ids
    assert "d14-001" in ids
    assert len(ids) == 52
    assert truncation == [{"day": "2026-09-13", "count": 50}]
    assert len(runner.calls) == 4


def test_sweep_propagates_gmail_source_error_from_a_day_query() -> None:
    ensure_gmail_fixtures()
    from gmail_source import GmailSourceError, full_window_query, sweep, window_queries

    today = date(2026, 9, 14)
    days = 3
    full_payload = json.loads((FIXTURES / "triage_50.json").read_text())
    responses = [(_triage_argv(full_window_query(days, today)), _ok(json.dumps(full_payload)))]
    first_label, first_query = window_queries(days, today)[0]
    responses.append((_triage_argv(first_query), _err(3, "gws timeout")))
    runner = FakeRunner(responses)

    with pytest.raises(GmailSourceError, match="gws timeout"):
        sweep(runner, days, today)


def test_sweep_extra_query_present_in_full_and_every_day_query() -> None:
    # G-SWEEP-9 (C5 / G0B-5): the manual backfill's --query clause composes as
    # <extra_query> <date ops> <EXCLUSION_QUERY> into BOTH the full-window query and
    # every per-day query; the 50-cap day-sweep still triggers on this path.
    ensure_gmail_fixtures()
    from gmail_source import EXCLUSION_QUERY, sweep

    today = date(2026, 9, 14)
    days = 3
    extra = "from:dana@svaraworks.com"

    full_query = f"{extra} after:2026/09/12 before:2026/09/15 {EXCLUSION_QUERY}"
    full_payload = json.loads((FIXTURES / "triage_50.json").read_text())
    responses = [(_triage_argv(full_query), _ok(json.dumps(full_payload)))]

    day_bounds = [
        ("2026-09-12", "2026/09/12", "2026/09/13"),
        ("2026-09-13", "2026/09/13", "2026/09/14"),
        ("2026-09-14", "2026/09/14", "2026/09/15"),
    ]
    for label, after, before in day_bounds:
        composed = f"{extra} after:{after} before:{before} {EXCLUSION_QUERY}"
        rows = [email_row(f"{label}-001", "t", "z@abundowealth.com", f"{label}T00:00:00Z")]
        responses.append((_triage_argv(composed), _ok(json.dumps({"total": 1, "emails": rows}))))

    runner = FakeRunner(responses)
    messages, truncation = sweep(runner, days, today, extra_query=extra)

    assert len(runner.calls) == 4  # full query (50-cap) + one per day
    for call in runner.calls:
        query = call[4]
        assert query.startswith(extra + " ")
        assert query.endswith(EXCLUSION_QUERY)
    assert truncation == []
    assert len(messages) == 3


def test_read_hostile_fixture_parses_verbatim_no_sanitization() -> None:
    # gmail_source only transports/parses; injection defenses live in extract_email
    # (FR-005/G-12, S-05). Proves the ONE recorded hostile fixture (C5/G0A-17) round-
    # trips unmodified through parse_message, the same path Task 11 uses.
    ensure_gmail_fixtures()
    from gmail_source import parse_message

    payload = json.loads((FIXTURES / "read_hostile.json").read_text())
    msg = parse_message(payload)
    assert "Ignore previous instructions" in msg.body_text
    assert msg.from_email == "dana@svaraworks.com"


def test_read_m001_fixture_parses_and_strips_quoted_tail() -> None:
    ensure_gmail_fixtures()
    from gmail_source import parse_message

    payload = json.loads((FIXTURES / "read_m001.json").read_text())
    msg = parse_message(payload)
    assert msg.id == "m001"
    assert "wrote:" not in msg.body_text
    assert not any(line.lstrip().startswith(">") for line in msg.body_text.splitlines())


# --- G2a-4: Date normalisation at the source ---------------------------------
# The Gmail-API-native payload's Date header is RFC 2822 ("Sun, 14 Sep 2026 ..."),
# so the downstream `date_iso[:10]` slice produced "Sun, 14 Se" as a History
# entry date. parse_message now normalises EVERY Date form into ISO-8601 UTC.

def _api_payload(date_value):
    return {
        "id": "m1",
        "threadId": "t1",
        "payload": {
            "headers": [
                {"name": "From", "value": "Marcos <marcos@acme.org>"},
                {"name": "To", "value": "josh@clearworks.ai"},
                {"name": "Subject", "value": "Renewal"},
                {"name": "Date", "value": date_value},
            ],
            "mimeType": "text/plain",
            "body": {},
        },
    }


def test_parse_message_normalises_rfc2822_date_header():
    import gmail_source

    msg = gmail_source.parse_message(_api_payload("Sun, 14 Sep 2026 03:00:00 -0700"))
    assert msg.date_iso == "2026-09-14T10:00:00Z"
    assert msg.date_iso[:10] == "2026-09-14"


def test_parse_message_normalises_iso_dates_to_utc():
    import gmail_source

    assert gmail_source.parse_message(_api_payload("2026-09-14T10:00:00Z")).date_iso == "2026-09-14T10:00:00Z"
    assert gmail_source.parse_message(_api_payload("2026-09-14T03:00:00-07:00")).date_iso == "2026-09-14T10:00:00Z"
    # naive ISO is read as UTC rather than dropped
    assert gmail_source.parse_message(_api_payload("2026-09-14T10:00:00")).date_iso == "2026-09-14T10:00:00Z"


def test_parse_message_normalises_epoch_dates():
    import gmail_source

    assert gmail_source.parse_message(_api_payload("1789380000000")).date_iso == "2026-09-14T10:00:00Z"  # ms
    assert gmail_source.parse_message(_api_payload("1789380000")).date_iso == "2026-09-14T10:00:00Z"     # seconds


def test_parse_message_drops_an_unparseable_date():
    import gmail_source

    assert gmail_source.parse_message(_api_payload("whenever, really")).date_iso == ""
    assert gmail_source.parse_message(_api_payload("")).date_iso == ""


def test_parse_message_flat_shape_normalises_rfc2822_too():
    import gmail_source

    payload = {
        "id": "m1", "threadId": "t1",
        "from": "Marcos <marcos@acme.org>", "to": "josh@clearworks.ai", "cc": "",
        "subject": "Renewal", "date": "Sun, 14 Sep 2026 03:00:00 -0700", "body": "hi",
    }
    assert gmail_source.parse_message(payload).date_iso == "2026-09-14T10:00:00Z"


# --- G2r3-5: an API failure must never look like an empty inbox --------------
# The deployed `gws` routes this call to gws-dwd, whose triage() converts a
# Gmail HTTP error into {"emails": [], "total": 0} with exit code 0. Accepting
# that as "no mail" let an auth/quota outage write a fresh SUCCESS receipt, and
# the poller-health line in the digest stayed green through a dead poller.

def test_list_messages_rejects_an_empty_result_with_stderr():
    import gmail_source

    runner = FakeRunner()
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout='{"emails": [], "total": 0}',
                  stderr="HttpError 401: Invalid Credentials")
    with pytest.raises(gmail_source.GmailSourceError) as exc:
        gmail_source.list_messages(runner, "q")
    assert "Invalid Credentials" in str(exc.value)


def test_list_messages_rejects_an_error_envelope():
    import gmail_source

    runner = FakeRunner()
    runner.record(("gws", "gmail", "+triage"), rc=0,
                  stdout='{"emails": [], "total": 0, "error": "quota exceeded"}')
    with pytest.raises(gmail_source.GmailSourceError) as exc:
        gmail_source.list_messages(runner, "q")
    assert "quota exceeded" in str(exc.value)


def test_list_messages_accepts_a_genuinely_empty_day():
    import gmail_source

    runner = FakeRunner()
    runner.record(("gws", "gmail", "+triage"), rc=0, stdout='{"emails": [], "total": 0}', stderr="")
    assert gmail_source.list_messages(runner, "q") == []


def test_list_messages_ignores_stderr_when_rows_came_back():
    """A warning on stderr alongside real rows is not an outage."""
    import gmail_source

    runner = FakeRunner()
    runner.record(("gws", "gmail", "+triage"), rc=0,
                  stdout='{"emails": [{"id": "m1"}], "total": 1}', stderr="warning: slow response")
    assert gmail_source.list_messages(runner, "q") == [{"id": "m1"}]


# --- G2r3-6: Cc must survive the deployed adapter's flat response -------------
# gws-dwd's read_email() omits the Cc header from its flat response, so a known
# counterparty who appears only in Cc got no resolution, no CRM interaction and
# no page fan-out — FR-003 requires From/To/Cc.

def _flat(**over):
    payload = {
        "id": "m1", "threadId": "t1",
        "from": "Marcos <marcos@acme.org>",
        "subject": "Renewal", "date": "2026-09-14T10:00:00Z", "body": "hi",
    }
    payload.update(over)
    return payload


def test_parse_message_reads_cc_from_a_headers_list():
    import gmail_source

    msg = gmail_source.parse_message(_flat(headers=[
        {"name": "To", "value": "josh@clearworks.ai"},
        {"name": "Cc", "value": "Dana Iyer <dana@svaraworks.com>, lori@abundowealth.com"},
    ]))
    assert msg.cc == ["dana@svaraworks.com", "lori@abundowealth.com"]
    assert msg.to == ["josh@clearworks.ai"]
    assert "dana@svaraworks.com" in msg.counterparties()


def test_parse_message_reads_cc_from_a_headers_mapping():
    import gmail_source

    msg = gmail_source.parse_message(_flat(headers={"To": "josh@clearworks.ai", "CC": "dana@svaraworks.com"}))
    assert msg.cc == ["dana@svaraworks.com"]
    assert msg.to == ["josh@clearworks.ai"]


def test_parse_message_reads_capitalised_top_level_recipient_keys():
    import gmail_source

    msg = gmail_source.parse_message(_flat(To="josh@clearworks.ai", Cc="dana@svaraworks.com"))
    assert msg.cc == ["dana@svaraworks.com"]
    assert msg.to == ["josh@clearworks.ai"]


def test_parse_message_top_level_cc_still_wins(): 
    import gmail_source

    msg = gmail_source.parse_message(_flat(to=["josh@clearworks.ai"], cc=["dana@svaraworks.com"]))
    assert msg.cc == ["dana@svaraworks.com"]
    assert msg.to == ["josh@clearworks.ai"]
