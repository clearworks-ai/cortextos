"""Fixture builders every S-04+ test reuses: a minimal two-page vault (alloi.us /
acme.org, one declared CRM org name) and a scratch CRM dir seeded with contacts.json."""
from __future__ import annotations

import json

from resolve_meeting import load_closed_sets

from helpers_client_state import make_crm_dir, make_vault


def test_make_vault_domain_to_slug_keys(tmp_path):
    vault = make_vault(tmp_path)
    closed = load_closed_sets(vault)
    assert closed["domain_to_slug"].get("alloi.us") == "alloi"
    assert closed["domain_to_slug"].get("acme.org") == "acme"
    assert closed["clients"].keys() >= {"alloi", "acme"}


def test_make_crm_dir_writes_contacts_and_interactions(tmp_path):
    contacts = [{"id": "c-1", "name": "Test Person", "emails": ["t@example.com"], "company": None}]
    crm_dir = make_crm_dir(tmp_path, contacts)
    data = json.loads((crm_dir / "contacts.json").read_text(encoding="utf-8"))
    assert data["contacts"] == contacts
    assert data["version"] == 1
    assert (crm_dir / "interactions.jsonl").exists()
    assert (crm_dir / "interactions.jsonl").read_text(encoding="utf-8") == ""
