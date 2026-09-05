#!/usr/bin/env python3
"""FR-002: one tool-less claude -p extract. Never re-extract implicitly."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write
from paths import DEFAULT_VAULT

HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE / "extraction.schema.json"
PROMPT_TEMPLATE = """Extract meeting intelligence as JSON matching the schema.
Unknown keys are forbidden. The string "unknown" is illegal for every enum.
Quotes for decisions/commitments/promotions must be normalized substrings of text_units.

Participants (index = owner_participant):
{participants}

Native summary:
{native_summary}

text_units:
{text_units}

Schema:
{schema}
"""

RELATIONSHIPS = {"client", "prospect", "vendor", "partner", "colleague", "personal", "internal"}
DEAL_STATES = {None, "none", "prospect", "proposal", "won", "lost"}
MEETING_TYPES = {"sales", "delivery", "internal", "other"}
LADDER = {
    "scoping",
    "active",
    "paused",
    "delivered",
    "accepted",
    "adopted",
    "closed",
    "rolled_back",
    "abandoned",
}
REQUIRED_ROOT = {
    "schema",
    "classification",
    "summary",
    "decisions",
    "commitments",
    "proposed_delivery_state",
    "deal_state",
    "meeting_type",
}
# envelope fields added after the model returns
STAMP_KEYS = {"inputSha", "promptSha", "model", "cost_usd", "extracted_at"}


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prompt_sha() -> str:
    schema = SCHEMA_PATH.read_bytes()
    return _sha256_bytes(PROMPT_TEMPLATE.encode() + schema)


def _forbid_unknown_string(value: Any, where: str) -> None:
    if value == "unknown":
        raise ValueError(f"illegal enum unknown at {where}")


def validate_extraction(obj: dict[str, Any], *, stamped: bool = True) -> None:
    if not isinstance(obj, dict):
        raise ValueError("extraction is not an object")
    allowed = REQUIRED_ROOT | STAMP_KEYS
    extra = set(obj) - allowed
    if extra:
        raise ValueError(f"unknown keys: {sorted(extra)}")
    missing = REQUIRED_ROOT - set(obj)
    if stamped:
        missing |= STAMP_KEYS - set(obj)
    if missing:
        raise ValueError(f"missing keys: {sorted(missing)}")
    if obj.get("schema") != "brain.extraction/1":
        raise ValueError("schema must be brain.extraction/1")
    cls = obj.get("classification")
    if not isinstance(cls, dict):
        raise ValueError("classification")
    if set(cls) - {"org_name", "domain", "relationship", "confidence", "evidence"}:
        raise ValueError("unknown classification keys")
    _forbid_unknown_string(cls.get("relationship"), "classification.relationship")
    if cls.get("relationship") not in RELATIONSHIPS:
        raise ValueError("classification.relationship")
    summ = obj.get("summary")
    if not isinstance(summ, dict) or set(summ) - {"overview", "bullets"}:
        raise ValueError("summary")
    for i, dec in enumerate(obj.get("decisions") or []):
        if not isinstance(dec, dict) or set(dec) - {"text", "quote"}:
            raise ValueError(f"decisions[{i}]")
        _forbid_unknown_string(dec.get("text"), f"decisions[{i}].text")
    for i, c in enumerate(obj.get("commitments") or []):
        if not isinstance(c, dict):
            raise ValueError(f"commitments[{i}]")
        extra_c = set(c) - {"text", "owner_participant", "owner_name", "deadline_iso", "quote"}
        if extra_c:
            raise ValueError(f"commitments[{i}] unknown keys")
    pds = obj.get("proposed_delivery_state")
    if pds is not None:
        if not isinstance(pds, dict) or set(pds) - {"state", "quote"}:
            raise ValueError("proposed_delivery_state")
        _forbid_unknown_string(pds.get("state"), "proposed_delivery_state.state")
        if pds.get("state") not in LADDER:
            raise ValueError("proposed_delivery_state.state")
    _forbid_unknown_string(obj.get("deal_state"), "deal_state")
    if obj.get("deal_state") not in DEAL_STATES:
        raise ValueError("deal_state")
    _forbid_unknown_string(obj.get("meeting_type"), "meeting_type")
    if obj.get("meeting_type") not in MEETING_TYPES:
        raise ValueError("meeting_type")


def _strip_fence(text: str) -> str:
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _parse_claude_stdout(stdout: str) -> dict[str, Any]:
    wrapper = json.loads(stdout)
    if not isinstance(wrapper, dict):
        raise ValueError("claude stdout not an object")
    if wrapper.get("is_error"):
        raise ValueError(str(wrapper.get("result") or "claude is_error"))
    if wrapper.get("subtype") != "success":
        raise ValueError(f"subtype={wrapper.get('subtype')}")
    result = wrapper.get("result")
    if isinstance(result, dict):
        return result
    if not isinstance(result, str):
        raise ValueError("result is not JSON")
    parsed = json.loads(_strip_fence(result))
    if not isinstance(parsed, dict):
        raise ValueError("result JSON is not an object")
    return parsed


def _claude_failure_reason(proc: subprocess.CompletedProcess[str]) -> str:
    if proc.stdout:
        try:
            wrapper = json.loads(proc.stdout)
            if isinstance(wrapper, dict) and wrapper.get("result"):
                return str(wrapper["result"])
        except json.JSONDecodeError:
            pass
    return (proc.stderr or "").strip() or f"claude exit {proc.returncode}"


def _build_prompt(source: dict[str, Any]) -> str:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    return PROMPT_TEMPLATE.format(
        participants=json.dumps(source.get("participants") or [], ensure_ascii=False, indent=2),
        native_summary=json.dumps(source.get("native_summary") or {}, ensure_ascii=False, indent=2),
        text_units=json.dumps(source.get("text_units") or [], ensure_ascii=False, indent=2),
        schema=schema,
    )


def _receipt_path(vault: Path, source: dict[str, Any]) -> Path:
    src = source.get("source") or {}
    kind = str(src.get("kind") or "fireflies")
    mid = str(src.get("id") or "")
    return Path(vault) / "raw/media/transcripts/_state" / f"{kind}-{mid}" / "receipt.json"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True)
    p.add_argument("--re-extract", action="store_true")
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    args = p.parse_args(argv)

    source_dir = Path(args.source)
    source_path = source_dir / "source.json"
    extraction_path = source_dir / "extraction.json"
    if not source_path.is_file():
        print("missing source.json", file=sys.stderr)
        return 3

    raw = source_path.read_bytes()
    input_sha = _sha256_bytes(raw)
    source = json.loads(raw.decode())
    p_sha = prompt_sha()

    if extraction_path.exists():
        existing = json.loads(extraction_path.read_text(encoding="utf-8"))
        existing_sha = str(existing.get("inputSha") or "")
        if existing_sha == input_sha:
            if str(existing.get("promptSha") or "") != p_sha:
                print("warn: stale-prompt", file=sys.stderr)
            return 0
        if not args.re_extract:
            print("stale-extraction", file=sys.stderr)
            return 3
        if _receipt_path(Path(args.vault), source).exists():
            print("refuse --re-extract: receipt exists", file=sys.stderr)
            return 3

    if args.re_extract and _receipt_path(Path(args.vault), source).exists():
        print("refuse --re-extract: receipt exists", file=sys.stderr)
        return 3

    prompt = _build_prompt(source)
    # --bare never reads keychain OAuth (needs ANTHROPIC_API_KEY, which spec G-29 says does not exist); --setting-sources "" skips user/project/local settings (hooks, plugins, CLAUDE.md) while keeping keychain auth.
    cmd = [
        "claude",
        "-p",
        "--setting-sources",
        "",
        "--disallowedTools",
        "*",
        "--model",
        "sonnet",
        "--output-format",
        "json",
        "--max-turns",
        "1",
    ]
    with tempfile.TemporaryDirectory() as cwd:
        try:
            proc = subprocess.run(
                cmd,
                input=prompt,
                cwd=cwd,
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            print(f"claude failed: {exc}", file=sys.stderr)
            return 3
    if proc.returncode != 0:
        print(_claude_failure_reason(proc), file=sys.stderr)
        return 3
    try:
        model_obj = _parse_claude_stdout(proc.stdout)
        validate_extraction(model_obj, stamped=False)
    except (ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 3

    stamped = dict(model_obj)
    stamped["schema"] = "brain.extraction/1"
    stamped["inputSha"] = input_sha
    stamped["promptSha"] = p_sha
    stamped["model"] = "sonnet"
    stamped["cost_usd"] = float(model_obj.get("cost_usd") or 0)
    stamped["extracted_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        validate_extraction(stamped, stamped=True)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    atomic_write(extraction_path, json.dumps(stamped, sort_keys=True, indent=2).encode() + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
