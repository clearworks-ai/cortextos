#!/usr/bin/env python3
"""Fail closed unless the complete pre-solution audit analysis set exists."""

import argparse
import fnmatch
import sys
from pathlib import Path

PATTERNS = (
    "01*atlas*",
    "03*systems*",
    "04*integration*",
    "04a*ai*adoption*",
    "05*workflow*",
    "13*architecture*",
)


def missing_sections(deliverables_dir):
    directory = Path(deliverables_dir)
    if not directory.is_dir():
        return list(PATTERNS)
    names = [path.name for path in directory.iterdir() if path.is_file()]
    return [pattern for pattern in PATTERNS if not any(fnmatch.fnmatch(name, pattern) for name in names)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("deliverables_dir")
    args = parser.parse_args()
    missing = missing_sections(args.deliverables_dir)
    if missing:
        for pattern in missing:
            print(f"GATE BLOCKS — missing: {pattern}")
        return 1
    print("PASS — complete analysis layer exists before solution design")
    return 0


if __name__ == "__main__":
    sys.exit(main())
