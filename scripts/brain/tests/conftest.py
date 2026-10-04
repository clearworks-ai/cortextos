"""Ensures scripts/brain and scripts/brain/tests are both importable without a
per-file sys.path dance -- scripts/brain/tests/__init__.py makes this a
package, so pytest's prepend import mode roots modules at the repo root and
never puts this directory on sys.path on its own (G0A-8)."""
from __future__ import annotations

import sys
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_BRAIN_DIR = _TESTS_DIR.parent

for _p in (_BRAIN_DIR, _TESTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
