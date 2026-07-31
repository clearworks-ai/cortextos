#!/usr/bin/env python3
"""clearpath_export.py — export the Clearpath high-value intelligence slice.

STANDALONE, WRITE-ONLY script for the WS5 one-go batch (09-one-go-batch.md):
select the ~2,700 high-value meeting rows — meeting/transcript-derived
intelligence extractions joined to contacts/engagements, filtered to the 27
INTELLIGENCE_TYPE_REGISTRY categories, ordered by recency — and write them as
one markdown file per row into a knowledge-sync raw/ layout so kb-ingest can
re-embed them at 768d.

SAFETY MODEL (do not weaken):
  * --dry-run is the DEFAULT: prints per-category row counts and the total,
    writes NOTHING.
  * --execute is required to write files. Even then this script only READS
    from Postgres and only WRITES local markdown — it never mutates the DB.
  * Connection string comes exclusively from the DATABASE_PUBLIC_URL env var
    (the Railway public proxy, e.g. from `railway variables --json` in the
    Clearpath project). NEVER the railway.internal host — that only resolves
    inside Railway. Nothing is hardcoded here.

Usage:
    export DATABASE_PUBLIC_URL='<railway public proxy url>'
    python3 clearpath_export.py                     # dry run (counts only)
    python3 clearpath_export.py --execute --out ~/code/knowledge-sync
    python3 clearpath_export.py --execute --out <dir> --limit 100 \
        --categories objections,story_bank

Output layout (under --out):
    raw/resources/clearpath-intel/<category>/<id>-<slug>.md
with YAML frontmatter {clearpath_id, category, contact, extracted_at}.

Testability: every SQL string is built by a pure function returning
(sql, params); the query runners accept an injected DB-API connection object
so tests run against fakes with zero network / zero Postgres.
"""

import argparse
import os
import re
import sys

# Single source of truth for the 27 registry keys + labels.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from intel_extractor import REGISTRY_BY_KEY, REGISTRY_KEYS  # noqa: E402

DB_ENV_VAR = "DATABASE_PUBLIC_URL"

# Column order of build_export_query — the export writer and the tests both
# key off this, so fake connections can return plain tuples.
EXPORT_COLUMNS = (
    "id",
    "prompt_key",
    "prompt_label",
    "result",
    "created_at",
    "data_source",
    "meeting_title",
    "meeting_date",
    "contact_name",
    "contact_org",
    "engagement_name",
    "engagement_status",
)


# ---------------------------------------------------------------------------
# Pure SQL builders — return (sql, params), no connection required
# ---------------------------------------------------------------------------
def build_export_query(categories=None, limit=None):
    """High-value slice: completed, non-empty, meeting/transcript-derived
    intelligence_extractions joined to contacts (and each contact's most
    recent engagement), filtered to the registry categories, newest first."""
    keys = list(categories) if categories else list(REGISTRY_KEYS)
    sql = """
SELECT
    ie.id,
    ie.prompt_key,
    ie.prompt_label,
    ie.result,
    ie.created_at,
    ie.data_source,
    fm.title AS meeting_title,
    fm.date AS meeting_date,
    TRIM(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))) AS contact_name,
    c.organization AS contact_org,
    e.name AS engagement_name,
    e.status AS engagement_status
FROM intelligence_extractions ie
JOIN fireflies_meetings fm ON fm.id = ie.fireflies_meeting_id
LEFT JOIN contacts c ON c.id = ie.contact_id
LEFT JOIN LATERAL (
    SELECT eng.name, eng.status
    FROM engagements eng
    WHERE eng.primary_contact_id = c.id
      AND eng.org_id = ie.org_id
    ORDER BY eng.updated_at DESC
    LIMIT 1
) e ON TRUE
WHERE ie.prompt_key = ANY(%s)
  AND ie.status = 'completed'
  AND ie.result IS NOT NULL
  AND LENGTH(TRIM(ie.result)) > 0
ORDER BY ie.created_at DESC
""".strip()
    params = [keys]
    if limit is not None:
        sql += "\nLIMIT %s"
        params.append(int(limit))
    return sql, tuple(params)


def build_count_query(categories=None):
    """Per-category row counts over the same high-value slice (dry-run view)."""
    keys = list(categories) if categories else list(REGISTRY_KEYS)
    sql = """
SELECT ie.prompt_key, COUNT(*) AS n
FROM intelligence_extractions ie
JOIN fireflies_meetings fm ON fm.id = ie.fireflies_meeting_id
WHERE ie.prompt_key = ANY(%s)
  AND ie.status = 'completed'
  AND ie.result IS NOT NULL
  AND LENGTH(TRIM(ie.result)) > 0
GROUP BY ie.prompt_key
ORDER BY n DESC
""".strip()
    return sql, (keys,)


# ---------------------------------------------------------------------------
# Connection (lazy psycopg2; injectable for tests)
# ---------------------------------------------------------------------------
def get_connection():
    """Open a read-only-use connection from DATABASE_PUBLIC_URL.

    Lazy-imports psycopg2 so this module (and its tests) work without it.
    """
    dsn = os.environ.get(DB_ENV_VAR)
    if not dsn:
        raise RuntimeError(
            f"{DB_ENV_VAR} is not set. Get the Railway PUBLIC proxy URL "
            "(e.g. `railway variables --json` in the Clearpath project) — "
            "never the railway.internal host, which only resolves inside Railway."
        )
    if "railway.internal" in dsn:
        raise RuntimeError(
            f"{DB_ENV_VAR} points at railway.internal — that host only resolves "
            "inside Railway. Use the public proxy URL instead."
        )
    try:
        import psycopg2
    except ImportError as exc:
        raise RuntimeError(
            "psycopg2 is not installed. Install it with: "
            "pip install psycopg2-binary"
        ) from exc
    return psycopg2.connect(dsn)


# ---------------------------------------------------------------------------
# Query runners (accept an injected connection — tests pass fakes)
# ---------------------------------------------------------------------------
def fetch_counts(conn, categories=None):
    """Return ([(prompt_key, count), ...], total) for the high-value slice."""
    sql, params = build_count_query(categories)
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        rows = [(row[0], int(row[1])) for row in cur.fetchall()]
    finally:
        cur.close()
    return rows, sum(n for _, n in rows)


def fetch_rows(conn, categories=None, limit=None):
    """Return export rows as dicts keyed by EXPORT_COLUMNS."""
    sql, params = build_export_query(categories, limit)
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        rows = cur.fetchall()
    finally:
        cur.close()
    return [dict(zip(EXPORT_COLUMNS, row)) for row in rows]


# ---------------------------------------------------------------------------
# Markdown writer (knowledge-sync raw/ layout)
# ---------------------------------------------------------------------------
def slugify(text, max_len=60):
    slug = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return slug[:max_len].rstrip("-") or "untitled"


def _yaml_escape(value):
    text = str(value if value is not None else "")
    text = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return f'"{text}"'


def render_row_markdown(row):
    """One kb-ingest-shaped markdown doc per intelligence row."""
    category = row.get("prompt_key") or "unclassified"
    label = REGISTRY_BY_KEY.get(category, {}).get("label", row.get("prompt_label") or category)
    contact = (row.get("contact_name") or "").strip() or "Unknown"
    extracted_at = row.get("created_at")
    extracted_at = extracted_at.isoformat() if hasattr(extracted_at, "isoformat") else str(extracted_at or "")

    lines = [
        "---",
        f"clearpath_id: {row.get('id')}",
        f"category: {category}",
        f"contact: {_yaml_escape(contact)}",
        f"extracted_at: {_yaml_escape(extracted_at)}",
        "---",
        "",
        f"# {label} — {row.get('meeting_title') or 'Untitled meeting'}",
        "",
    ]
    context_bits = []
    if row.get("meeting_date"):
        date = row["meeting_date"]
        context_bits.append(f"Meeting date: {date.isoformat() if hasattr(date, 'isoformat') else date}")
    if contact != "Unknown":
        org = f" ({row['contact_org']})" if row.get("contact_org") else ""
        context_bits.append(f"Contact: {contact}{org}")
    if row.get("engagement_name"):
        status = f" [{row['engagement_status']}]" if row.get("engagement_status") else ""
        context_bits.append(f"Engagement: {row['engagement_name']}{status}")
    if context_bits:
        lines.append(" · ".join(context_bits))
        lines.append("")
    lines.append(str(row.get("result") or "").strip())
    lines.append("")
    return "\n".join(lines)


def row_output_path(out_dir, row):
    category = row.get("prompt_key") or "unclassified"
    slug_source = row.get("meeting_title") or row.get("contact_name") or row.get("prompt_label") or category
    filename = f"{row.get('id')}-{slugify(slug_source)}.md"
    return os.path.join(out_dir, "raw", "resources", "clearpath-intel", category, filename)


def run_dry_run(conn, categories=None, limit=None):
    """Print per-category counts + total. Writes NOTHING."""
    rows, total = fetch_counts(conn, categories)
    print("DRY RUN — high-value Clearpath slice (no files written)")
    print(f"{'category':<28} rows")
    for key, count in rows:
        print(f"{key:<28} {count}")
    print(f"{'TOTAL':<28} {total}")
    if limit is not None:
        print(f"(--limit {limit} would cap the export at {min(int(limit), total)} rows)")
    print("Re-run with --execute --out <dir> to write markdown files.")
    return total


def run_export(conn, out_dir, categories=None, limit=None):
    """Write one markdown file per row into the knowledge-sync raw/ layout."""
    rows = fetch_rows(conn, categories, limit)
    written = 0
    for row in rows:
        path = row_output_path(out_dir, row)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(render_row_markdown(row))
        written += 1
    print(f"EXPORTED {written} row(s) -> {os.path.join(out_dir, 'raw', 'resources', 'clearpath-intel')}")
    return written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_arg_parser():
    parser = argparse.ArgumentParser(
        prog="clearpath_export.py",
        description="Export the Clearpath high-value intelligence slice to "
                    "knowledge-sync markdown. DRY-RUN BY DEFAULT.",
    )
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="Print per-category counts and total; write nothing (DEFAULT)")
    parser.add_argument("--execute", action="store_true",
                        help="Actually write markdown files (requires --out)")
    parser.add_argument("--out", help="Output root; files land under "
                        "<out>/raw/resources/clearpath-intel/<category>/")
    parser.add_argument("--limit", type=int, default=None,
                        help="Cap the number of exported rows")
    parser.add_argument("--categories", default="all",
                        help="'all' or comma-separated registry keys (default: all)")
    return parser


def resolve_categories(spec):
    if not spec or spec.strip().lower() == "all":
        return list(REGISTRY_KEYS)
    keys = [k.strip() for k in spec.split(",") if k.strip()]
    unknown = [k for k in keys if k not in REGISTRY_BY_KEY]
    if unknown:
        raise ValueError(f"unknown categories: {', '.join(unknown)}")
    return keys


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    try:
        categories = resolve_categories(args.categories)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 2

    if args.execute and not args.out:
        print("ERROR: --execute requires --out <dir>")
        return 2

    conn = get_connection()
    try:
        if args.execute:
            run_export(conn, args.out, categories, args.limit)
        else:
            run_dry_run(conn, categories, args.limit)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
