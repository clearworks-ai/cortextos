"""Vault and envelope paths. Data --repo-root is the shared checkout, not cwd."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

DEFAULT_REPO_ROOT = Path("/Users/joshweiss/code/cortextos")
DEFAULT_VAULT = Path.home() / "code/knowledge-sync"
ORG_BRAIN = Path("raw/areas/clearworks/org-brain")
SECRETS_REL = Path("orgs/clearworksai/secrets.env")
DEFAULT_ENABLED_AGENTS_JSON = Path.home() / ".cortextos/cortextos1/config/enabled-agents.json"
ENABLED_AGENTS_ENV_VAR = "BRAIN_ENABLED_AGENTS_JSON"

SAFE_MEETING_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def safe_meeting_id(meeting_id: str) -> str:
    """Strip an optional 'fireflies:' prefix and enforce a filesystem-safe id.

    Returns '' when the id is empty, path-traversal-shaped, or otherwise does
    not match SAFE_MEETING_ID — callers must treat '' as invalid.
    """
    mid = meeting_id.strip()
    if mid.startswith("fireflies:"):
        mid = mid.split(":", 1)[1]
    if not SAFE_MEETING_ID.match(mid):
        return ""
    return mid


def envelope_dir(vault: Path, kind: str, meeting_id: str) -> Path:
    return Path(vault) / "raw/media/transcripts" / kind / meeting_id


def org_brain_root(vault: Path) -> Path:
    return Path(vault) / ORG_BRAIN


def secrets_path(repo_root: Path) -> Path:
    return Path(repo_root) / SECRETS_REL


def load_enabled_agents(path: Path | None = None) -> set[str]:
    """Return the set of fleet-agent names enabled in the roster (D-17, FR-004).

    ``path`` defaults to the ``BRAIN_ENABLED_AGENTS_JSON`` env override (tests
    use this), else ``~/.cortextos/cortextos1/config/enabled-agents.json``.
    The roster is a dict keyed by agent name, each value a dict with an
    ``enabled`` bool. Missing or unparseable file -> empty set; never raises.
    """
    if path is None:
        env_path = os.environ.get(ENABLED_AGENTS_ENV_VAR)
        path = Path(env_path) if env_path else DEFAULT_ENABLED_AGENTS_JSON
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(data, dict):
        return set()
    out: set[str] = set()
    for name, cfg in data.items():
        if isinstance(cfg, dict) and cfg.get("enabled") is True:
            out.add(str(name))
    return out
