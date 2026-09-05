"""Vault and envelope paths. Data --repo-root is the shared checkout, not cwd."""
from __future__ import annotations

import re
from pathlib import Path

DEFAULT_REPO_ROOT = Path("/Users/joshweiss/code/cortextos")
DEFAULT_VAULT = Path.home() / "code/knowledge-sync"
ORG_BRAIN = Path("raw/areas/clearworks/org-brain")
SECRETS_REL = Path("orgs/clearworksai/secrets.env")

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
