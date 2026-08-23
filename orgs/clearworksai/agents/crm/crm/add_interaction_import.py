"""Import-safe access to add-interaction.py atomic JSONL writer."""

from __future__ import annotations

import importlib.util
from pathlib import Path


_PATH = Path(__file__).with_name("add-interaction.py")
_SPEC = importlib.util.spec_from_file_location("crm_add_interaction", _PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("unable to load add-interaction.py")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
atomic_write_lines = _MODULE._atomic_write_lines
