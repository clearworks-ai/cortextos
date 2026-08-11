#!/usr/bin/env python3
"""nightly-fleet-scan.py — deterministic bulk FLOW for FR-C2 nightly-fleet-analysis.

WHY THIS EXISTS
---------------
The live `nightly-fleet-analysis` cron (frank2, `3 2 * * *`) dispatches a Sonnet
subagent to READ every agent's raw stdout tail (200 lines x 7 agents), restarts.log,
crashes.log, and daily memory, then eyeball-detect crash loops, hook errors, frozen
agents, and frustration. That is the anti-pattern the principle
`feedback_deterministic_cron_core_llm_verify_layer.md` names: dumping the whole
haystack into an LLM prompt. It is also what caused a context bootloop this week.

Every detection pattern in that prompt is deterministic:
  - CRASH LOOP    : count WATCHDOG-HARD-RESTART / CRASH lines per agent in the window (threshold)
  - HOOK ERRORS   : grep "hook error" / "PreToolUse ... error" in ANSI-stripped stdout
  - SILENT AGENT  : heartbeat cron last_fired_at older than N hours (timestamp threshold)
  - FRUSTRATION   : keyword grep in the agent's daily memory file
  - WORKAROUNDS   : count of "warning" markers in AGENTS.md

So the SCAN is done here, in code, over the full corpus. This script emits ONLY the
few surviving CANDIDATE anomalies (already de-noised, with the exact evidence line
attached) as JSON on stdout. A thin LLM VERIFY step (see module docstring of the
companion note) then judges root_cause / severity / auto_fixable on that short list
— it never sees the raw logs.

Output contract (stdout, JSON):
    {
      "generated_at": "<iso8601>",
      "window_hours": 24,
      "agents_scanned": [...],
      "candidates": [
        {
          "agent": "maven",
          "issue_type": "crash_loop" | "hook_error" | "silent_agent" | "frustration" | "workaround",
          "count": 5,                     # occurrences in-window (issue-type dependent)
          "evidence": "<one representative raw line, ANSI-stripped, truncated>",
          "detected_at": "<iso8601 of the newest matching event, or null>"
        }
      ]
    }

Determinism: no network, no LLM, no wall-clock branching beyond the explicit `--now`
override (defaults to real now). Given the same log tree + `--now`, output is stable.

Exit code is always 0 on a successful scan (an empty candidate list is a valid,
healthy result — the cron should NOT treat "no candidates" as an error).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Agents the live prompt scans (hunter is permanently shut down — skipped).
DEFAULT_AGENTS: tuple[str, ...] = (
    "frank2",
    "maven",
    "auditos",
    "sage",
    "muse",
    "larry",
    "sre",
)

# --- thresholds (mirror the live prompt's detection patterns) ---------------
CRASH_LOOP_THRESHOLD = 2      # ">2x same agent 24h" -> flag when count > threshold
SILENT_AGENT_HOURS = 5.0      # heartbeat not updated >5h
STDOUT_TAIL_LINES = 400       # bounded read; never load the whole file
EVIDENCE_MAX_LEN = 240

# Restart/crash event tokens found in <agent>/restarts.log and <agent>/crashes.log.
_CRASH_TOKENS = re.compile(r"WATCHDOG-HARD-RESTART|CRASH|type=crash")

# Hook-error signatures in ANSI-stripped stdout.
_HOOK_ERROR = re.compile(r"(PreToolUse|PostToolUse|hook)\b.*\berror", re.IGNORECASE)

# Frustration signals in the daily memory file (word-boundary, case-insensitive).
_FRUSTRATION = re.compile(
    r"\b(sloppy|broken|bad work|can'?t trust|garbage|frustrat\w*|wasted)\b",
    re.IGNORECASE,
)

# Workaround markers in AGENTS.md.
_WORKAROUND_MARKER = re.compile(r"⚠️|:warning:|WORKAROUND", re.IGNORECASE)

# ANSI CSI / OSC escape sequences (the TUI stdout is dense with these).
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

# Leading ISO-8601 timestamp on restart/crash lines, e.g.
# "[2026-08-04T17:22:20Z] CRASH..."  or  "2026-08-04T19:04:22.270Z type=crash".
_TS_PREFIX = re.compile(r"\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)")


def strip_ansi(line: str) -> str:
    return _ANSI.sub("", line)


def parse_ts(text: str) -> datetime | None:
    m = _TS_PREFIX.search(text)
    if not m:
        return None
    raw = m.group(1)
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def truncate(text: str) -> str:
    text = text.strip()
    return text if len(text) <= EVIDENCE_MAX_LEN else text[: EVIDENCE_MAX_LEN - 1] + "…"


def read_lines(path: Path, tail: int | None = None) -> list[str]:
    """Read text lines from `path`, tolerating missing files and bad bytes."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except (FileNotFoundError, IsADirectoryError, PermissionError, OSError):
        return []
    lines = raw.splitlines()
    if tail is not None and len(lines) > tail:
        lines = lines[-tail:]
    return lines


def read_heartbeat_last_fired(state_dir: Path, agent: str) -> datetime | None:
    """Heartbeat freshness = crons.json `heartbeat` cron's last_fired_at.

    There is no heartbeat.json in this fleet; the reliable liveness signal is the
    heartbeat cron's last_fired_at in the agent's crons.json.
    """
    crons_path = state_dir / agent / "crons.json"
    try:
        data = json.loads(crons_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    crons = data if isinstance(data, list) else data.get("crons", [])
    if not isinstance(crons, list):
        return None
    for cron in crons:
        if isinstance(cron, dict) and cron.get("name") == "heartbeat":
            lf = cron.get("last_fired_at")
            if isinstance(lf, str):
                return parse_ts(lf)
            return None
    return None


def detect_crash_loops(
    logs_dir: Path, agent: str, window_start: datetime
) -> dict[str, Any] | None:
    """Count in-window crash/restart events across restarts.log + crashes.log."""
    count = 0
    newest: datetime | None = None
    sample = ""
    for fname in ("restarts.log", "crashes.log"):
        for line in read_lines(logs_dir / agent / fname):
            if not _CRASH_TOKENS.search(line):
                continue
            ts = parse_ts(line)
            if ts is None or ts < window_start:
                continue
            count += 1
            if newest is None or ts > newest:
                newest = ts
                sample = strip_ansi(line)
    if count > CRASH_LOOP_THRESHOLD:
        return {
            "agent": agent,
            "issue_type": "crash_loop",
            "count": count,
            "evidence": truncate(sample),
            "detected_at": newest.isoformat() if newest else None,
        }
    return None


def detect_hook_errors(logs_dir: Path, agent: str) -> dict[str, Any] | None:
    """Grep ANSI-stripped stdout tail for hook-error signatures."""
    count = 0
    sample = ""
    for line in read_lines(logs_dir / agent / "stdout.log", tail=STDOUT_TAIL_LINES):
        clean = strip_ansi(line)
        if _HOOK_ERROR.search(clean):
            count += 1
            if not sample:
                sample = clean
    if count > 0:
        return {
            "agent": agent,
            "issue_type": "hook_error",
            "count": count,
            "evidence": truncate(sample),
            "detected_at": None,
        }
    return None


def detect_silent_agent(
    state_dir: Path, agent: str, now: datetime
) -> dict[str, Any] | None:
    last = read_heartbeat_last_fired(state_dir, agent)
    if last is None:
        return None
    age_h = (now - last).total_seconds() / 3600.0
    if age_h > SILENT_AGENT_HOURS:
        return {
            "agent": agent,
            "issue_type": "silent_agent",
            "count": round(age_h, 1),
            "evidence": truncate(f"heartbeat last_fired_at {last.isoformat()} ({age_h:.1f}h ago)"),
            "detected_at": last.isoformat(),
        }
    return None


def detect_frustration(
    memory_dir: Path, agent: str, day: str
) -> dict[str, Any] | None:
    """Keyword-grep the agent's daily memory file for frustration signals."""
    path = memory_dir / agent / "memory" / f"{day}.md"
    count = 0
    sample = ""
    for line in read_lines(path):
        if _FRUSTRATION.search(line):
            count += 1
            if not sample:
                sample = line
    if count > 0:
        return {
            "agent": agent,
            "issue_type": "frustration",
            "count": count,
            "evidence": truncate(sample),
            "detected_at": None,
        }
    return None


def scan(
    *,
    logs_dir: Path,
    state_dir: Path,
    memory_dir: Path,
    agents: tuple[str, ...],
    now: datetime,
    window_hours: float,
) -> dict[str, Any]:
    window_start = now - timedelta(hours=window_hours)
    day = now.strftime("%Y-%m-%d")
    candidates: list[dict[str, Any]] = []

    for agent in agents:
        for det in (
            detect_crash_loops(logs_dir, agent, window_start),
            detect_hook_errors(logs_dir, agent),
            detect_silent_agent(state_dir, agent, now),
            detect_frustration(memory_dir, agent, day),
        ):
            if det is not None:
                candidates.append(det)

    # Deterministic ordering so output is byte-stable across runs.
    candidates.sort(key=lambda c: (c["agent"], c["issue_type"]))

    return {
        "generated_at": now.isoformat(),
        "window_hours": window_hours,
        "agents_scanned": list(agents),
        "candidates": candidates,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Deterministic nightly fleet scan — emits candidate anomalies for thin LLM verify.",
    )
    p.add_argument("--logs-dir", required=True, type=Path, help="~/.cortextos/<inst>/logs")
    p.add_argument(
        "--state-dir",
        required=True,
        type=Path,
        help="~/.cortextos/<inst>/.cortextOS/state/agents (for heartbeat last_fired_at)",
    )
    p.add_argument(
        "--memory-dir",
        required=True,
        type=Path,
        help="dir holding <agent>/memory/<date>.md files",
    )
    p.add_argument(
        "--agents",
        default=",".join(DEFAULT_AGENTS),
        help="comma-separated agent list (default: the live-prompt set, hunter excluded)",
    )
    p.add_argument("--window-hours", type=float, default=24.0)
    p.add_argument(
        "--now",
        default=None,
        help="ISO-8601 override for the scan anchor (default: real now). Enables determinism in tests.",
    )
    return p.parse_args(argv)


def resolve_now(raw: str | None) -> datetime:
    if raw is None:
        return datetime.now(timezone.utc)
    dt = parse_ts(raw) if raw.startswith(("[", "0", "1", "2")) else None
    if dt is None:
        # accept a plain ISO string too
        s = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    agents = tuple(a.strip() for a in args.agents.split(",") if a.strip())
    result = scan(
        logs_dir=args.logs_dir,
        state_dir=args.state_dir,
        memory_dir=args.memory_dir,
        agents=agents,
        now=resolve_now(args.now),
        window_hours=args.window_hours,
    )
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
