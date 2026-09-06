# scripts/brain/brain_rollup.py
"""FR-007: deterministic derived views (phase 3). No LLM, idempotent, touches
only clients that have nodes for the per-client rollup region; the STATE.md
region regenerates unconditionally (G0b C1-2). Pure render functions tested
directly; main() does the atomic I/O — same split as writeback_render.py/D-15."""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path
from typing import Any

from atomic import atomic_write
from paths import DEFAULT_VAULT, load_enabled_agents, org_brain_root
from writeback_render import _split_sections

GENERATED_START = "<!-- generated: {name} -->"
GENERATED_END = "<!-- /generated -->"
# CH-3: matches ANY generated-region opening marker (not just "state"'s own),
# so apply_state_generated_region can tell "our close comes next" apart from
# "another region's open comes first" before trusting a `GENERATED_END` match.
ANY_GENERATED_START_RE = re.compile(r"<!-- generated: [^\n>]*-->")
REQUIRED_NODE_KEYS = {"id", "kind", "client"}
NODE_KIND_VALUES = {"engagement", "project"}
OPEN_STATES = {"scoping", "active", "paused"}
JOSH_ROSTER = {"josh", "josh weiss"}
CLIENT_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class NodeBlockError(ValueError):
    pass


def _kv_block(text: str, heading: str) -> dict[str, str]:
    marker = f"## {heading}"
    if marker not in text:
        return {}
    rest = text.split(marker, 1)[1]
    nxt = rest.find("\n## ")
    block = rest if nxt < 0 else rest[:nxt]
    out: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        key = k.strip().lower()
        if key:
            out[key] = v.strip()
    return out


def parse_node_block(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    out = _kv_block(text, "Node")
    if not out:
        raise NodeBlockError(f"{path}: no ## Node block")
    missing = REQUIRED_NODE_KEYS - set(out)
    if missing:
        raise NodeBlockError(f"{path}: missing Node keys {sorted(missing)}")
    if out["kind"] not in NODE_KIND_VALUES:
        raise NodeBlockError(f"{path}: illegal kind {out['kind']!r}")
    return {k: out.get(k, "") for k in ("id", "kind", "client", "parent", "title")}


def load_nodes(vault: Path) -> dict[str, dict[str, Any]]:
    proj_dir = org_brain_root(vault) / "projects"
    nodes: dict[str, dict[str, Any]] = {}
    if not proj_dir.is_dir():
        return nodes
    for path in sorted(proj_dir.glob("*.md")):
        if path.stem.startswith("_"):
            continue
        node = parse_node_block(path)
        text = path.read_text(encoding="utf-8")
        reporting = _kv_block(text, "Reporting")
        node["delivery_state"] = _kv_block(text, "Node").get("delivery_state", "")
        node["last_update"] = reporting.get("last_update", "")
        node["path"] = path
        nodes[node["id"] or path.stem] = node
    return nodes


def render_engagements_rollup(client_slug: str, nodes: dict[str, dict[str, Any]]) -> str:
    engagements = sorted(
        (n for n in nodes.values() if n.get("client") == client_slug and n.get("kind") == "engagement"),
        key=lambda n: n["id"],
    )
    if not engagements:
        return "(no engagements)"
    lines = ["| Engagement | Project | Delivery state | Last update |", "|---|---|---|---|"]
    for eng in engagements:
        state = eng.get("delivery_state") or "—"
        last_update = eng.get("last_update") or "—"
        children = sorted(
            (n for n in nodes.values() if n.get("kind") == "project" and n.get("parent") == eng["id"]),
            key=lambda n: n["id"],
        )
        if not children:
            lines.append(f"| {eng.get('title') or eng['id']} | — | {state} | {last_update} |")
            continue
        for child in children:
            c_state = child.get("delivery_state") or "—"
            c_update = child.get("last_update") or "—"
            lines.append(f"| {eng.get('title') or eng['id']} | {child.get('title') or child['id']} | {c_state} | {c_update} |")
    return "\n".join(lines)


def _latest_history(body: str) -> tuple[str, str] | None:
    for line in body.splitlines():
        m = re.match(r"^- (\d{4}-\d{2}-\d{2}) — (.*)$", line)
        if m:
            return m.group(1), m.group(2)
    return None


def _decisions_since(body: str, cutoff_date: str) -> list[str]:
    out: list[str] = []
    current_date = ""
    for line in body.splitlines():
        m = re.match(r"^- (\d{4}-\d{2}-\d{2}) — (.*)$", line)
        if m:
            current_date = m.group(1)
            continue
        dm = re.match(r"^\s*- Decisions:\s*(.*)$", line)
        if dm and current_date >= cutoff_date and dm.group(1).strip().lower() not in ("", "none"):
            out.append(f"{current_date} — {dm.group(1).strip()}")
    return out


# G2R2-P2-1: column delimiter is an UNESCAPED `|` only — `\|` inside a cell
# (e.g. an item or owner name that legitimately contains a pipe) must stay
# literal, not be mistaken for a column boundary.
_UNESCAPED_PIPE_RE = re.compile(r"(?<!\\)\|")


def _unescape_pipe_cell(text: str) -> str:
    return text.strip().replace("\\|", "|")


def _open_rows(body: str) -> list[dict[str, str]]:
    rows = []
    for line in body.splitlines():
        stripped = line.strip()
        if len(stripped) < 2 or not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = _UNESCAPED_PIPE_RE.split(stripped[1:-1])
        if len(cells) != 5:
            continue
        item, owner, deadline, source, status = (_unescape_pipe_cell(c) for c in cells)
        if item.lower() == "item":
            continue
        rows.append({"item": item, "owner": owner, "deadline": deadline, "source": source, "status": status})
    return rows


def _is_josh_or_fleet(owner: str, enabled_agents: set[str]) -> bool:
    o = owner.strip().lower()
    return o in JOSH_ROSTER or o in {a.lower() for a in enabled_agents}


def _section_text(path: Path, heading: str) -> str:
    _, sections = _split_sections(path.read_text(encoding="utf-8"))
    for h, body in sections:
        if h.startswith(heading):
            return body
    return ""


def _minus_days(iso_date: str, days: int) -> str:
    from datetime import datetime, timedelta

    dt = datetime.strptime(iso_date, "%Y-%m-%d") - timedelta(days=days)
    return dt.strftime("%Y-%m-%d")


def _today_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def render_state_sections(nodes: dict[str, dict[str, Any]], today: str) -> str:
    enabled = load_enabled_agents()
    open_nodes = {nid: n for nid, n in nodes.items() if (n.get("delivery_state") or "") in OPEN_STATES}
    engagements = sorted((n for n in open_nodes.values() if n["kind"] == "engagement"), key=lambda n: n["id"])
    cutoff = _minus_days(today, 30)

    active: list[str] = []
    waiting: list[str] = []
    decisions: list[str] = []
    next_josh: list[tuple[str, str]] = []

    def _emit_node(node: dict[str, Any], indent: str) -> None:
        body = _section_text(node["path"], "History")
        latest = _latest_history(body)
        line = f"{indent}- **{node.get('title') or node['id']}** ({node['id']})"
        if latest:
            line += f" — {latest[0]}: {latest[1]}"
        active.append(line)
        decisions.extend(f"- {d}" for d in _decisions_since(body, cutoff))
        for row in _open_rows(_section_text(node["path"], "Open Items")):
            if row["status"].strip().lower() != "open":
                continue
            owner = row["owner"].strip()
            item = row["item"].strip()
            deadline = row["deadline"].strip()
            deadline = "" if deadline in ("—", "-") else deadline
            if _is_josh_or_fleet(owner, enabled):
                next_josh.append((deadline, f"{item} — {owner}"))
            else:
                waiting.append(f"- {item} — {owner}" + (f" (due {deadline})" if deadline else ""))

    for eng in engagements:
        _emit_node(eng, "")
        for child in sorted(
            (n for n in open_nodes.values() if n["kind"] == "project" and n.get("parent") == eng["id"]),
            key=lambda n: n["id"],
        ):
            _emit_node(child, "  ")

    active_out = ["## Active work", ""] + (active or ["(none)"])
    waiting_out = ["## Waiting on", ""] + (waiting or ["(none)"])
    decisions_out = ["## Decisions made", ""] + (decisions or ["(none)"])

    next_josh.sort(key=lambda t: (t[0] == "", t[0]))
    next_out = ["## Next priorities", ""]
    if not next_josh:
        next_out.append("(none)")
    else:
        for i, (deadline, text) in enumerate(next_josh, start=1):
            tag = " OVERDUE" if deadline and deadline < today else ""
            due = f" (due {deadline})" if deadline else ""
            next_out.append(f"{i}.{tag} {text}{due}")

    return "\n\n".join("\n".join(section) for section in (active_out, waiting_out, decisions_out, next_out))


def compute_generated_from(inputs: list[Path]) -> str:
    h = hashlib.sha256()
    for p in sorted(inputs):
        h.update(p.read_bytes())
    return h.hexdigest()


def validate_client_slug(slug: str, clients_root: Path) -> Path:
    """CH-1: a node's `client:` field is untrusted text copied verbatim
    from a projects/*.md file — never let it steer a filesystem path.
    Require a plain lowercase-alnum/hyphen slug AND assert the resolved
    path stays under org-brain/clients/ (defense in depth even though the
    regex alone already forbids '/' and '.'). Raises NodeBlockError (caught
    by main() -> exit 6, no write) on any violation."""
    if not CLIENT_SLUG_RE.match(slug):
        raise NodeBlockError(f"invalid client slug '{slug}'")
    root = clients_root.resolve(strict=False)
    candidate = (clients_root / f"{slug}.md").resolve(strict=False)
    if candidate.parent != root:
        raise NodeBlockError(f"invalid client slug '{slug}'")
    return candidate


def apply_generated_region(
    old_text: str, name: str, body: str, *, create_after: str | None = None
) -> str:
    start = GENERATED_START.format(name=name)
    if start in old_text and GENERATED_END in old_text:
        pre, rest = old_text.split(start, 1)
        _, post = rest.split(GENERATED_END, 1)
        return f"{pre}{start}\n{body}\n{GENERATED_END}{post}"
    block = f"{start}\n{body}\n{GENERATED_END}\n"
    if create_after and create_after in old_text:
        pre, post = old_text.split(create_after, 1)
        sep = "" if pre.endswith("\n\n") or pre == "" else ("\n" if pre.endswith("\n") else "\n\n")
        return f"{pre}{create_after}{sep}{block}{post}"
    sep = "" if old_text.endswith("\n\n") or old_text == "" else ("\n" if old_text.endswith("\n") else "\n\n")
    return old_text + sep + block


def apply_state_generated_region(old_text: str, body: str) -> str:
    """CH-3 / FR-007: STATE.md's generated:state block always regenerates
    at the END of the file — never in place. An existing block (matched
    ONLY when the opening marker is exactly `<!-- generated: state -->`,
    closed by the first `<!-- /generated -->` after it) is removed from
    wherever it sits and a fresh block is appended at the end, so any
    legacy section that used to follow it ends up ahead of it instead. An
    opening marker with no closing marker is a hard error — the generic
    `<!-- /generated -->` belonging to some other region must never be
    treated as this one's close."""
    start = GENERATED_START.format(name="state")
    if start in old_text:
        pre, rest = old_text.split(start, 1)
        end_idx = rest.find(GENERATED_END)
        # CH-3: the first marker encountered after OUR opening marker must be
        # our own close. If some other region's `<!-- generated: ... -->`
        # opens before any `<!-- /generated -->` is seen, that later close
        # belongs to the OTHER region, not this one — treat it the same as
        # having no close at all rather than silently borrowing it.
        next_open = ANY_GENERATED_START_RE.search(rest)
        next_open_idx = next_open.start() if next_open else -1
        if end_idx < 0 or (next_open_idx != -1 and next_open_idx < end_idx):
            raise NodeBlockError("unterminated generated region")
        _, post = rest.split(GENERATED_END, 1)
        remainder = pre + post
    else:
        remainder = old_text
    remainder = remainder.strip("\n")
    block = f"{start}\n{body}\n{GENERATED_END}\n"
    sep = "" if remainder == "" else "\n\n"
    return remainder + sep + block


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--client")
    p.add_argument("--all", action="store_true")
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    # CH-4: no wall-clock default. An implicit now() means two rerruns of
    # the same canonical inputs either side of a UTC midnight can diff
    # (30-day Decisions-made cutoff, OVERDUE labels) despite zero real
    # change — the orchestrator already always passes --today explicitly.
    p.add_argument("--today", required=True)
    args = p.parse_args(argv)
    vault = Path(args.vault)

    try:
        nodes = load_nodes(vault)
    except NodeBlockError as exc:
        print(f"FAILED at rollup: {exc}", file=sys.stderr)
        return 6

    # G0b C1-2: the per-client rollup region is genuinely gated on a client
    # (nothing to rewrite without one) — but STATE.md below is NOT: it is
    # never skipped just because --client/--all was omitted or matched no
    # client, since it sources every projects/*.md node in the vault.
    clients_with_nodes = sorted({n["client"] for n in nodes.values() if n.get("client")})
    targets = clients_with_nodes if args.all else ([args.client] if args.client else [])

    brain = org_brain_root(vault)
    clients_root = brain / "clients"
    for slug in targets:
        if slug not in clients_with_nodes:
            continue
        try:
            client_path = validate_client_slug(slug, clients_root)
        except NodeBlockError as exc:
            print(f"FAILED at rollup: {exc}", file=sys.stderr)
            return 6
        old = (
            client_path.read_text(encoding="utf-8")
            if client_path.is_file()
            else f"# Client: {slug.title()}\n\n## Current state\n\n"
        )
        body = render_engagements_rollup(slug, nodes)
        new = apply_generated_region(old, "engagements-rollup", body, create_after="## Current state\n")
        if new != old:
            atomic_write(client_path, new.encode("utf-8"))

    today = args.today
    state_path = brain / "STATE.md"
    old_state = state_path.read_text(encoding="utf-8") if state_path.is_file() else ""
    body = render_state_sections(nodes, today)
    gen_sha = compute_generated_from(sorted(n["path"] for n in nodes.values())) if nodes else ""
    full_body = f"generated-from: {gen_sha}\n\n{body}"
    try:
        new_state = apply_state_generated_region(old_state, full_body)
    except NodeBlockError as exc:
        print(f"FAILED at rollup: {exc}", file=sys.stderr)
        return 6
    if new_state != old_state:
        atomic_write(state_path, new_state.encode("utf-8"))
    print(f"rollup: {len(targets)} client(s), state generated-from={gen_sha[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
