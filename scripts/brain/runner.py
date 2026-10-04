"""Injectable subprocess boundary for client-state modules (FR-002/FR-005/FR-006/
FR-008). Tests fake ONLY this transport, never the functions that own a
transition."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from subprocess import CompletedProcess
from typing import Protocol


class Runner(Protocol):
    def run(
        self,
        argv: list[str],
        *,
        input: str | None = None,
        env: dict | None = None,
        timeout: int = 120,
    ) -> "CompletedProcess[str]": ...


class SubprocessRunner:
    """Real subprocess.run wrapper. capture_output=True, text=True, check=False."""

    def run(
        self,
        argv: list[str],
        *,
        input: str | None = None,
        env: dict | None = None,
        timeout: int = 120,
    ) -> "CompletedProcess[str]":
        return subprocess.run(
            argv,
            input=input,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )


class LoggingRunner:
    """Wraps another Runner; appends one JSON line per call to
    <state_dir>/argv.log. Never buffers -- each call opens/appends/closes so a
    crash mid-run loses at most the in-flight line."""

    def __init__(self, inner: Runner, state_dir: Path) -> None:
        self.inner = inner
        self.state_dir = Path(state_dir)

    def run(
        self,
        argv: list[str],
        *,
        input: str | None = None,
        env: dict | None = None,
        timeout: int = 120,
    ) -> "CompletedProcess[str]":
        result = self.inner.run(argv, input=input, env=env, timeout=timeout)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.state_dir / "argv.log"
        line = json.dumps({"argv": argv, "returncode": result.returncode}) + "\n"
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line)
        return result
