"""D-18 / FR-014 line 368: fixture isolation for variants A and B. Copies
the vault, deletes _state/ and every DERIVED artifact for one meeting
(extraction.json is NOT derived -- it is the cached bounded LLM call and is
kept, re-stamped when the envelope bytes change so extract_meeting.py's own
same-sha fast path never shells `claude` again -- G0a F-1), applies the
variant edit, recomputes source.sha256. Refuses an unsafe destination
outright, before any filesystem mutation (G0b C1-3). Never touches the
source vault."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

from atomic import atomic_write

ALLOI_NODE_REL = "raw/areas/clearworks/org-brain/projects/alloi-03.md"
VARIANT_B_EMAIL = "sam@newco-fixture.test"
DERIVED_ARTIFACT_NAMES = (
    "validated.json", "resolution.json", "event.json",
    "writeback-payload.json", "recap-payload.json", "fanout-meeting.json",
)
# G0b C1-3: the real production vault. A `--dest` under (or equal to) any of
# these is refused outright, regardless of --source.
PROTECTED_VAULTS: tuple[Path, ...] = (Path("/Users/joshweiss/code/knowledge-sync"),)


class UnsafeDestinationError(ValueError):
    """Raised by _assert_safe_destination; a ValueError subclass so existing
    `pytest.raises(ValueError)` callers (e.g. the unknown-variant test)
    remain valid without change."""


def _is_within(path: Path, ancestor: Path) -> bool:
    try:
        path.relative_to(ancestor)
        return True
    except ValueError:
        return False


def _assert_safe_destination(source_vault: Path, dest_vault: Path) -> None:
    src = source_vault.resolve(strict=False)
    dst = dest_vault.resolve(strict=False)
    if dst == src:
        raise UnsafeDestinationError(f"dest equals source vault: {dst}")
    if _is_within(dst, src):
        raise UnsafeDestinationError(f"dest is inside the source vault: {dst}")
    if _is_within(src, dst):
        raise UnsafeDestinationError(f"source vault is inside dest: {dst}")
    for protected in PROTECTED_VAULTS:
        p = protected.resolve(strict=False)
        if dst == p or _is_within(dst, p):
            raise UnsafeDestinationError(f"dest resolves under a protected vault ({p}): {dst}")


def _canonical_bytes(envelope: dict[str, Any]) -> bytes:
    return json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def apply_variant_a(vault_copy: Path) -> None:
    """Strip aliases: from projects/alloi-03.md (D-11: resolves to
    clients/alloi.md, node: none, rule 3 — the fixture must seed all three
    real Alloi nodes for this fall-through to be genuine, see Task 7)."""
    path = vault_copy / ALLOI_NODE_REL
    text = path.read_text(encoding="utf-8")
    new_text = re.sub(r"(?m)^aliases:.*$", "aliases:", text, count=1)
    atomic_write(path, new_text.encode("utf-8"))


def apply_variant_b(envelope: dict[str, Any]) -> dict[str, Any]:
    """Replace every @alloi.us participant email with sam@newco-fixture.test
    (D-11: resolves to a newly created orgs/newco-fixture.md, rule 6)."""
    out = json.loads(json.dumps(envelope))
    for p in out.get("participants") or []:
        email = str(p.get("email") or "")
        if email.endswith("@alloi.us"):
            p["email"] = VARIANT_B_EMAIL
    return out


def _delete_state_and_derived(vault_copy: Path, kind: str, meeting_id: str) -> None:
    envelope_dir = vault_copy / "raw/media/transcripts" / kind / meeting_id
    state_dir = vault_copy / "raw/media/transcripts/_state" / f"{kind}-{meeting_id}"
    for name in DERIVED_ARTIFACT_NAMES:
        p = envelope_dir / name
        if p.exists():
            p.unlink()
    if state_dir.exists():
        shutil.rmtree(state_dir)


def _restamp_extraction_if_present(vault_copy: Path, kind: str, meeting_id: str, new_sha: str) -> None:
    """G0a F-1: extraction.json (the cached bounded LLM call) is kept, not
    deleted. Variant B's participant rewrite changes source.json's bytes,
    so its inputSha would otherwise go stale and extract_meeting.py would
    shell a live `claude` call on the next --dry-run/--apply. Re-stamping
    inputSha to the copy's own recomputed sha keeps extract_meeting.py's
    existing_sha == input_sha fast path (extract_meeting.py:302-306) AND
    resolve_meeting.py's own independent inputSha == recomputed check
    (resolve_meeting.py:598-599) both green with zero LLM calls — the G4
    trap on `claude` stays installed and its log stays empty because the
    call is genuinely never made, not because the trap silently swallowed
    it. Variant A doesn't change the envelope's bytes, so this is a no-op
    restamp (same sha in, same sha out) but marks `variant: true` either
    way, for the audit trail."""
    path = vault_copy / "raw/media/transcripts" / kind / meeting_id / "extraction.json"
    if not path.is_file():
        return
    obj = json.loads(path.read_text(encoding="utf-8"))
    obj["inputSha"] = new_sha
    obj["variant"] = True
    atomic_write(path, json.dumps(obj).encode("utf-8"))


def make_variant(*, source_vault: Path, dest_vault: Path, kind: str, meeting_id: str, variant: str) -> str:
    if variant not in ("A", "B"):
        raise ValueError(f"unknown variant {variant!r}")
    _assert_safe_destination(source_vault, dest_vault)
    if dest_vault.exists():
        shutil.rmtree(dest_vault)
    shutil.copytree(source_vault, dest_vault)
    _delete_state_and_derived(dest_vault, kind, meeting_id)

    envelope_path = dest_vault / "raw/media/transcripts" / kind / meeting_id / "source.json"
    envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
    if variant == "A":
        apply_variant_a(dest_vault)
    else:
        envelope = apply_variant_b(envelope)

    data = _canonical_bytes(envelope)
    atomic_write(envelope_path, data)
    sha = hashlib.sha256(data).hexdigest()
    atomic_write(envelope_path.parent / "source.sha256", (sha + "\n").encode("utf-8"))
    _restamp_extraction_if_present(dest_vault, kind, meeting_id, sha)
    return sha


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--meeting-id", required=True)
    p.add_argument("--kind", default="fireflies")
    p.add_argument("--vault", required=True, help="production vault to copy from")
    p.add_argument("--dest", required=True, help="destination copy path")
    p.add_argument("--variant", required=True, choices=["A", "B"])
    args = p.parse_args(argv)
    try:
        sha = make_variant(
            source_vault=Path(args.vault), dest_vault=Path(args.dest),
            kind=args.kind, meeting_id=args.meeting_id, variant=args.variant,
        )
    except UnsafeDestinationError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    print(f"variant {args.variant}: {args.dest} source.sha256={sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
