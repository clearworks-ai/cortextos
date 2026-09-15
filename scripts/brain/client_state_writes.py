"""FR-006/FR-008: CRM facts-half writes (contact auto-create + interaction row,
G-CRM-1) and commitment->task dedup/planning (G-DEDUP-1, G-TASK-1). Every external
effect goes through the injectable Runner; every argv this module sends is built by
client_state_projections's plan_*_argv functions (never re-derived locally) so the
argv a live write sends is always identical to what a dry-run preview described
(G-PARITY-1)."""
from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from client_state_projections import (
    plan_add_interaction_argv,
    plan_task_create_argv,
    plan_upsert_contact_argv,
)


class WriterError(Exception):
    """Raised when a CRM/task-creation subprocess exits non-zero or returns
    stdout this module cannot parse (G0B-11). Callers must never mark a
    resolution 'filed' after catching this."""


class TaskEnumerationError(Exception):
    """Raised when `cortextos bus list-tasks` exits non-zero or returns
    unparsable/non-list JSON -- an empty list must never be treated as 'no open
    tasks' (that would silently defeat FR-008's dedup, G0B-8/G0B-11)."""


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


# upsert-contact.py slugify(): re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
_CONTACT_ID_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
# src/bus/task.ts:775-781 -- `task_${Date.now()}_${randomDigits(8)}`
_TASK_ID_RE = re.compile(r"task_\d+_\d+")


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
    if result.returncode != 0:  # G-WRITER-1
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
            # case anything else preceded it on stdout, but ONLY if it actually
            # LOOKS like a contact id. upsert-contact.py builds ids with its own
            # slugify() (`re.sub(r"[^a-z0-9]+", "-", ...)`, :80-82), so a valid
            # id is a lowercase slug; arbitrary prose on stdout must raise
            # rather than be adopted as an id (G0B-11).
            lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
            if lines and _CONTACT_ID_RE.fullmatch(lines[-1]):  # G-WRITER-2
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
    argv = plan_add_interaction_argv(crm_dir, contact_id, msg, extraction)  # G-PARITY-1
    result = runner.run(argv)
    if result.returncode != 0:  # G-WRITER-1
        raise WriterError(
            f"add-interaction.py rc={result.returncode}: {(result.stderr or '').strip()}"
        )
    stdout = (result.stdout or "").strip()
    if not stdout:
        raise WriterError("add-interaction.py produced no stdout on rc=0")
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise WriterError(f"add-interaction.py stdout unparsable: {exc}") from exc
    # G-WRITER-2/G0B-11: every one of add-interaction.py's three success prints
    # (:93 skipped-duplicate, :99 updated-decisions, :117 the appended record)
    # is an object carrying contact_id AND source_ref. Any other parseable JSON
    # (a bare list, a number, an object missing those keys) is NOT evidence the
    # interaction landed and must never be returned as success.
    if not isinstance(parsed, dict) or "contact_id" not in parsed or "source_ref" not in parsed:
        raise WriterError(
            f"add-interaction.py stdout is not an interaction record "
            f"(need contact_id + source_ref): {stdout[:200]!r}"
        )
    if str(parsed.get("contact_id")) != str(contact_id):
        raise WriterError(
            f"add-interaction.py wrote contact_id={parsed.get('contact_id')!r}, expected {contact_id!r}"
        )
    want_ref = f"gmail:{msg.id}"
    if str(parsed.get("source_ref")) != want_ref:  # G-WRITER-2
        # G0B3-8: a record for a DIFFERENT message is not proof THIS message was
        # filed. Without this the ledger could record crm:<id> for a source_ref
        # whose interaction row never existed.
        raise WriterError(
            f"add-interaction.py wrote source_ref={parsed.get('source_ref')!r}, expected {want_ref!r}"
        )
    return parsed


_OWNER_ALIASES = {
    "josh": "josh",
    "josh weiss": "josh",
    "me": "josh",
    "clearworks": "josh",
    # G0B2-10: this release CREATES its tasks with `--assignee human`, so the
    # bus's own human/user identities are Josh for dedup purposes -- otherwise a
    # task we created last run never suppresses the identical commitment this
    # run. Other agent assignees stay distinct.
    "human": "josh",  # G-OWNER-1
    "user": "josh",   # G-OWNER-1
}

_PUNCT_RE = re.compile(r"[^\w\s]")


def normalize_owner(owner: str) -> str:
    """Casefold + collapse whitespace, then the FR-008 alias map; unknown owners
    pass through normalized but un-aliased (so "marcos ruiz" != "josh"). The map
    folds the human-side aliases the model emits ("me", "Josh Weiss") AND the
    bus's own assignee identities ("human", "user") onto "josh" -- G0B2-10."""
    key = " ".join((owner or "").casefold().split())
    return _OWNER_ALIASES.get(key, key)


def _normalize_text(text: str) -> str:
    """casefold + strip punctuation + collapse whitespace, for the tier-1 ratio."""
    stripped = _PUNCT_RE.sub("", (text or "").casefold())
    return " ".join(stripped.split())


def tier1_duplicate(a_text: str, a_owner: str, b_text: str, b_owner: str) -> bool:
    """FR-008 tier 1: normalized owner match AND difflib.SequenceMatcher ratio
    STRICTLY > 0.75 on normalized text (borrowed from dedupe_history.py's title
    dedup, which treats <=0.75 as NOT a duplicate)."""
    if normalize_owner(a_owner) != normalize_owner(b_owner):
        return False
    ratio = difflib.SequenceMatcher(None, _normalize_text(a_text), _normalize_text(b_text)).ratio()
    return ratio > 0.75  # G-DEDUP-1


@dataclass
class TaskPlan:
    title: str
    owner: str
    source_ref: str
    dedup: dict | None   # None => create; else {"tier": 1|2, "match": str}


def plan_tasks(extraction: dict, context: list, open_tasks: list[dict], source_ref: str) -> list["TaskPlan"]:
    """FR-008: one TaskPlan per OURS (owner_name normalizes to "josh") commitment.
    G0A-2/G0B-7 fix: reads `commitment["owner_name"]` -- the schema-binding field
    name (email_extraction.schema.json commitments[].owner_name,
    additionalProperties:false) -- never "owner". A THEIRS commitment produces
    nothing. Tier 2 (extraction's own matches_open_item) is checked first and
    wins outright over tier 1. Tier 1 checks every context item, then every
    currently-open task (`open_tasks`, from list_open_tasks -- G0B-8: owner
    comparison uses that task's OWN `assigned_to`, never a hardcoded "josh")."""
    plans: list[TaskPlan] = []
    for commitment in extraction.get("commitments", []) or []:
        owner = commitment.get("owner_name", "") or ""
        if normalize_owner(owner) != "josh":
            continue  # theirs: digest line only, never a task
        title = commitment.get("text", "") or ""
        match_idx = commitment.get("matches_open_item")
        if match_idx is not None:
            ctx_item = context[match_idx - 1]  # invocation-local ids are 1..N
            plans.append(TaskPlan(title, owner, source_ref, {"tier": 2, "match": ctx_item.text}))
            continue
        dedup = None
        for item in context:
            if tier1_duplicate(title, owner, item.text, item.owner):
                dedup = {"tier": 1, "match": item.text}
                break
        if dedup is None:
            for task in open_tasks or []:
                task_owner = task.get("assigned_to", "") or ""
                task_title = task.get("title", "") or ""
                if tier1_duplicate(title, owner, task_title, task_owner):
                    dedup = {"tier": 1, "match": task_title}
                    break
        plans.append(TaskPlan(title, owner, source_ref, dedup))
    return plans


def list_open_tasks(runner) -> list[dict]:
    """G0A-19/C8: enumerates BOTH human and build classes (`--open --class <cls>
    --format json --limit 200` -- LIST_TASKS_MAX_LIMIT is 200, src/bus/task.ts:89,
    so 200 is the deliberate limit, not 500). rc != 0 on EITHER call raises
    TaskEnumerationError (G0B-8/G0B-11: never silently returns an empty
    'authoritative' list on a failed enumeration)."""
    merged: dict[object, dict] = {}
    for cls in ("human", "build"):
        argv = ["cortextos", "bus", "list-tasks", "--open", "--class", cls, "--format", "json", "--limit", "200"]
        result = runner.run(argv)
        if result.returncode != 0:  # G-TASK-2
            raise TaskEnumerationError(
                f"list-tasks --class {cls} rc={result.returncode}: {(result.stderr or '').strip()}"
            )
        try:
            data = json.loads(result.stdout or "[]")
        except json.JSONDecodeError as exc:
            raise TaskEnumerationError(f"list-tasks --class {cls} stdout unparsable: {exc}") from exc
        if not isinstance(data, list):
            raise TaskEnumerationError(f"list-tasks --class {cls} returned non-list JSON")
        for task in data:
            key = task.get("id") if isinstance(task, dict) and task.get("id") is not None else id(task)
            merged[key] = task
    return list(merged.values())


def create_task(runner, plan: "TaskPlan") -> str:
    """cortextos bus create-task <title> --assignee human --type human --desc
    "source <ref>". Raises WriterError on rc != 0 or an empty id (G0B-11: never
    returns "" as if it were a real id)."""
    argv = plan_task_create_argv(plan)
    result = runner.run(argv)
    if result.returncode != 0:  # G-WRITER-1
        raise WriterError(f"create-task rc={result.returncode}: {(result.stderr or '').strip()}")
    stdout = (result.stdout or "").strip()
    task_id = stdout.splitlines()[0].strip() if stdout else ""
    if not task_id:
        raise WriterError("create-task produced no id on rc=0")
    if not _TASK_ID_RE.fullmatch(task_id):  # G-WRITER-2
        # `bus create-task` prints ONLY the id (src/cli/bus.ts:552), shaped
        # task_<epoch>_<8 digits> (src/bus/task.ts:781). Anything else on the
        # first line is a warning or an error, not an id (G0B-11).
        raise WriterError(f"create-task first stdout line is not a task id: {task_id!r}")
    return task_id
