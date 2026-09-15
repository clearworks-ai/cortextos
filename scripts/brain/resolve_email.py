"""FR-004: standalone email/domain -> entity resolution seam.

Extracted from resolve_meeting.resolve()'s nested _match_contact / _resolve_company_slug
(G-03: the contact-email lookup and company->slug lookup exist but are nested inside
meeting-shaped resolve(), not a standalone import). No LLM, no meeting envelope: given an
email address and the closed sets built by resolve_meeting.load_closed_sets(vault), decide
whether it maps to a known client/org page via a CRM contact's company or via a
page-declared domain.

Resolution.outcome carries a TRANSIENT fourth value here, "pending", in addition to the
persisted "filed" / "escalated" / "ignored" (C3): this module never files anything itself
-- it has no ledger, no writer -- so "pending" marks "eligible to be filed" for the
orchestrator to finalize. A Resolution with outcome "pending" must never be appended to
the observation ledger as-is.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from observation_ledger import Resolution
from resolve_meeting import _norm_title


def load_contacts(crm_dir: Path) -> list[dict[str, Any]]:
    path = Path(crm_dir) / "contacts.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    contacts = data.get("contacts") if isinstance(data, dict) else None
    return contacts if isinstance(contacts, list) else []


def _normalize_email(value: str) -> str:
    # Mirrors upsert-contact.py:normalize_email exactly -- same identity scheme,
    # so a sender address matches the same contact row add-interaction.py would.
    return (value or "").strip().lower()


def _contact_emails(contact: dict[str, Any]) -> list[str]:
    # Mirrors upsert-contact.py:contact_emails exactly (singular "email" field plus
    # the "emails" list, both optional).
    values: list[str] = []
    primary = contact.get("email")
    if isinstance(primary, str):
        values.append(primary)
    stored = contact.get("emails")
    if isinstance(stored, list):
        for item in stored:
            if isinstance(item, str):
                values.append(item)
    return values


def _kind_for_slug(closed: dict[str, Any], slug: str) -> str:
    if not slug:
        return ""
    if slug in closed.get("clients", {}):
        return "client"
    if slug in closed.get("orgs", {}):
        return "org"
    if slug in closed.get("nodes", {}):
        return "project"
    return ""


class EmailResolver:
    def __init__(self, closed: dict[str, Any], contacts: list[dict[str, Any]]) -> None:
        self.closed = closed
        self.contacts = contacts

    def _find_contact(self, email_norm: str) -> dict[str, Any] | None:
        if not email_norm:
            return None
        for contact in self.contacts:
            emails = {_normalize_email(e) for e in _contact_emails(contact)}
            if email_norm in emails:
                return contact
        return None

    def resolve_address(self, email: str) -> Resolution:
        email_norm = _normalize_email(email)
        contact = self._find_contact(email_norm)
        contact_id = contact.get("id") if contact else None

        slug_c: str | None = None
        if contact is not None:
            company = (contact.get("company") or "").strip()
            if company:  # G-RES-2: never pass None/"" into _norm_title, never bind to a "" key
                key = _norm_title(company)
                candidate = self.closed.get("org_name_to_slug", {}).get(key)
                if candidate:  # a duplicate-suppressed CRM org name maps to "" -- no match
                    slug_c = candidate

        dom = email_norm.rsplit("@", 1)[-1] if "@" in email_norm else ""
        slug_d: str | None = None
        if dom:
            candidate = self.closed.get("domain_to_slug", {}).get(dom)  # G-RES-1: FULL domain key only, never registrable_label
            if candidate:
                slug_d = candidate

        if slug_c and slug_d:
            if slug_c == slug_d:
                return Resolution(
                    slug=slug_c,
                    kind=_kind_for_slug(self.closed, slug_c),
                    method="contact-email",
                    outcome="pending",
                    contact_id=contact_id,
                    email=email_norm,
                )
            return Resolution(
                slug="",
                kind="",
                method="",
                outcome="escalated",
                reason=f"ambiguous:{slug_c}|{slug_d}",  # C3: escalated rows always carry the ambiguous reason
                contact_id=contact_id,
                email=email_norm,
            )

        if slug_c or slug_d:
            slug = slug_c or slug_d
            assert slug is not None
            method = "contact-email" if slug_c else "page-domain"
            return Resolution(
                slug=slug,
                kind=_kind_for_slug(self.closed, slug),
                method=method,
                outcome="pending",
                contact_id=contact_id,
                email=email_norm,
            )

        return Resolution(
            slug="",
            kind="",
            method="",
            outcome="ignored",
            reason="no-known-entity",
            contact_id=contact_id,
            email=email_norm,
        )

    def resolve_message(self, msg: Any) -> list[Resolution]:
        r_sender = self.resolve_address(msg.from_email)
        if r_sender.outcome == "ignored":
            # FR-003: sender gates -- an unknown sender means nothing on the
            # message is filed, regardless of who else is on it.
            return [r_sender]

        results: list[Resolution] = [r_sender]
        seen_addresses: set[str] = {_normalize_email(msg.from_email)}

        for addr in msg.counterparties():
            addr_norm = _normalize_email(addr)
            if addr_norm in seen_addresses:  # C3/G0B-9: dedupe EXACT duplicate addresses only, never by slug
                continue
            seen_addresses.add(addr_norm)
            r = self.resolve_address(addr)
            if r.outcome == "ignored":
                continue
            # C3/G0B-9: one Resolution PER KNOWN COUNTERPARTY (contact-level row).
            # Several rows MAY share a slug -- two known contacts at the same client
            # each get their own row so the orchestrator can write a CRM interaction
            # per contact_id, not just one per bound page.
            results.append(r)
        return results
