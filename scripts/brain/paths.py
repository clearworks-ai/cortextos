"""Vault and envelope paths. Data --repo-root is the shared checkout, not cwd."""
from __future__ import annotations

from pathlib import Path

DEFAULT_REPO_ROOT = Path("/Users/joshweiss/code/cortextos")
DEFAULT_VAULT = Path.home() / "code/knowledge-sync"
ORG_BRAIN = Path("raw/areas/clearworks/org-brain")
SECRETS_REL = Path("orgs/clearworksai/secrets.env")


def envelope_dir(vault: Path, kind: str, meeting_id: str) -> Path:
    return Path(vault) / "raw/media/transcripts" / kind / meeting_id


def org_brain_root(vault: Path) -> Path:
    return Path(vault) / ORG_BRAIN


def secrets_path(repo_root: Path) -> Path:
    return Path(repo_root) / SECRETS_REL
