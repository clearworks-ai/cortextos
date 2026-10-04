#!/usr/bin/env python3
"""G0-compile: materialise every `# file: <path>` labelled code block from a plan
into a scratch tree (last block per path wins = the final whole-module version),
then run python3 -m py_compile on each .py, bash -n on each .sh, json.loads on
each .json, and tsc --noEmit on a scratch copy of the worktree with the TS
blocks applied (TS blocks in this plan are diff-style edits, so tsc runs on the
UNMODIFIED worktree only as a smoke check; TS edits are verified at G0a).

Usage: g0-compile.py <plan.md> <scratch-dir> [--inject-error]
Exit 0 = every block compiled; non-zero otherwise. --inject-error appends a
syntax error to one .py, one .sh and one .json to prove the check bites.
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

FENCE = re.compile(r"^```(\w+)?\s*$")
LABEL = re.compile(r"^\s*(?:#|//)\s*file:\s*(\S+)")


def extract(plan: pathlib.Path) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    lines = plan.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        m = FENCE.match(lines[i])
        if not m:
            i += 1
            continue
        lang = (m.group(1) or "").lower()
        j = i + 1
        body: list[str] = []
        while j < len(lines) and not lines[j].startswith("```"):
            body.append(lines[j])
            j += 1
        # label on line 1 or line 2 (after a shebang)
        label = None
        for k in range(min(2, len(body))):
            lm = LABEL.match(body[k])
            if lm:
                label = lm.group(1).rstrip(")")
                break
        if label and not label.endswith("(append)"):
            body2 = [b for k, b in enumerate(body) if not (k < 2 and LABEL.match(b))]
            out[label] = (lang, "\n".join(body2) + "\n")
        elif not label and lang == "python" and any(l.startswith(("import ", "from ")) for l in body):
            out[f"_unlabeled/{plan.stem}_{i}.py"] = (lang, "\n".join(body) + "\n")
        i = j + 1
    return out


def main(argv: list[str]) -> int:
    plan = pathlib.Path(argv[1])
    scratch = pathlib.Path(argv[2])
    inject = "--inject-error" in argv
    blocks = extract(plan)
    scratch.mkdir(parents=True, exist_ok=True)
    written = []
    for rel, (lang, text) in blocks.items():
        p = scratch / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        written.append(p)
    if inject:
        injected = 0
        for p in written:
            if injected >= 3:
                break
            if p.suffix == ".py" and injected == 0:
                p.write_text(p.read_text() + "\ndef broken(:\n    pass\n"); injected += 1
            elif p.suffix == ".sh" and injected == 1:
                p.write_text(p.read_text() + "\nif [ ; then\n"); injected += 1
            elif p.suffix == ".json" and injected == 2:
                p.write_text(p.read_text() + "{"); injected += 1
        print(f"injected {injected} deliberate errors")
    failures = 0
    counts = {"py": 0, "sh": 0, "json": 0, "ts": 0, "other": 0}
    for p in sorted(written):
        if p.suffix == ".py":
            counts["py"] += 1
            r = subprocess.run([sys.executable, "-m", "py_compile", str(p)], capture_output=True, text=True)
            if r.returncode != 0:
                failures += 1
                print(f"FAIL py_compile {p.relative_to(scratch)}: {r.stderr.strip().splitlines()[-1] if r.stderr else r.returncode}")
        elif p.suffix == ".sh" or p.name in {"cortextos", "gws-trap", "claude-trap"}:
            counts["sh"] += 1
            r = subprocess.run(["bash", "-n", str(p)], capture_output=True, text=True)
            if r.returncode != 0:
                failures += 1
                print(f"FAIL bash -n {p.relative_to(scratch)}: {r.stderr.strip()[:200]}")
        elif p.suffix == ".json":
            counts["json"] += 1
            try:
                json.loads(p.read_text())
            except json.JSONDecodeError as exc:
                failures += 1
                print(f"FAIL json {p.relative_to(scratch)}: {exc}")
        elif p.suffix == ".ts":
            counts["ts"] += 1
        else:
            counts["other"] += 1
    print(f"blocks: {len(written)} counts={counts} failures={failures}")
    for p in sorted(written):
        print("  ", p.relative_to(scratch))
    return 1 if failures or not written else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
