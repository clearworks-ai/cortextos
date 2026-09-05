"""D-15 section-preserving render. Pure functions; R2 --apply must call these."""
from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any


ORG_BRAIN = Path("raw/areas/clearworks/org-brain")

OPEN_ITEMS_HEADER = "| Item | Owner | Deadline | Source | Status |\n|---|---|---|---|---|\n"


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "meeting"


def _date_only(iso: str) -> str:
    return (iso or "")[:10] or "1970-01-01"


def _meeting_rel(meeting: dict[str, Any]) -> str:
    mid = str(meeting.get("id") or "")
    date = _date_only(str(meeting.get("date") or ""))
    title = str(meeting.get("title") or "meeting")
    kind = "fireflies"
    return f"meetings/{date}-{_slug(title)}-{kind}-{mid[:8]}.md"


def _history_block(meeting: dict[str, Any]) -> list[str]:
    date = _date_only(str(meeting.get("date") or ""))
    title = str(meeting.get("title") or "meeting")
    mid = str(meeting.get("id") or "")
    rel = _meeting_rel(meeting)
    summary = meeting.get("summary") or {}
    overview = ""
    if isinstance(summary, dict):
        overview = str(summary.get("overview") or "").strip()
    decisions = meeting.get("decisions") or []
    if not isinstance(decisions, list):
        decisions = []
    dec_txt = " ; ".join(str(d) for d in decisions if str(d).strip()) or "none"
    return [
        f"- {date} — {title} (meeting: {rel}) [source: fireflies:{mid}]",
        f"  - Outcomes: {overview or 'none'}",
        f"  - Decisions: {dec_txt}",
    ]


def _open_item_rows(meeting: dict[str, Any]) -> list[str]:
    items = meeting.get("open_items") or []
    if not isinstance(items, list):
        return []
    rows = []
    for it in items:
        if not isinstance(it, dict):
            continue
        item = str(it.get("item") or "").strip()
        if not item:
            continue
        owner = str(it.get("owner") or "—")
        deadline = str(it.get("deadline") or "—") or "—"
        source = str(it.get("source") or "")
        status = str(it.get("status") or "open")
        rows.append(f"| {item} | {owner} | {deadline} | {source} | {status} |")
    return rows


def _split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
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


def render_page(old_text: str, meeting: dict[str, Any]) -> str:
    mid = str(meeting.get("id") or "")
    marker = f"[source: fireflies:{mid}]" if mid else ""
    if marker and marker in old_text:
        return old_text if old_text.endswith("\n") or old_text == "" else old_text + "\n"
    promo = meeting.get("promotion")
    if isinstance(promo, dict) and promo.get("state"):
        state = str(promo.get("state"))
        old_text = re.sub(
            r"(?m)^delivery_state:\s*.*$",
            f"delivery_state: {state}",
            old_text,
            count=1,
        )
    preamble, sections = _split_sections(old_text)
    hist = _history_block(meeting)
    rows = _open_item_rows(meeting)
    names = [h for h, _ in sections]
    out_sections: list[str] = []
    found_hist = False
    found_open = False
    for heading, body in sections:
        if heading == "History (dated, newest first)":
            found_hist = True
            parts = body.splitlines(keepends=True)
            # heading line + following blank, then new block, then rest
            rest = parts[1:]
            while rest and rest[0].strip() == "":
                rest = rest[1:]
            rebuilt = [parts[0], "\n", *[ln + "\n" for ln in hist], "\n", *rest]
            if rebuilt and not rebuilt[-1].endswith("\n"):
                rebuilt[-1] = rebuilt[-1] + "\n"
            out_sections.append("".join(rebuilt))
        elif heading == "Open Items":
            found_open = True
            extra = ""
            body2 = body if body.endswith("\n") else body + "\n"
            if rows:
                has_header = any(
                    ln.strip().startswith("| Item |") for ln in body.splitlines()
                )
                if not has_header:
                    body2 = body.rstrip("\n") + "\n\n" + OPEN_ITEMS_HEADER
                extra = "\n".join(rows) + "\n"
            out_sections.append(body2 + extra)
        else:
            out_sections.append(body if body.endswith("\n") or body == "" else body + "\n")
    suffix = ""
    if not found_hist:
        suffix += "## History (dated, newest first)\n\n" + "\n".join(hist) + "\n"
    if not found_open and rows:
        suffix += "\n## Open Items\n\n" + OPEN_ITEMS_HEADER
        suffix += "\n".join(rows) + "\n"
    pre = preamble if preamble.endswith("\n") or preamble == "" else preamble + "\n"
    return pre + "".join(out_sections) + suffix


def render_meeting_note(meeting: dict[str, Any]) -> str:
    res = meeting.get("resolution") or {}
    if not isinstance(res, dict):
        res = {}
    mid = str(meeting.get("id") or "")
    date = _date_only(str(meeting.get("date") or ""))
    node = res.get("node") or "none"
    client = str(meeting.get("client_context") or "")
    cp = str(res.get("counterparty") or res.get("counterparty_slug") or "")
    lines = [
        "---",
        f"meeting_id: {mid}",
        f"source: fireflies:{mid}",
        f"client: {client}",
        f"date: {date}",
        f"node: {node}",
        f"counterparty: {cp}",
        f"rule: {res.get('rule') or 'none'}",
        f"deal_state: {meeting.get('deal_state') or ''}",
        f"meeting_type: {meeting.get('meeting_type') or ''}",
        "---",
        "",
        f"# {date} · {meeting.get('title') or ''}",
        "",
    ]
    summary = meeting.get("summary") or {}
    if isinstance(summary, dict) and summary.get("overview"):
        lines.extend(["## Outcomes", "", str(summary.get("overview")), ""])
    return "\n".join(lines)


def render_created_page(template_text: str, meeting: dict[str, Any]) -> str:
    res = meeting.get("resolution") or {}
    created = res.get("created") if isinstance(res, dict) else None
    slug = ""
    kind = "org"
    relationship = ""
    if isinstance(created, dict):
        slug = str(created.get("slug") or "")
        kind = str(created.get("kind") or "org")
        relationship = str(created.get("relationship") or "")
    elif isinstance(created, str) and ":" in created:
        kind, slug = created.split(":", 1)
    title = str(meeting.get("title") or slug or "Untitled")
    name = slug.replace("-", " ").title() or title
    mid = str(meeting.get("id") or "")
    conf = res.get("confidence") if isinstance(res, dict) else None
    text = template_text
    text = text.replace("<Name>", name)
    text = text.replace("<title>", title)
    text = text.replace("<client>-<nn>", slug or "<client>-<nn>")
    text = text.replace("engagement|project", kind)
    text = re.sub(r"^kind:\s*$", f"kind: {kind}", text, flags=re.M)
    text = re.sub(r"^relationship:\s*$", f"relationship: {relationship}", text, flags=re.M)
    text = re.sub(r"^created_from:\s*$", f"created_from: fireflies:{mid}", text, flags=re.M)
    if conf is not None:
        text = re.sub(r"^confidence:\s*$", f"confidence: {conf}", text, flags=re.M)
    if slug and slug not in text:
        text = text + f"\nid: {slug}\n"
    return text


def created_token(meeting: dict[str, Any]) -> str:
    res = meeting.get("resolution") or {}
    if not isinstance(res, dict):
        return "none"
    created = res.get("created")
    if not created:
        return "none"
    if isinstance(created, dict):
        kind = created.get("kind") or "none"
        slug = created.get("slug") or "none"
        return f"{kind}:{slug}"
    return str(created)


def promotion_token(meeting: dict[str, Any]) -> str:
    promo = meeting.get("promotion")
    if not promo:
        return "none"
    if isinstance(promo, dict):
        return str(promo.get("state") or "none")
    return str(promo)


def reason_line(meeting: dict[str, Any], home: Path) -> str:
    res = meeting.get("resolution") or {}
    if not isinstance(res, dict):
        res = {}
    node = res.get("node") or "none"
    rule = res.get("rule") if res.get("rule") is not None else "none"
    return (
        f"home={home} node={node} rule={rule} "
        f"created={created_token(meeting)} promotion={promotion_token(meeting)}"
    )


def unified_diff(path: Path, old: str, new: str) -> str:
    a = old.splitlines(keepends=True)
    b = new.splitlines(keepends=True)
    if not a and not old:
        a = []
    rel = str(path)
    return "".join(difflib.unified_diff(a, b, fromfile=f"a/{rel}", tofile=f"b/{rel}"))


def org_brain_root(org_root: Path) -> Path:
    nested = org_root / ORG_BRAIN
    if nested.exists() or (org_root / "raw").exists():
        return nested
    return org_root


def planned_files(org_root: Path, meeting: dict[str, Any]) -> list[tuple[Path, str, str]]:
    """Return (path, old_text, new_text) for every file --apply would touch."""
    brain = org_brain_root(org_root)
    res = meeting.get("resolution") or {}
    if not isinstance(res, dict):
        res = {}
    home_rel = str(res.get("home_path") or "")
    home = brain / home_rel if home_rel else brain / "clients" / "unknown.md"
    old_home = home.read_text(encoding="utf-8") if home.exists() else ""
    created = res.get("created")
    if created:
        kind = created.get("kind") if isinstance(created, dict) else str(created).split(":")[0]
        tmpl_name = "orgs/_template.md"
        tmpl_path = brain / tmpl_name
        tmpl = tmpl_path.read_text(encoding="utf-8") if tmpl_path.exists() else "# <Name>\n"
        seed = render_created_page(tmpl, meeting)
        base = old_home if old_home else seed
        new_home = render_page(base, meeting)
        files: list[tuple[Path, str, str]] = [(home, old_home, new_home)]
    else:
        new_home = render_page(old_home, meeting)
        files = [(home, old_home, new_home)]
    note_rel = _meeting_rel(meeting)
    note_path = brain / note_rel
    old_note = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
    new_note = old_note if old_note else render_meeting_note(meeting)
    files.append((note_path, old_note, new_note))
    return files


def print_dry_run(org_root: Path, payload: dict[str, Any]) -> None:
    meetings = payload.get("meetings") or []
    if not isinstance(meetings, list):
        return
    for meeting in meetings:
        if not isinstance(meeting, dict):
            continue
        planned = planned_files(org_root, meeting)
        for path, old, new in planned:
            diff = unified_diff(path, old, new)
            if diff:
                print(diff, end="" if diff.endswith("\n") else "\n")
        home = planned[0][0] if planned else org_root
        print(reason_line(meeting, home))


def payload_has_resolution(payload: dict[str, Any]) -> bool:
    meetings = payload.get("meetings") or []
    if not isinstance(meetings, list):
        return False
    return any(isinstance(m, dict) and m.get("resolution") for m in meetings)
