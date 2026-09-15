"""Shared test double for runner.Runner (FakeRunner), plus vault/CRM fixture
builders appended by Task 7 (make_vault/make_crm_dir need json, shutil, Path --
imported here so later diffs only ADD functions, never an import line)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from subprocess import CompletedProcess
from typing import Sequence


class FakeRunner:
    """Test double for runner.Runner (C1 -- the ONE fake every task uses).

    `responses` is EITHER a list of `(argv_prefix, CompletedProcess)` pairs OR a
    dict `{argv_prefix: CompletedProcess}`; a dict is normalized to a list in
    insertion order, so the semantics below are identical for both.

    MATCHING (exact contract, G0A2-1/G0B2-1):
      * `run(argv)` scans the list FRONT TO BACK and takes the FIRST entry whose
        prefix equals `argv[:len(prefix)]` -- first match in insertion order.
      * That entry is CONSUMED (removed) **only if another entry with an
        IDENTICAL prefix appears LATER in the list.** Otherwise it stays.

    The two consequences the consumers rely on:
      1. A prefix recorded ONCE is STICKY -- it answers every call shaped like
         it, however many times the code under test issues one (Task 8's
         day-sweep issues 1+days triage queries; Task 15 writes one CRM
         interaction per contact; Task 19 enumerates two task classes).
      2. A prefix recorded N times plays those N responses IN ORDER, and the
         LAST one is sticky (Task 2's `stale-cleared` refusal followed by the
         winning claim; Task 11's widen-and-rerun).

    `.calls` collects each call's argv as a bare `list[str]` (no wrapper dict).
    An unmatched argv returns rc 127 rather than raising, so a missing fixture
    fails loudly at an assert instead of deep inside a stack trace."""

    def __init__(
        self,
        responses: (
            "list[tuple[Sequence[str], CompletedProcess]] "
            "| dict[tuple[str, ...], CompletedProcess] | None"
        ) = None,
    ) -> None:
        if responses is None:
            pairs: list[tuple[list[str], CompletedProcess]] = []
        elif isinstance(responses, dict):
            pairs = [(list(prefix), result) for prefix, result in responses.items()]
        else:
            pairs = [(list(prefix), result) for prefix, result in responses]
        self.responses: list[tuple[list[str], CompletedProcess]] = pairs
        self.calls: list[list[str]] = []

    def record(self, prefix: Sequence[str], rc: int = 0, stdout: str = "", stderr: str = "") -> None:
        prefix_list = list(prefix)
        self.responses.append((prefix_list, CompletedProcess(prefix_list, rc, stdout, stderr)))

    def run(
        self,
        argv: list[str],
        *,
        input: str | None = None,
        env: dict | None = None,
        timeout: int = 120,
    ) -> CompletedProcess:
        self.calls.append(list(argv))
        for i, (prefix, result) in enumerate(self.responses):
            if list(argv[: len(prefix)]) == prefix:
                # Consume ONLY when a later entry repeats this exact prefix, so a
                # multi-response sequence plays in order and its last entry is
                # sticky; a prefix recorded once answers every matching call.
                if any(later == prefix for later, _ in self.responses[i + 1 :]):
                    del self.responses[i]
                return result
        return CompletedProcess(argv, 127, "", f"FakeRunner: no response for {argv!r}")
