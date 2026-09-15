"""FR-007 / G-15: email-sourced History entries — append-only, revision-marked.
NOT a reuse of writeback_render.render_page: that renderer is meeting-shaped
(`(meeting: <path>)` lines) and its idempotency at writeback_render.py:133-137
REFUSES any entry whose `[source:]` marker already exists on the page — exactly
wrong for FR-001's supersede semantics, where a new digest under the SAME
source_ref must append a marked revision entry, not be silently dropped. This is
the sibling renderer FR-007 and G-15 call for."""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from writeback_render import _escape_md_leading, org_brain_root

try:
    from writeback_render import _split_sections as _wr_split_sections
except ImportError:  # pragma: no cover - defensive; writeback_render is a sibling
    _wr_split_sections = None


_KIND_DIRS = {"client": "clients", "org": "orgs", "project": "projects"}


@dataclass
class HistoryEntry:
    date: str
    subject: str
    source_ref: str
    summary: str
    decisions: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    revision_of: str | None = None


def render_history_entry(e: HistoryEntry) -> list[str]:
    """G-HIST-1: `- YYYY-MM-DD — <subject> (email) [source: gmail:<id>]` plus
    sub-bullets. A revision (new digest, same source_ref) gets a
    ` (revision of <digest[:8]>)` suffix on the first line. Every free-text field
    is escaped via writeback_render._escape_md_leading so a value starting with
    '#', '-', or '|' can't open a heading/list-item/table-row when it lands at the
    start of its own line."""
    subject = _escape_md_leading(e.subject or "")
    first = f"- {e.date} — {subject} (email) [source: {e.source_ref}]"
    if e.revision_of:  # G-HIST-1
        first += f" (revision of {e.revision_of[:8]})"
    lines = [first]
    summary = _escape_md_leading(e.summary) if e.summary else ""
    lines.append(f"  - Summary: {summary or 'none'}")
    decisions = [_escape_md_leading(d) for d in (e.decisions or []) if d]
    lines.append(f"  - Decisions: {' ; '.join(decisions) or 'none'}")
    open_qs = [_escape_md_leading(q) for q in (e.open_questions or []) if q]
    if open_qs:
        lines.append(f"  - Open questions: {' ; '.join(open_qs)}")
    return lines


def _local_split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Byte-identical fallback to writeback_render._split_sections, kept local so
    this module still works if that private helper is ever renamed/removed."""
    lines = text.splitlines(keepends=True)
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    for line in lines:
        if line.startswith("## "):
            if current is not None:
                sections.append((current[0], current[1]))
            current = (line[3:].strip(), [line])
        elif current is None:
            preamble.append(line)
        else:
            current[1].append(line)
    if current is not None:
        sections.append((current[0], current[1]))
    return "".join(preamble), [(h, "".join(body)) for h, body in sections]


def _split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    return _wr_split_sections(text) if _wr_split_sections is not None else _local_split_sections(text)


def apply_history(page_text: str, e: HistoryEntry) -> str:
    """Append the rendered entry at the end of the '## History...' section's
    CONTENT (before any trailing blank spacer lines that separate it from the
    next heading), matched by heading PREFIX so this lands in the existing
    '## History (dated, newest first)' section the meeting pipeline already
    writes on these SAME pages (page_path_for below resolves to the identical
    clients/orgs/projects file) instead of opening a second, competing History
    section. Creates the section at the end of the page when absent. NEVER
    removes or rewrites a line: every original line of page_text — blank
    lines included — still appears, in the same order, in the output
    (G-HIST-2)."""
    new_lines = render_history_entry(e)
    new_block = [f"{ln}\n" for ln in new_lines]
    preamble, sections = _split_sections(page_text)
    rebuilt: list[str] = []
    found = False
    for heading, body in sections:
        if not found and heading.startswith("History"):
            found = True
            body_lines = body.splitlines(keepends=True)
            trail: list[str] = []
            while body_lines and body_lines[-1].strip() == "":
                trail.insert(0, body_lines.pop())
            if body_lines and not body_lines[-1].endswith("\n"):
                body_lines[-1] = body_lines[-1] + "\n"
            body = "".join(body_lines) + "".join(new_block) + "".join(trail)
        else:
            body = body if body.endswith("\n") or body == "" else body + "\n"
        rebuilt.append(body)
    pre = preamble if preamble.endswith("\n") or preamble == "" else preamble + "\n"
    if found:
        return pre + "".join(rebuilt)
    tail = "".join(rebuilt)
    if tail and not tail.endswith("\n\n"):
        tail = tail if tail.endswith("\n") else tail + "\n"
        tail += "\n"
    new_section = "## History (dated, newest first)\n\n" + "".join(new_block)
    return pre + tail + new_section


def page_path_for(vault: Path, slug: str, kind: str) -> Path:
    """org_brain_root(vault)/<clients|orgs|projects>/<slug>.md — the same path
    convention writeback_render's meeting pipeline uses, so email and meeting
    History entries land on one page per entity."""
    directory = _KIND_DIRS.get(kind, kind if kind.endswith("s") else f"{kind}s")
    return org_brain_root(vault) / directory / f"{slug}.md"
