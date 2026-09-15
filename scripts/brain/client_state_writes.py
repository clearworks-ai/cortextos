"""FR-006/FR-008: CRM facts-half writes (contact auto-create + interaction row,
G-CRM-1) and commitment->task dedup/planning (G-DEDUP-1, G-TASK-1). Every external
effect goes through the injectable Runner; every argv this module sends is built by
client_state_projections's plan_*_argv functions (never re-derived locally) so the
argv a live write sends is always identical to what a dry-run preview described
(G-PARITY-1)."""
from __future__ import annotations

import json
from pathlib import Path

from client_state_projections import plan_add_interaction_argv, plan_upsert_contact_argv


class WriterError(Exception):
    """Raised when a CRM/task-creation subprocess exits non-zero or returns
    stdout this module cannot parse (G0B-11). Callers must never mark a
    resolution 'filed' after catching this."""


def _normalize_email(value: str) -> str:
    """Mirrors upsert-contact.py's own normalize_email: lower + strip."""
    return (value or "").strip().lower()


def _contact_emails(contact: dict) -> list[str]:
    values: list[str] = []
    primary = contact.get("email")
    if isinstance(primary, str):
        values.append(primary)
    stored = contact.get("emails")
    if isinstance(stored, list):
        values.extend(e for e in stored if isinstance(e, str))
    return values


def _find_contact_by_email(contacts: list[dict], email: str) -> dict | None:
    target = _normalize_email(email)
    if not target:
        return None
    for contact in contacts:
        if any(_normalize_email(e) == target for e in _contact_emails(contact)):
            return contact
    return None


def ensure_contact(runner, crm_dir: Path, from_name: str, from_email: str, contacts: list[dict]) -> str:
    """Returns the contact id for `from_email`. Looks in the given `contacts`
    list first (no subprocess call for a known contact); only auto-creates via
    upsert-contact.py on a miss, and ONLY for a sender (callers must never pass
    a recipient here -- see client_state_gmail's plan_contact_write / G0B-10).
    Raises WriterError on rc != 0 or unparsable stdout with no fallback match."""
    existing = _find_contact_by_email(contacts, from_email)
    if existing is not None:
        return str(existing["id"])

    argv = plan_upsert_contact_argv(crm_dir, from_name, from_email)
    result = runner.run(argv)
    if result.returncode != 0:
        raise WriterError(
            f"upsert-contact.py rc={result.returncode}: {(result.stderr or '').strip()}"
        )
    stdout = (result.stdout or "").strip()
    if stdout:
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            cid = parsed.get("id") or parsed.get("contact_id")
            if cid:
                return str(cid)
        else:
            # upsert-contact.py's normal success path prints the bare contact_id
            # (`print(contact_id)`, not JSON) -- take the last non-empty line in
            # case anything else preceded it on stdout.
            lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
            if lines:
                return lines[-1]

    # Fallback: stdout carried no usable id (e.g. the SUPPRESSED path, which
    # writes to stderr and prints nothing on stdout with rc=0) -- re-load
    # contacts.json and find by email before giving up.
    contacts_path = Path(crm_dir) / "contacts.json"
    if contacts_path.exists():
        data = json.loads(contacts_path.read_text(encoding="utf-8"))
        reloaded = _find_contact_by_email(data.get("contacts", []), from_email)
        if reloaded is not None:
            return str(reloaded["id"])
    raise WriterError(
        f"ensure_contact: upsert-contact.py produced no usable id for {from_email!r} "
        f"(rc=0, stdout={stdout!r})"
    )


def write_interaction(runner, crm_dir: Path, contact_id: str, msg, extraction: dict) -> dict:
    """add-interaction.py --type email --source-ref gmail:<id> (existing source_ref
    + contact_id dedup, update-in-place -- G-01). Raises WriterError on rc != 0 or
    unparsable/empty stdout -- never returns a result a caller could mistake for
    success (G0B-11)."""
    argv = plan_add_interaction_argv(crm_dir, contact_id, msg, extraction)
    result = runner.run(argv)
    if result.returncode != 0:
        raise WriterError(
            f"add-interaction.py rc={result.returncode}: {(result.stderr or '').strip()}"
        )
    stdout = (result.stdout or "").strip()
    if not stdout:
        raise WriterError("add-interaction.py produced no stdout on rc=0")
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise WriterError(f"add-interaction.py stdout unparsable: {exc}") from exc
