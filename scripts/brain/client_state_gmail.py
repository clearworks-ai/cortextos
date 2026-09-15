"""Client State v1 -- Gmail orchestrator (FR-001..FR-009, C7). Supersedes Task 8's
poller skeleton: `_file_message` now runs the real pipeline -- cached_or_extract,
CRM contact auto-create (sender only, G0B-10) + interaction rows (per contact_id,
G0B-9), the append-only History write (under the SAME advisory file lock the
meeting pipeline uses, G0B-13), FR-008 task dedup/creation, and the FR-003
escalate-once Telegram text. Every preview AND every live write is derived from
client_state_projections' pure plan_* functions -- dry-run calls them and stops;
live calls them and then executes (G-PARITY-1). Dry-run still persists the ledger
row, the extraction cache, and the run receipt to --state-dir (a scratch dir by
construction) -- ONLY the irreversible transports (create-task, send-telegram, the
CRM subprocesses, the real vault page write) are skipped in dry-run (G0A-3/G0B-1)."""
from __future__ import annotations

import argparse
import contextlib
import difflib
import fcntl
import importlib.util
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import client_state_projections as projections
import client_state_writes
import extract_email
import gmail_source
import resolve_email
import single_flight
import writeback_email
from gmail_source import GmailSourceError
from observation_ledger import (
    Ledger, ObservationRow, Resolution, content_digest, read_receipt,
    record_failure, record_lease_release_failure, record_lock_refusal, write_receipt,
)
from resolve_meeting import load_closed_sets


@dataclass
class Config:
    repo_root: Path
    vault: Path
    crm_dir: Path
    state_dir: Path
    days: int
    query: str | None
    dry_run: bool
    max_usd: float
    today: date
    now: datetime
    clock: "Callable[[], float]" = time.monotonic   # monotonic source for the lease heartbeat (injectable for tests)


@dataclass
class RunResult:
    exit_code: int
    filed: int = 0
    ignored: int = 0
    escalated: int = 0
    skipped_terminal: int = 0
    cost_usd: float = 0.0
    truncation: list[dict] = field(default_factory=list)
    previews: list[str] = field(default_factory=list)


@dataclass
class _RunState:
    """Mutable per-run accumulator -- cost is the only thing shared across
    messages (the --max-usd cap is a whole-run budget, not per-message)."""
    cost: float = 0.0


# --- FR-010 read-only reuse of the meeting pipeline's advisory file lock -----
# orgs/clearworksai/agents/pa/scripts/meeting_writeback.py is on the shared-file
# READ-ONLY allowlist; loaded by path (never imported as a package) so this
# module has no hard dependency on the pa/ agent's own package layout.
_MEETING_WRITEBACK_PATH = (
    Path(__file__).resolve().parents[2] / "orgs" / "clearworksai" / "agents" / "pa" / "scripts" / "meeting_writeback.py"
)


def _load_client_file_lock():
    spec = importlib.util.spec_from_file_location("_client_state_meeting_writeback", _MEETING_WRITEBACK_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.client_file_lock


client_file_lock = _load_client_file_lock()


# FR-008 page-lock bounds. A page is normally free; anything past a few minutes
# means another holder is wedged, and waiting on it silently is what let a live
# run's 60-minute claim go stale underneath it (G2B-4).
PAGE_LOCK_TIMEOUT_S = 300.0
PAGE_LOCK_POLL_S = 2.0


class PageLockTimeout(Exception):
    """Another process held a client page's advisory lock past PAGE_LOCK_TIMEOUT_S."""


def _page_lock_sleep(seconds: float) -> None:
    """Indirection so a test can drive the wait loop on a fake clock."""
    time.sleep(seconds)


def _page_lock_path(page: Path) -> Path:
    # Byte-identical to meeting_writeback.client_file_lock's sibling lockfile,
    # so the meeting pipeline and this one still exclude each other.
    return page.with_name(page.name + ".lock")


def _heartbeat_of(runner):
    """The Heartbeat wrapped around `runner` by run(), if any (tests pass a bare
    Runner, which simply has none)."""
    return getattr(runner, "heartbeat", None)


@contextlib.contextmanager
def _page_lock(page: Path, heartbeat=None, *, clock: Callable[[], float] = time.monotonic):
    """FR-008 advisory lock over ONE client page's read-modify-write, acquired
    with a TIMED, NON-BLOCKING flock loop.

    The lock FILE is the same sibling `<page>.lock` meeting_writeback.py uses,
    so the two pipelines still serialise against each other (G-HIST-2). What
    changed is the WAIT: `flock(LOCK_EX)` blocks inside the kernel, where
    nothing can heartbeat, so a page held by another process for longer than the
    60-minute claim TTL let this run's own lease go stale -- the next cron then
    cleared the "stale" claim and started a SECOND concurrent run while this one
    was still alive (G2B-4). Every poll ticks the heartbeat, which both touches
    the lease and raises LeaseLost the moment we stop owning it. Past the bound
    we give up LOUDLY (record_failure + exit 3), never on a silent stale claim.
    """
    lock_path = _page_lock_path(page)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "w", encoding="utf-8")
    deadline = clock() + PAGE_LOCK_TIMEOUT_S
    try:
        while True:
            try:
                # LOCK_NB, never a bare LOCK_EX: a blocking flock waits inside
                # the kernel, where the tick below can never run.
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if heartbeat is not None:
                    heartbeat.tick()  # G-LOCK-10
                if clock() >= deadline:
                    raise PageLockTimeout(
                        f"page lock held by another process for more than "
                        f"{PAGE_LOCK_TIMEOUT_S:.0f}s: {lock_path}"
                    ) from None
                _page_lock_sleep(PAGE_LOCK_POLL_S)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


class EscalationError(Exception):
    """FR-003: the Telegram send failed. The row must NOT record an escalated
    outcome that `escalated_for` would then use to suppress the retry, so the
    whole message aborts and the next run escalates again (G0B-4)."""


def _send_escalation(runner, text: str) -> None:
    proc = runner.run(["cortextos", "bus", "send-telegram", projections.TELEGRAM_CHAT_ID, text])
    if proc.returncode != 0:  # G-ESC-2
        raise EscalationError(
            f"send-telegram failed rc={proc.returncode}: {(proc.stderr or '').strip()}"
        )


def _resolution_key(r: Resolution) -> tuple[str, str]:
    """G0B3-1: merge identity is (slug, normalized email) — NOT contact_id.
    A sender whose contact is auto-created changes contact_id from None to the
    new id between runs, so keying on it made the same counterparty look like a
    different resolution and lost its carried-forward `filed`/`effects`."""
    return (r.slug, (r.email or "").strip().lower())


def _resolution_signature(resolutions: list[Resolution]) -> frozenset:
    return frozenset((r.slug, r.contact_id, r.email, r.outcome, r.reason) for r in resolutions)


def _merge_resolutions(prior_same_digest: ObservationRow | None, fresh: list[Resolution]) -> list[Resolution]:
    """G0B-3 / G0B3-1: carry forward every resolution ALREADY filed on the prior
    row for this exact digest -- never re-process it. For one NOT yet filed,
    carry its LANDED EFFECT KEYS (and any contact_id it earned) onto the fresh
    resolution, so the retry completes only what is still missing and never
    replays a landed effect. Everything else is re-evaluated afresh: an
    escalated/ignored resolution is re-checked every run (a cheap closed-sets
    re-check, no LLM call), and a genuinely new counterparty is 'pending'."""
    if prior_same_digest is None:
        return fresh
    prior_by_key = {_resolution_key(r): r for r in prior_same_digest.resolutions}
    merged: list[Resolution] = []
    seen: set[tuple[str, str]] = set()
    for r in fresh:
        key = _resolution_key(r)
        seen.add(key)
        old = prior_by_key.get(key)
        if old is not None and old.outcome == "filed":  # G-MERGE-1
            merged.append(old)
            continue
        if old is not None:
            r.effects = list(old.effects)  # G-MERGE-2: landed effects survive the retry
            if old.contact_id and not r.contact_id:
                r.contact_id = old.contact_id
        merged.append(r)
    for key, old in prior_by_key.items():
        # G-MERGE-3: a counterparty the resolver no longer produces (a contact
        # removed from the CRM, a page whose domains line changed) but which we
        # ALREADY filed must stay on the row -- dropping it would make the row
        # look complete-but-smaller and lose the record of a real write.
        if key not in seen and old.outcome == "filed":  # G-MERGE-3
            merged.append(old)
    return merged


def _required_effects(resolution: Resolution, page_key: str | None, task_keys: list[str]) -> list[str]:
    """Every effect key that must LAND before this resolution can be `filed`
    (G0B3-1). CRM only when a contact id resolved; the History page for its
    bound slug; and every task this message creates (tasks are per-message, so
    a resolution is not complete while a commitment task is still missing)."""
    required: list[str] = []
    if resolution.contact_id:
        required.append(f"crm:{resolution.contact_id}")
    if page_key:
        required.append(page_key)
    required.extend(task_keys)
    return required


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".csw-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _open_email_titles_still_open(ledger: Ledger, open_tasks: list[dict]) -> list[str]:
    """C8: join ledger.open_email_tasks() ids against the CURRENTLY open task
    list (list_open_tasks) and keep only titles for tasks still open -- a
    completed/cancelled email-sourced task must never keep suppressing a fresh
    commitment (G0B-8)."""
    open_ids = {t.get("id") for t in open_tasks}
    return [t["title"] for t in ledger.open_email_tasks() if t.get("id") in open_ids]


def _find_contact_in_list(contacts: list[dict], email: str) -> dict | None:
    target = (email or "").strip().lower()
    for c in contacts:
        emails = [e for e in c.get("emails", []) if isinstance(e, str)]
        if any((e or "").strip().lower() == target for e in emails):
            return c
    return None


def _diff_preview(page: Path, old_text: str, new_text: str) -> str:
    diff = "".join(
        difflib.unified_diff(
            old_text.splitlines(keepends=True), new_text.splitlines(keepends=True),
            fromfile=f"a/{page}", tofile=f"b/{page}",
        )
    )
    return f"  page diff for {page}:\n{diff}" if diff else f"  page diff for {page}: (no change)"


def _file_message(
    cfg: Config, runner, ledger: Ledger, resolver: "resolve_email.EmailResolver",
    msg, contacts: list[dict], previews: list[str], state: _RunState,
) -> tuple[int, int, int]:
    """Files every not-yet-filed resolution on `msg`. Returns (filed, escalated,
    ignored) counts for THIS run's reporting. A resolution already 'filed' on a
    same-digest prior row is carried forward untouched (G0B-3); a NEW digest
    (edited/re-sent message) always re-files fresh regardless of what the old
    digest's row said."""
    source_ref = f"gmail:{msg.id}"
    digest = content_digest(msg.subject, msg.body_text, msg.from_email)
    prior = ledger.latest(source_ref)
    same_digest_prior = prior if (prior is not None and prior.content_digest == digest) else None
    revision_of = prior.content_digest if (prior is not None and prior.content_digest != digest) else None

    # G0A2-2: the extraction CACHE may be reused across a dry-run -> live pair
    # (the call was really paid for and stamped), but a SIMULATED row's `filed`
    # outcomes must NEVER be carried forward into a live run -- nothing was
    # actually written, so the live run has to do all of it. A second DRY run
    # does carry them forward, which is what makes the repeat preview free.
    merge_prior = same_digest_prior
    if merge_prior is not None and merge_prior.simulated and not cfg.dry_run:
        merge_prior = None  # G-SIM-1
    if same_digest_prior is not None and (same_digest_prior.simulated or same_digest_prior.partial):
        # G0B3-3 / D-02: a dry-run (or a part-way) row for THIS digest already
        # recorded which digest this message supersedes. Because that row is the
        # `latest` one, `prior.content_digest == digest` and the plain rule above
        # computes revision_of=None -- so the later REAL run wrote an unmarked
        # History entry and lost the supersede link. Carry it forward.
        revision_of = revision_of or same_digest_prior.revision_of  # G-REV-1

    fresh = resolver.resolve_message(msg)
    resolutions = _merge_resolutions(merge_prior, fresh)

    pending = [r for r in resolutions if r.outcome == "pending"]
    escalated = [r for r in resolutions if r.outcome == "escalated"]
    ignored = [r for r in resolutions if r.outcome == "ignored"]

    # G-ESC-3 (G2A-1/G2B-5): the RESOLVER produces `escalated` to mean "this
    # needs an alert", but `escalated_for` reads a persisted `escalated` outcome
    # as PROOF the alert was delivered. Those two meanings must not share a
    # value on disk: a send that failed (or never ran because the message blew
    # up first) would gate the retry forever and Josh would never hear about the
    # ambiguity. `delivered` starts true only when a previous real run already
    # sent this exact (source_ref, digest) -- or in a dry-run, which sends
    # nothing and whose row is simulated anyway -- and becomes true the instant
    # a send returns rc 0. Any row persisted while it is false demotes the
    # undelivered escalations back to `pending`, which is not terminal, so the
    # next run resolves the same ambiguity and sends.
    esc_state = {
        "already": ledger.escalated_for(source_ref, digest),
        "delivered": cfg.dry_run,
    }

    def _demote_undelivered_escalations() -> None:
        if esc_state["already"] or esc_state["delivered"]:
            return
        for r in resolutions:
            if r.outcome == "escalated":
                r.outcome = "pending"  # G-ESC-3

    # FR-001: a same-digest re-check that changes nothing writes nothing.
    if merge_prior is not None and not pending:
        if _resolution_signature(resolutions) == _resolution_signature(merge_prior.resolutions):  # G-IDEMP-2
            return 0, len(escalated), len(ignored)

    if not pending:
        # Every resolution is escalated/ignored (possibly a changed set since
        # the prior run) -- still record the row once, and escalate exactly
        # once per (source_ref, digest) if warranted.
        escalation_text = None
        if escalated and not esc_state["already"]:  # G-ESC-1
            escalation_text = projections.plan_escalation(msg, resolutions)
            if not cfg.dry_run:
                try:
                    _send_escalation(runner, escalation_text)  # G-ESC-2: rc checked
                except Exception:
                    # G-ESC-3: delivery did not happen. Persist the attempt as a
                    # NON-terminal row with the escalations demoted, so the next
                    # run re-sends instead of reading this row as proof.
                    _demote_undelivered_escalations()
                    ledger.append(ObservationRow(
                        source_ref=source_ref, thread_id=msg.thread_id, content_digest=digest,
                        observed_at=cfg.now.isoformat(), resolutions=resolutions,
                        revision_of=revision_of, partial=True,
                    ))
                    raise
                esc_state["delivered"] = True
        row = ObservationRow(
            source_ref=source_ref, thread_id=msg.thread_id, content_digest=digest,
            observed_at=cfg.now.isoformat(), resolutions=resolutions, revision_of=revision_of,
            simulated=cfg.dry_run,  # G-LEDGER-6
        )
        ledger.append(row)
        if cfg.dry_run:
            previews.append(projections.plan_message_preview(
                msg, resolutions, None, cached=False, crm_lines=[], page_diffs=[], task_lines=[],
                escalation_text=escalation_text, digest_lines=projections.plan_digest_line(row),
            ))
        return 0, len(escalated), len(ignored)

    # At least one newly-fileable resolution -- extract (cached across a matching
    # (source_ref, digest, sorted bound slugs) identity) with the WIDENED slug set
    # (filed + newly fileable), and enumerate open tasks ONCE for both the
    # extraction context and the dedup check below.
    slugs = sorted({r.slug for r in resolutions if r.slug})
    open_tasks = client_state_writes.list_open_tasks(runner)  # TaskEnumerationError propagates to run()
    open_email_titles = _open_email_titles_still_open(ledger, open_tasks)
    context = extract_email.build_context(
        extract_email.open_items_for(cfg.vault, slugs), open_email_titles,
    )
    try:
        extraction, called = extract_email.cached_or_extract(
            ledger, msg, context, slugs, runner, max_usd=cfg.max_usd, spent_usd=state.cost,
        )
    except extract_email.BudgetExceeded as exc:
        # G0B3-2 / FR-001 (at most ONE LLM call per source_ref+digest+slugs):
        # the call has ALREADY been paid for and stamped. Persist it here, as a
        # non-terminal row, BEFORE the run exits 12 -- run()'s own handler only
        # ever saw the receipt, so the cache was lost and the next run paid
        # again for an identical message. The stamped extraction carries its own
        # `identity`, `bound_slugs` and `context` mapping, so the retry's
        # cached_or_extract matches it and rebinds against the fresh context.
        for r in resolutions:
            if r.outcome == "pending":
                r.outcome = "partial"
        ledger.append(ObservationRow(  # G-BUDGET-2
            source_ref=source_ref, thread_id=msg.thread_id, content_digest=digest,
            observed_at=cfg.now.isoformat(), resolutions=resolutions,
            reason=f"budget: {exc}", extraction=exc.extraction, writes=[],
            revision_of=revision_of, partial=True,
            simulated=cfg.dry_run,  # G-LEDGER-6: a dry-run budget row is a PREVIEW, not a real run
        ))
        raise
    if called:
        state.cost += float(extraction.get("cost_usd", 0.0))

    from_email_norm = (msg.from_email or "").strip().lower()
    crm_lines: list[str] = []
    page_diffs: list[str] = []
    writes: list[str] = []          # REAL effects (live only)
    planned_writes: list[str] = []  # what a dry-run WOULD write (G0B2-4)

    def _persist_partial(exc: Exception) -> None:
        """G0B-11: a mid-message failure must not throw away the writes that
        DID land. Persist a `partial` row carrying them plus the resolutions
        already marked filed; `is_terminal` refuses partial rows, so the next
        run re-resolves and `_merge_resolutions` carries the filed ones forward
        untouched -- the remainder is finished, nothing is written twice.

        It also preserves the extraction this message ALREADY PAID FOR (G0B-6):
        the row is the extraction cache, so without it the next run re-spends
        on an identical message. Persisted whenever an extraction exists, even
        when zero writes landed.

        EVERY resolution is persisted, each carrying the effect keys that DID
        land for it (G0B3-1). A resolution whose effects are incomplete is
        stamped "partial" -- a persisted outcome; only "pending" is transient.
        Dropping the incomplete ones (the pre-adjudication behaviour) threw the
        landed-effect record away, so the retry replayed what had landed and
        never finished what had not."""
        # G-BUDGET-3: a DRY run's extraction was really called and really
        # billed, so FR-001's at-most-one-call guarantee binds it too. This used
        # to return early on cfg.dry_run, so a dry run that paid for the
        # extraction and then blew up downstream kept no row and no cache, and
        # the next run paid again for identical input. The row it persists is
        # `simulated` (never terminal, never mistaken for real work) and carries
        # NO planned_writes -- nothing was previewed to completion.
        if extraction is None:
            return
        _demote_undelivered_escalations()  # G-ESC-3
        for r in resolutions:
            if r.outcome == "pending":
                r.outcome = "partial"
        ledger.append(ObservationRow(
            source_ref=source_ref, thread_id=msg.thread_id, content_digest=digest,
            observed_at=cfg.now.isoformat(), resolutions=resolutions,
            reason=f"partial: {exc}", extraction=extraction, writes=writes,
            revision_of=revision_of, simulated=cfg.dry_run,  # G-LEDGER-6
            # G-LEDGER-7: DERIVED, never a blanket True. If the failure landed
            # after every effect and every resolution was already filed, there
            # is nothing left to finish -- flagging it partial made the message
            # non-terminal forever and every later run re-processed it.
            partial=any(r.outcome != "filed" for r in resolutions),
        ))

    try:
        return _do_writes(
            cfg, runner, ledger, msg, contacts, previews, extraction, called,
            resolutions, pending, escalated, ignored, context, open_tasks,
            source_ref, digest, revision_of, from_email_norm,
            crm_lines, page_diffs, writes, planned_writes, esc_state,
        )
    except Exception as exc:  # noqa: BLE001 -- G-EFFECT-2: ANY escape persists landed effects
        # G0B-11 only covered WriterError/EscalationError, so an OSError out of
        # page I/O or client_file_lock, or a subprocess.TimeoutExpired escaping
        # the Runner, threw away the record of the CRM/page/task effects that
        # HAD already landed -- and the retry, re-resolving from nothing,
        # replayed them (a duplicate History entry, a second CRM interaction
        # row). Partial persistence is about what LANDED, which is independent
        # of which exception type ended the message, so every escape takes the
        # same path. _persist_partial never marks an un-landed effect filed
        # (G-EFFECT-1 still decides that), and the exception is re-raised
        # unchanged, so run()'s own handlers classify the exit exactly as
        # before.
        _persist_partial(exc)
        raise


def _do_writes(
    cfg, runner, ledger, msg, contacts, previews, extraction, called,
    resolutions, pending, escalated, ignored, context, open_tasks,
    source_ref, digest, revision_of, from_email_norm,
    crm_lines, page_diffs, writes, planned_writes, esc_state,
):
    """Executes (or, in dry-run, previews) every effect this message owes, then
    marks a resolution `filed` ONLY once every effect REQUIRED for it has landed
    (G0B3-1). Each landed effect is recorded as a key on its owning
    resolution(s) -- `crm:<contact_id>`, `page:<vault-relative path>`,
    `task:<title>` -- and an effect whose key is already present is SKIPPED, so
    a retry after a mid-message failure completes exactly the missing work and
    replays nothing."""
    # Task plans are pure, so they are computed FIRST: a resolution is not
    # complete while a commitment task this message owes is still missing, and
    # the required-effect set has to be known before anything is marked filed.
    task_plans = client_state_writes.plan_tasks(extraction, context, open_tasks, source_ref)
    task_keys = [f"task:{plan.title}" for plan in task_plans if plan.dedup is None]

    def landed(key: str) -> bool:
        """Has this effect already landed, on THIS message, in any run? History
        is per distinct page and tasks are per message, so one resolution's
        record of them counts for all."""
        return any(key in r.effects for r in resolutions)

    def mark(key: str, owners) -> None:
        for r in owners:
            if key not in r.effects:
                r.effects.append(key)

    page_key_for: dict[str, str] = {}

    # --- CRM: one interaction row per resolved contact_id ---------------------
    for resolution in pending:
        is_sender = resolution.email == from_email_norm
        contact_id = resolution.contact_id
        if contact_id is None and is_sender:  # G-CRM-1
            # G0B-10: auto-create ONLY the sender, from From-header facts.
            existing = _find_contact_in_list(contacts, resolution.email)
            if existing is not None:
                contact_id = str(existing["id"])
            elif cfg.dry_run:
                argv = projections.plan_upsert_contact_argv(cfg.crm_dir, msg.from_name, msg.from_email)
                crm_lines.append(f"  CRM: would create contact argv={argv}")
                # G0A2-9/G0B-2: keep previewing the interaction the live run
                # would write, against a clearly-marked prospective id -- a
                # dry-run over a new-but-domain-matched sender must not hide
                # the CRM row it is going to create.
                contact_id = f"<new:{resolution.email}>"
            else:
                contact_id = client_state_writes.ensure_contact(runner, cfg.crm_dir, msg.from_name, msg.from_email, contacts)
        # G0B3-1: the auto-created id is assigned BACK onto the resolution before
        # anything is persisted, so the row records which contact this
        # counterparty actually became.
        resolution.contact_id = contact_id
        # A recipient with no existing contact row is NEVER auto-created here
        # (contact_id stays None) -- their page still gets a History entry below.
        if contact_id is not None:  # G-CRM-2
            key = f"crm:{contact_id}"
            if landed(key):
                # G-EFFECT-3: the effect landed once, for the message -- but the
                # completeness check is PER RESOLUTION, so the key has to be
                # credited to THIS one too. Skipping without crediting left a
                # counterparty that shares a contact (or, below, a page) with an
                # already-satisfied one permanently `partial`, and every
                # unchanged re-check appended another observation row.
                mark(key, [resolution])
                continue
            argv = projections.plan_add_interaction_argv(cfg.crm_dir, contact_id, msg, extraction)
            if cfg.dry_run:
                crm_lines.append(f"  CRM row: contact={contact_id} argv={argv}")
                planned_writes.append(key)
            else:
                client_state_writes.write_interaction(runner, cfg.crm_dir, contact_id, msg, extraction)
                writes.append(key)
            mark(key, [resolution])

    # --- History: one write per DISTINCT bound page (G0B-9) -------------------
    seen_slugs: set[str] = set()
    for resolution in pending:
        if not resolution.slug or resolution.slug in seen_slugs:
            continue
        seen_slugs.add(resolution.slug)
        page = writeback_email.page_path_for(cfg.vault, resolution.slug, resolution.kind)
        rel_page = str(page.relative_to(cfg.vault))
        key = f"page:{rel_page}"
        page_key_for[resolution.slug] = key
        owners = [r for r in pending if r.slug == resolution.slug]
        if landed(key):
            mark(key, owners)  # G-EFFECT-3
            continue
        entry = projections.plan_history_entry(msg, extraction, source_ref, revision_of)  # G-PARITY-1
        if cfg.dry_run:  # G-DRY-1: no vault lock, so no vault mutation at all
            # A dry run mutates NOTHING in the vault -- not even the
            # sibling <page>.md.lock the advisory lock creates and truncates
            # (G2B-6). It is also not needed: there is no read-modify-WRITE to
            # serialise here, only a read and a rendered preview, and a preview
            # raced by a concurrent writeback is merely slightly stale, never
            # corrupt. `*.md.lock` is gitignored, so this mutation was invisible
            # to a porcelain check.
            old_text = page.read_text(encoding="utf-8") if page.exists() else ""
            new_text = writeback_email.apply_history(old_text, entry)
            page_diffs.append(_diff_preview(page, old_text, new_text))  # G-PARITY-2
            planned_writes.append(rel_page)
        else:
            # G0B-13: hold the SAME advisory lock the meeting pipeline uses across
            # read + render + write, so a concurrent meeting-writeback filing to the
            # same page can never interleave with this read-modify-write.
            with _page_lock(page, _heartbeat_of(runner), clock=cfg.clock):  # G-HIST-2
                old_text = page.read_text(encoding="utf-8") if page.exists() else ""
                new_text = writeback_email.apply_history(old_text, entry)
                _atomic_write_text(page, new_text)
                writes.append(rel_page)
        mark(key, owners)
    for resolution in pending:
        # a slug whose page write was carried forward from a prior run still
        # needs its key recorded for the completeness check below
        if resolution.slug and resolution.slug not in page_key_for:
            page = writeback_email.page_path_for(cfg.vault, resolution.slug, resolution.kind)
            page_key_for[resolution.slug] = f"page:{str(page.relative_to(cfg.vault))}"

    # --- Tasks: per MESSAGE ---------------------------------------------------
    task_lines: list[str] = []
    suppressed: list[dict] = []
    for plan in task_plans:
        if plan.dedup is not None:
            suppressed.append({"title": plan.title, "tier": plan.dedup["tier"], "match": plan.dedup["match"]})
            task_lines.append(f"  task: {plan.title} (suppressed tier {plan.dedup['tier']} match: {plan.dedup['match']})")
            continue
        key = f"task:{plan.title}"
        if landed(key):
            task_lines.append(f"  task: {plan.title} (already created on an earlier run)")
            mark(key, pending)  # G-EFFECT-3: tasks are per MESSAGE, so every resolution owes this key
            continue
        if cfg.dry_run:
            argv = projections.plan_task_create_argv(plan)
            task_lines.append(f"  task: {plan.title} (create) argv={argv}")
            planned_writes.append(f"task:<new>|{plan.title}")
        else:
            task_id = client_state_writes.create_task(runner, plan)
            writes.append(f"task:{task_id}|{plan.title}")
        mark(key, pending)

    escalation_text = None
    if escalated and not esc_state["already"]:  # G-ESC-1
        escalation_text = projections.plan_escalation(msg, resolutions)
        if not cfg.dry_run:
            # A raise here reaches _file_message's handler, which persists a
            # partial row through _persist_partial -- and that demotes the
            # undelivered escalations (G-ESC-3) before the row is written.
            _send_escalation(runner, escalation_text)  # G-ESC-2: rc checked
            esc_state["delivered"] = True

    # --- completion: `filed` only when EVERY required effect landed ----------
    filed_now = 0
    for resolution in pending:
        required = _required_effects(resolution, page_key_for.get(resolution.slug), task_keys)
        if all(key in resolution.effects for key in required):  # G-EFFECT-1
            resolution.outcome = "filed"
            filed_now += 1
        else:
            # G0B3-1: NOT filed. "partial" is a persisted outcome (it carries the
            # landed effect keys); only "pending" is transient.
            resolution.outcome = "partial"

    row = ObservationRow(
        source_ref=source_ref, thread_id=msg.thread_id, content_digest=digest,
        observed_at=cfg.now.isoformat(), resolutions=resolutions,
        extraction=extraction, writes=writes, revision_of=revision_of, suppressed=suppressed,
        simulated=cfg.dry_run, planned_writes=planned_writes,  # G-LEDGER-6
        partial=any(r.outcome != "filed" for r in pending),
    )
    ledger.append(row)  # persisted in BOTH dry-run and live (C7/G0A-3)

    if cfg.dry_run:
        previews.append(projections.plan_message_preview(
            msg, resolutions, extraction, cached=not called, crm_lines=crm_lines,
            page_diffs=page_diffs, task_lines=task_lines, escalation_text=escalation_text,
            digest_lines=projections.plan_digest_line(row),  # C6 "digest preview" consumer
        ))

    return filed_now, len(escalated), len(ignored)


def run(cfg: Config, runner) -> RunResult:
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    claims_dir = cfg.state_dir / "claims"
    result = RunResult(exit_code=0)
    ledger = Ledger(cfg.state_dir / "observations.jsonl")
    state = _RunState()
    messages_raw: list[dict] = []
    truncation: list[dict] = []
    lease = None

    try:
        # G-LOCK-9 (G2A-3): acquisition happens INSIDE the guarded try, so a
        # missing `cortextos`, an unwritable claims dir or a timed-out claim
        # call lands on the structured failure path (record_failure + exit 3)
        # instead of escaping run() raw. Only a real already-claimed verdict
        # returns None.
        lease = single_flight.acquire(runner, claims_dir, "client-state-gmail", ttl_min=60)
        if lease is None:
            # G0A2-16 / binding goal G4 item 5 (amended 2026-09-14): a lock-held
            # refusal leaves run-receipt.json BYTE-IDENTICAL and writes its cause to
            # last-lock-refusal.json. record_failure is for the gws/extraction/
            # writer/budget/catch-all paths, which the goal still wants on the
            # receipt; a fail-closed halt must not falsify the success receipt.
            record_lock_refusal(cfg.state_dir, holder_pid=os.getpid(), detail=str(claims_dir))  # G-LOCKREF-1
            return RunResult(exit_code=2, previews=["lock held — another run is in progress"])

        # G0B3-6 / A2: heartbeat the lease for the WHOLE acquired interval, not once
        # per message. Wrapping the runner puts a tick on every call boundary the
        # run has — each sweep query, each `gws +read`, the `claude` call, and every
        # CRM/bus write — so neither a 14-day backfill sweep nor one slow extraction
        # can let a live run's lock go stale.
        heartbeat = single_flight.Heartbeat(lease, clock=cfg.clock)
        runner = single_flight.HeartbeatRunner(runner, heartbeat)  # G-LOCK-8

        messages_raw, truncation = gmail_source.sweep(runner, cfg.days, cfg.today, extra_query=cfg.query)  # G-QUERY-1
        result.truncation = truncation

        contacts = resolve_email.load_contacts(cfg.crm_dir)
        closed = load_closed_sets(cfg.vault)
        resolver = resolve_email.EmailResolver(closed, contacts)

        for raw in messages_raw:
            # G0B2-13: one more liveness check at the message boundary. The
            # heartbeat wrapper already ticks on every runner call; this makes
            # the stop condition explicit at the point where the next message's
            # effects would begin, and raises LeaseLost if the lock is gone.
            heartbeat.tick()
            message_id = raw.get("id") or raw.get("messageId")
            if not message_id:
                continue
            msg = gmail_source.read_message(runner, message_id)
            digest = content_digest(msg.subject, msg.body_text, msg.from_email)
            source_ref = f"gmail:{msg.id}"

            if ledger.is_terminal(source_ref, digest):  # G-IDEMP-1
                result.skipped_terminal += 1
                continue

            filed, escalated, ignored = _file_message(cfg, runner, ledger, resolver, msg, contacts, result.previews, state)
            result.filed += filed
            result.escalated += escalated
            result.ignored += ignored

        receipt = {
            "last_success_at": cfg.now.isoformat(), "window_days": cfg.days,
            "message_count": len(messages_raw), "truncation": truncation, "cost_usd": state.cost,
        }
        write_receipt(cfg.state_dir, receipt)  # persisted in BOTH dry-run and live (C7/G0A-3)
        result.cost_usd = state.cost
        return result
    except extract_email.BudgetExceeded as exc:
        # G0B-6: the exception's own already-paid extraction (cost/model_receipt/
        # cache) must not be discarded -- add its cost and persist a receipt that
        # carries the REAL partial cost, never falsely claiming success.
        state.cost += float(exc.extraction.get("cost_usd", 0.0))  # G-BUDGET-1
        record_failure(
            cfg.state_dir, "budget", cost_usd=state.cost,
            message_count=len(messages_raw), truncation=truncation,
            model_receipt=exc.extraction.get("model_receipt"),  # G0B-6
        )
        result.exit_code = 12
        result.cost_usd = state.cost
        result.previews.append(f"budget exceeded: {exc}")
        return result
    except (
        GmailSourceError, extract_email.ExtractionError, client_state_writes.WriterError,
        client_state_writes.TaskEnumerationError, EscalationError, single_flight.LeaseLost,
        single_flight.LeaseAcquireError, PageLockTimeout,
    ) as exc:
        # G0B-6: a failure receipt carries the partial progress this run made
        # (messages seen, truncation, cost already paid) alongside the error.
        record_failure(cfg.state_dir, str(exc), cost_usd=state.cost, message_count=len(messages_raw), truncation=truncation)  # G-FAIL-1
        result.exit_code = 3
        result.cost_usd = state.cost
        return result
    except Exception as exc:  # noqa: BLE001 -- catch-all per C7: record_failure + exit 3
        record_failure(
            cfg.state_dir, str(exc), cost_usd=state.cost,
            message_count=len(messages_raw), truncation=truncation,
        )
        result.exit_code = 3
        result.cost_usd = state.cost
        return result
    finally:
        try:
            if lease is not None:
                lease.release()  # G-LOCK-6: a no-op once the lease is lost
        except single_flight.LeaseReleaseError as exc:
            # G0B3-11: the work may well have succeeded, but the lock is still
            # held — every later poll will refuse. Surface it as exit 3 with its
            # own diagnostic, and DO NOT touch the receipt: `last_success_at`
            # describes the work, which really did happen.
            record_lease_release_failure(cfg.state_dir, str(exc))  # G-LOCK-7
            result.exit_code = 3
            result.previews.append(f"lease release failed: {exc}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--crm-dir", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--days", type=int, default=3)
    parser.add_argument("--query", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-usd", type=float, default=2.0)
    parser.add_argument("--today", default=None)
    args = parser.parse_args(argv)

    today = date.fromisoformat(args.today) if args.today else datetime.now(timezone.utc).date()
    cfg = Config(
        repo_root=Path(args.repo_root), vault=Path(args.vault), crm_dir=Path(args.crm_dir),
        state_dir=Path(args.state_dir), days=args.days, query=args.query, dry_run=args.dry_run,
        max_usd=args.max_usd, today=today, now=datetime.now(timezone.utc),
    )
    from runner import LoggingRunner, SubprocessRunner
    runner = LoggingRunner(SubprocessRunner(), cfg.state_dir)
    result = run(cfg, runner)
    for line in result.previews:
        print(line)
    print(
        f"filed={result.filed} escalated={result.escalated} ignored={result.ignored} "
        f"skipped_terminal={result.skipped_terminal} cost_usd={result.cost_usd:.4f}"
    )
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
