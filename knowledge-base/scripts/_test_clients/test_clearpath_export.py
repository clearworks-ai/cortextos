"""Behavioral tests for clearpath_export (SQL builders, dry-run, export writer).

Run from knowledge-base/scripts:

    python -m _test_clients.test_clearpath_export

Exits 0 on all-pass, 1 on any failure. Zero external deps: no psycopg2, no
Postgres, no network — a fake DB-API connection is injected into the query
runners. clearpath_export itself is NEVER pointed at a real database here.

Scenarios:
  1. sql_builders: build_export_query / build_count_query return the expected
     (sql, params) — registry filter, completed-only, meeting join, recency
     order, optional LIMIT
  2. dry_run_counts: run_dry_run prints per-category counts + total and
     writes ZERO files
  3. execute_writes_markdown: run_export writes correctly shaped markdown
     (raw/ layout + YAML frontmatter) from fake rows into a tempdir
"""

import datetime
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import clearpath_export as ce  # noqa: E402

FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


# ---------------------------------------------------------------------------
# Fake DB-API connection
# ---------------------------------------------------------------------------
class FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.executed = []  # (sql, params) pairs

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class FakeConnection:
    def __init__(self, rows):
        self.cursor_obj = FakeCursor(rows)

    def cursor(self):
        return self.cursor_obj

    def close(self):
        pass


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_sql_builders():
    print("\n[test 1/3] sql_builders: (sql, params) shape and clauses")
    sql, params = ce.build_export_query()
    _check("export params = 1-tuple wrapping the 27 registry keys",
           len(params) == 1 and params[0] == list(ce.REGISTRY_KEYS),
           detail=f"params={params!r:.200}")
    _check("filters on prompt_key ANY(%s)", "ie.prompt_key = ANY(%s)" in sql)
    _check("completed-only", "ie.status = 'completed'" in sql)
    _check("meeting-derived only (INNER JOIN fireflies_meetings)",
           "JOIN fireflies_meetings fm ON fm.id = ie.fireflies_meeting_id" in sql
           and "LEFT JOIN fireflies_meetings" not in sql)
    _check("joins contacts", "LEFT JOIN contacts c ON c.id = ie.contact_id" in sql)
    _check("joins engagements (lateral, most recent)",
           "FROM engagements eng" in sql and "LIMIT 1" in sql)
    _check("ordered by recency", "ORDER BY ie.created_at DESC" in sql)
    _check("no LIMIT without --limit", "LIMIT %s" not in sql)
    _check("selects EXPORT_COLUMNS count of columns",
           len(ce.EXPORT_COLUMNS) == 12)

    sql_lim, params_lim = ce.build_export_query(categories=["objections"], limit=100)
    _check("limit appends LIMIT %s + param",
           sql_lim.endswith("LIMIT %s") and params_lim == (["objections"], 100),
           detail=f"params={params_lim!r}")

    csql, cparams = ce.build_count_query(["story_bank", "objections"])
    _check("count query groups by prompt_key", "GROUP BY ie.prompt_key" in csql)
    _check("count query filters same slice",
           "ie.status = 'completed'" in csql
           and "JOIN fireflies_meetings" in csql
           and "ie.prompt_key = ANY(%s)" in csql)
    _check("count params carry the category list",
           cparams == (["story_bank", "objections"],), detail=repr(cparams))

    _check("nothing hardcodes a connection string",
           "railway" not in sql.lower() and "postgres://" not in sql.lower())


def test_dry_run_counts():
    print("\n[test 2/3] dry_run_counts: prints counts, writes zero files")
    conn = FakeConnection(rows=[("objections", 120), ("story_bank", 45)])
    tmpdir = tempfile.mkdtemp(prefix="clearpath-dry-")
    try:
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            total = ce.run_dry_run(conn, categories=["objections", "story_bank"])
        output = buf.getvalue()
        _check("returns the summed total", total == 165, detail=str(total))
        _check("prints per-category counts",
               "objections" in output and "120" in output and "45" in output,
               detail=output)
        _check("prints TOTAL line", "TOTAL" in output and "165" in output)
        _check("announces dry-run", "DRY RUN" in output)
        _check("executed the count query, not the export query",
               len(conn.cursor_obj.executed) == 1
               and "COUNT(*)" in conn.cursor_obj.executed[0][0])
        _check("wrote ZERO files", os.listdir(tmpdir) == [], detail=str(os.listdir(tmpdir)))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_execute_writes_markdown():
    print("\n[test 3/3] execute_writes_markdown: raw/ layout + YAML frontmatter")
    created = datetime.datetime(2026, 6, 15, 10, 30, 0)
    meeting_date = datetime.datetime(2026, 6, 14, 9, 0, 0)
    fake_rows = [
        # matches EXPORT_COLUMNS order:
        # id, prompt_key, prompt_label, result, created_at, data_source,
        # meeting_title, meeting_date, contact_name, contact_org,
        # engagement_name, engagement_status
        (101, "objections", "Objections", "Budget is tight this quarter.",
         created, "meeting", "SEIU Scope Call", meeting_date,
         "David Sailer", "SEIU 521", "Busywork Audit", "active"),
        (102, "story_bank", "Story Bank", "The dashboard rescue story.",
         created, "meeting", "Alloi / Weekly Sync", meeting_date,
         "", None, None, None),
    ]
    conn = FakeConnection(rows=fake_rows)
    tmpdir = tempfile.mkdtemp(prefix="clearpath-exec-")
    try:
        written = ce.run_export(conn, tmpdir, categories=["objections", "story_bank"])
        _check("writes one file per row", written == 2)
        _check("passed the category filter through to SQL params",
               conn.cursor_obj.executed[0][1][0] == ["objections", "story_bank"])

        obj_path = os.path.join(tmpdir, "raw", "resources", "clearpath-intel",
                                "objections", "101-seiu-scope-call.md")
        _check("raw/ layout path: <category>/<id>-<slug>.md",
               os.path.isfile(obj_path),
               detail=str([os.path.join(r, f) for r, _, fs in os.walk(tmpdir) for f in fs]))

        with open(obj_path, encoding="utf-8") as f:
            content = f.read()
        _check("frontmatter clearpath_id", "clearpath_id: 101" in content, detail=content)
        _check("frontmatter category", "category: objections" in content)
        _check("frontmatter contact", 'contact: "David Sailer"' in content)
        _check("frontmatter extracted_at",
               'extracted_at: "2026-06-15T10:30:00"' in content)
        _check("frontmatter fenced by ---",
               content.startswith("---\n") and content.count("---") >= 2)
        _check("body carries the extraction result",
               "Budget is tight this quarter." in content)
        _check("body carries engagement context", "Busywork Audit" in content)

        story_dir = os.path.join(tmpdir, "raw", "resources", "clearpath-intel", "story_bank")
        story_files = os.listdir(story_dir)
        _check("second category lands in its own dir",
               len(story_files) == 1 and story_files[0].startswith("102-"),
               detail=str(story_files))
        with open(os.path.join(story_dir, story_files[0]), encoding="utf-8") as f:
            story = f.read()
        _check("empty contact renders as Unknown", 'contact: "Unknown"' in story)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_guardrails():
    print("\n[extra] guardrails: env-only DSN, no hardcoded credentials")
    saved = os.environ.get(ce.DB_ENV_VAR)
    try:
        os.environ.pop(ce.DB_ENV_VAR, None)
        raised = False
        try:
            ce.get_connection()
        except RuntimeError as exc:
            raised = "DATABASE_PUBLIC_URL" in str(exc)
        _check("get_connection refuses without DATABASE_PUBLIC_URL", raised)

        os.environ[ce.DB_ENV_VAR] = "postgres://user:pw@x.railway.internal:5432/db"
        raised = False
        try:
            ce.get_connection()
        except RuntimeError as exc:
            raised = "railway.internal" in str(exc)
        _check("get_connection rejects railway.internal hosts", raised)
    finally:
        if saved is None:
            os.environ.pop(ce.DB_ENV_VAR, None)
        else:
            os.environ[ce.DB_ENV_VAR] = saved


if __name__ == "__main__":
    test_sql_builders()
    test_dry_run_counts()
    test_execute_writes_markdown()
    test_guardrails()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for failure in FAILURES:
            print(f"  - {failure}")
        sys.exit(1)
    print("ALL PASS (4 scenarios)")
    sys.exit(0)
