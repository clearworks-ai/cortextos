"""FR-013: filed-meeting digest line. Append-only, idempotent on <kind>:<id>."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from atomic import atomic_write


def digest_line(date: str, title: str, resolution: dict[str, Any], source_key: str) -> str:
    home_path = str(resolution.get("home_path") or "")
    home_slug = Path(home_path).stem if home_path else "none"
    node = resolution.get("node")
    node_part = f" → {node}" if node and node != "none" else ""
    rule = resolution.get("rule")
    conf = resolution.get("confidence")
    line = f'{date} filed "{title}" under {home_slug}{node_part} (rule {rule}, conf {conf})'
    created = resolution.get("created")
    if isinstance(created, dict) and created.get("slug"):
        line += f" NEW {created.get('relationship')} {created.get('slug')}"
    return f"{line} {source_key}"


def append_filed_line(log_path: Path, source_key: str, line: str) -> bool:
    """Returns True if appended, False if source_key already present."""
    existing = log_path.read_text(encoding="utf-8") if log_path.is_file() else ""
    if any(source_key in row for row in existing.splitlines()):
        return False
    sep = "" if existing == "" or existing.endswith("\n") else "\n"
    new_text = existing + sep + line.rstrip("\n") + "\n"
    atomic_write(log_path, new_text.encode("utf-8"))
    return True
