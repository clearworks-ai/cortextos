#!/usr/bin/env python3
"""Single-contact enrichment for the crm agent (DESIGN-B-crm.md §1).

The event lane (AGENTS.md Records-Admin Event Runbook, E3 `crm.contact.created`) invokes
this on a newly-created contact to run the "enrich on arrival" rung of the contact-enrichment
ladder. It is also usable stand-alone (`--contact-id <id>`).

Design contract (DESIGN-B-crm.md §1 + data-enrichment-specialist SKILL.md):

* **Keyless base is the default and always works.** With no API keys present, the pass fills
  blanks from data already handed to it (title/role/company/industry/linkedin/phone passed via
  flags — sourced by the agent's web + LinkedIn research), pattern-infers the email when only a
  name + company domain are known, and labels every email with an ``email_status``. Nothing here
  makes a network call in keyless mode, so it is safe to run on every contact-create for free.
* **Optional adapters** (`FIRECRAWL_API_KEY`, `PDL_API_KEY`) upgrade the pass when present, but
  they are strictly additive — absence is not an error and never blocks the keyless result.
* **Spend gate (financial approval).** Firecrawl and PDL are paid. Per crm ``config.json``
  ``approval_rules.always_ask: ["financial"]`` the paid adapters DO NOT fire unless
  ``--approved-spend`` is passed (the human-click). Without it, an available key is reported as
  ``held_for_approval`` and the keyless result still lands. This is the "paid batches → approval
  queue" rule, enforced concretely rather than assumed.
* **Fill-blanks-only.** Enrichment never overwrites a human-entered value on
  ``company``/``role``/``industry`` — it only fills a ``null``/empty slot (schema.md rule).
* **Provenance on every field.** ``enrichment.sources`` records where each filled field came from
  (``WEB`` / ``PATTERN-INFERRED`` / ``FIRECRAWL`` / ``PDL``); ``enrichment.enriched_at`` stamps
  the run. Nothing lands unlabeled.

Writes are atomic and idempotent: re-running on an already-filled contact is a no-op for the
filled fields (blanks-only) and simply refreshes ``enriched_at`` + the source set.

Exit codes: 0 = enriched (or nothing to do), 2 = bad args / contact not found.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CRM_DIR = Path(__file__).resolve().parent
CONTACTS_PATH = Path(os.environ.get("CRM_CONTACTS_PATH", CRM_DIR / "contacts.json"))

VALID_EMAIL_STATUSES = {"VALID", "RISKY", "INVALID", "UNVERIFIED", "PATTERN-INFERRED"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_contacts() -> dict[str, Any]:
    if not CONTACTS_PATH.exists():
        return {"version": "1.0.0", "contacts": []}
    return json.loads(CONTACTS_PATH.read_text(encoding="utf-8"))


def write_contacts_atomic(data: dict[str, Any]) -> None:
    CONTACTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=CONTACTS_PATH.parent,
        prefix=f"{CONTACTS_PATH.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, CONTACTS_PATH)


def find_contact(contacts: list[dict[str, Any]], contact_id: str) -> dict[str, Any] | None:
    for contact in contacts:
        if isinstance(contact, dict) and contact.get("id") == contact_id:
            return contact
    return None


def is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def contact_domain(contact: dict[str, Any]) -> str | None:
    """Detect the contact's email domain from any existing address (for pattern inference)."""
    emails: list[str] = []
    primary = contact.get("email")
    if isinstance(primary, str):
        emails.append(primary)
    stored = contact.get("emails")
    if isinstance(stored, list):
        emails.extend(e for e in stored if isinstance(e, str))
    for email in emails:
        if "@" in email:
            dom = email.rsplit("@", 1)[-1].strip().lower()
            if dom:
                return dom
    return None


def infer_email(name: str, domain: str) -> str | None:
    """first.last@domain — the single acceptable guess, always labelled PATTERN-INFERRED."""
    parts = [p for p in re.split(r"\s+", (name or "").strip().lower()) if p]
    parts = ["".join(ch for ch in p if ch.isalnum()) for p in parts]
    parts = [p for p in parts if p]
    if not parts or not domain:
        return None
    local = f"{parts[0]}.{parts[-1]}" if len(parts) >= 2 else parts[0]
    candidate = f"{local}@{domain}"
    return candidate if EMAIL_RE.match(candidate) else None


def has_verifiable_email(contact: dict[str, Any]) -> bool:
    primary = contact.get("email")
    if isinstance(primary, str) and EMAIL_RE.match(primary.strip()):
        return True
    for email in contact.get("emails") or []:
        if isinstance(email, str) and EMAIL_RE.match(email.strip()):
            return True
    return False


# ---- optional paid adapters (fire only with a key AND --approved-spend) -------------------

def firecrawl_lookup(domain: str, api_key: str, *, opener=urllib.request.urlopen) -> dict[str, Any]:
    """Best-effort Firecrawl scrape of the company site for firmographics. Failures degrade to {}."""
    try:
        req = urllib.request.Request(
            "https://api.firecrawl.dev/v1/scrape",
            data=json.dumps({"url": f"https://{domain}", "formats": ["json"]}).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with opener(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        data = (body.get("data") or {}).get("json") or {}
        return {k: v for k, v in {
            "company": data.get("company_name"),
            "industry": data.get("industry"),
        }.items() if v}
    except (urllib.error.URLError, OSError, ValueError, TypeError):
        return {}


def pdl_lookup(name: str, domain: str, api_key: str, *, opener=urllib.request.urlopen) -> dict[str, Any]:
    """Best-effort People Data Labs person enrichment. Failures degrade to {}."""
    try:
        query = urllib.parse.urlencode({"name": name, "company": domain})
        req = urllib.request.Request(
            f"https://api.peopledatalabs.com/v5/person/enrich?{query}",
            headers={"X-Api-Key": api_key},
            method="GET",
        )
        with opener(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        data = body.get("data") or {}
        return {k: v for k, v in {
            "role": data.get("job_title"),
            "company": data.get("job_company_name"),
            "industry": data.get("job_company_industry"),
            "linkedin_url": data.get("linkedin_url"),
        }.items() if v}
    except (urllib.error.URLError, OSError, ValueError, TypeError):
        return {}


def enrich(contact: dict[str, Any], provided: dict[str, Any], *,
           firecrawl_key: str | None, pdl_key: str | None, approved_spend: bool,
           opener=urllib.request.urlopen) -> dict[str, Any]:
    """Apply enrichment to ``contact`` in place, fill-blanks-only. Returns a run report."""
    sources: set[str] = set()
    filled: dict[str, str] = {}
    held: list[str] = []

    # --- gather candidate field values, weakest-source first so stronger ones win the merge ---
    candidates: dict[str, tuple[str, str]] = {}  # field -> (value, source)

    # 1. Keyless WEB layer: agent-supplied research values (title/company/etc via flags).
    for field in ("company", "role", "industry", "location", "linkedin_url", "phone"):
        val = provided.get(field)
        if isinstance(val, str) and val.strip():
            candidates[field] = (val.strip(), "WEB")

    # 2. Optional paid adapters — only with a key AND explicit spend approval (financial gate).
    domain = contact_domain(contact)
    name = str(contact.get("name") or "")
    for key, adapter_name, adapter in (
        (firecrawl_key, "FIRECRAWL", "firecrawl"),
        (pdl_key, "PDL", "pdl"),
    ):
        if not key:
            continue
        if not approved_spend:
            held.append(adapter_name)  # paid: held for approval-queue, DESIGN-B financial gate
            continue
        if not domain:
            continue
        if adapter == "firecrawl":
            data = firecrawl_lookup(domain, key, opener=opener)
        else:
            data = pdl_lookup(name, domain, key, opener=opener)
        for field, value in data.items():
            if isinstance(value, str) and value.strip():
                candidates[field] = (value.strip(), adapter_name)  # paid source wins over WEB

    # --- apply fill-blanks-only ---
    for field, (value, source) in candidates.items():
        if is_blank(contact.get(field)):
            contact[field] = value
            filled[field] = source
            sources.add(source)

    # --- email status labelling (Step 2: every address gets a status) ---
    email_status = None
    if has_verifiable_email(contact):
        # Keyless: no SMTP verifier wired, so a real, well-formed address is UNVERIFIED.
        email_status = "UNVERIFIED"
    else:
        # No usable address — try pattern inference off a known company domain.
        inferred = infer_email(name, domain) if domain else None
        if inferred:
            emails = contact.setdefault("emails", [])
            if inferred not in emails:
                emails.append(inferred)
            email_status = "PATTERN-INFERRED"
            filled["email"] = "PATTERN-INFERRED"
            sources.add("PATTERN-INFERRED")

    if email_status:
        contact["email_status"] = email_status

    # --- provenance envelope (always stamped when the pass ran) ---
    prior = contact.get("enrichment") if isinstance(contact.get("enrichment"), dict) else {}
    prior_sources = prior.get("sources") if isinstance(prior.get("sources"), list) else []
    merged_sources = sorted(set(prior_sources) | sources)
    contact["enrichment"] = {"sources": merged_sources, "enriched_at": now_iso()}

    return {
        "contact_id": contact.get("id"),
        "filled": filled,
        "email_status": email_status,
        "sources": sorted(sources),
        "held_for_approval": held,
        "mode": "keyless" if not (approved_spend and (firecrawl_key or pdl_key)) else "paid",
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Single-contact enrichment (keyless base + optional Firecrawl/PDL)")
    p.add_argument("--contact-id", required=True)
    p.add_argument("--company")
    p.add_argument("--role")
    p.add_argument("--industry")
    p.add_argument("--location")
    p.add_argument("--linkedin-url", dest="linkedin_url")
    p.add_argument("--phone")
    p.add_argument("--approved-spend", action="store_true",
                   help="human-click that authorizes the paid Firecrawl/PDL adapters (financial gate)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    data = load_contacts()
    contacts = data.setdefault("contacts", [])
    contact = find_contact(contacts, args.contact_id)
    if contact is None:
        print(json.dumps({"status": "error", "error": f"contact not found: {args.contact_id}"}), file=sys.stderr)
        return 2

    provided = {
        "company": args.company,
        "role": args.role,
        "industry": args.industry,
        "location": args.location,
        "linkedin_url": args.linkedin_url,
        "phone": args.phone,
    }
    report = enrich(
        contact,
        provided,
        firecrawl_key=os.environ.get("FIRECRAWL_API_KEY") or None,
        pdl_key=os.environ.get("PDL_API_KEY") or None,
        approved_spend=args.approved_spend,
    )
    write_contacts_atomic(data)
    report["status"] = "enriched"
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
