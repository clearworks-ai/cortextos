"""Parse KEY=VALUE env files. Never bash-source them (unquoted op:// breaks)."""
from __future__ import annotations

from pathlib import Path


def _strip_bom(text: str) -> str:
    return text[1:] if text.startswith("\ufeff") else text


def parse_env_file(path: str | Path) -> dict[str, str]:
    """Mirror src/utils/env.ts parseEnvFile: comments, quotes, BOM, CRLF."""
    result: dict[str, str] = {}
    raw = Path(path).read_text(encoding="utf-8")
    content = _strip_bom(raw)
    for line in content.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        eq = trimmed.find("=")
        if eq <= 0:
            continue
        key = trimmed[:eq].strip()
        value = trimmed[eq + 1 :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            hash_idx = value.find(" #")
            if hash_idx >= 0:
                value = value[:hash_idx].strip()
        result[key] = value
    return result
