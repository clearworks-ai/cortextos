#!/usr/bin/env python3
"""Concurrency-safe, confidentiality-partitioned Task Observer fleet state."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


def safe(value: str, label: str) -> str:
    if not SAFE.fullmatch(value):
        raise SystemExit(f"invalid {label}")
    return value


def paths(root: Path, org: str, agent: str) -> tuple[Path, Path, Path]:
    base = root / "state" / "task-observer-v1" / "partitions" / safe(org, "org") / safe(agent, "agent")
    return base, base / "observations.jsonl", base / ".lock"


def init(root: Path, org: str, agent: str) -> dict[str, object]:
    base, log, lock = paths(root, org, agent)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    for path in (log, lock):
        path.touch(mode=0o600, exist_ok=True)
        os.chmod(path, 0o600)
    return {"ok": True, "partition": str(base), "count": count(log)}


def count(log: Path) -> int:
    with log.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def append(args: argparse.Namespace) -> dict[str, object]:
    root = Path(args.root).resolve()
    init(root, args.org, args.agent)
    _, log, lock = paths(root, args.org, args.agent)
    if args.visibility == "open_source" and args.context:
        raise SystemExit("open_source observations may not include session context")
    with lock.open("r+", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_EX)
        records = []
        with log.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    records.append(json.loads(line))
        seq = max((int(item["seq"]) for item in records), default=0) + 1
        record = {
            "schema": "cortextos.task-observation.v1",
            "id": str(uuid.uuid4()),
            "seq": seq,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "org": args.org,
            "agent": args.agent,
            "visibility": args.visibility,
            "signal": args.signal,
            "skill": args.skill,
            "issue": args.issue,
            "improvement": args.improvement,
            "principle": args.principle,
            "context": args.context or None,
            "source_event": args.source_event or None,
            "status": "OPEN",
        }
        encoded = json.dumps(record, sort_keys=True, separators=(",", ":"))
        with log.open("a", encoding="utf-8") as handle:
            handle.write(encoded + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        with log.open("r", encoding="utf-8") as handle:
            survived = sum(1 for line in handle if record["id"] in line)
        if survived != 1:
            raise SystemExit("append verification failed")
        fcntl.flock(lock_handle, fcntl.LOCK_UN)
    return {"ok": True, "id": record["id"], "seq": seq, "partition": str(log)}


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", required=True)
    common.add_argument("--org", required=True)
    common.add_argument("--agent", required=True)
    sub.add_parser("init", parents=[common])
    add = sub.add_parser("append", parents=[common])
    add.add_argument("--visibility", choices=("internal", "open_source"), required=True)
    add.add_argument("--signal", choices=("correction", "friction", "success", "gap", "checkpoint"), required=True)
    add.add_argument("--skill", required=True)
    add.add_argument("--issue", required=True)
    add.add_argument("--improvement", required=True)
    add.add_argument("--principle", required=True)
    add.add_argument("--context", default="")
    add.add_argument("--source-event", default="")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    result = init(root, args.org, args.agent) if args.command == "init" else append(args)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
