"""Tests for enrich-contact.py — DESIGN-B-crm.md §1 keyless enrichment + optional adapters.

Focus: the keyless path must work fully with NO API keys, must fill blanks only, must label
every email, and the paid Firecrawl/PDL adapters must stay behind the financial approval gate.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("enrich-contact.py")


def _load_module():
    """enrich-contact.py has a hyphen, so import by spec for direct unit calls."""
    spec = importlib.util.spec_from_file_location("enrich_contact", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EnrichContactCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.contacts_path = self.root / "contacts.json"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_contacts(self, contacts: list[dict]) -> None:
        self.contacts_path.write_text(
            json.dumps({"version": "1.0.0", "contacts": contacts}, indent=2) + "\n",
            encoding="utf-8",
        )

    def read_contact(self, contact_id: str) -> dict:
        data = json.loads(self.contacts_path.read_text(encoding="utf-8"))
        return next(c for c in data["contacts"] if c["id"] == contact_id)

    def run_cli(self, *args: str, env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["CRM_CONTACTS_PATH"] = str(self.contacts_path)
        # Guarantee a truly keyless environment unless a test opts in.
        env.pop("FIRECRAWL_API_KEY", None)
        env.pop("PDL_API_KEY", None)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            ["python3", str(SCRIPT_PATH), *args],
            capture_output=True, text=True, env=env, cwd=str(SCRIPT_PATH.parent),
        )

    # ---- keyless base ------------------------------------------------------------------

    def test_keyless_fills_blanks_and_labels_email(self) -> None:
        """No keys at all: WEB-provided fields fill blanks, real email -> UNVERIFIED, provenance stamped."""
        self.write_contacts([{
            "id": "jane-doe", "name": "Jane Doe",
            "company": None, "role": None, "industry": None,
            "emails": ["jane@acme.com"], "email_status": None, "enrichment": None,
        }])
        result = self.run_cli("--contact-id", "jane-doe",
                              "--company", "Acme Inc", "--role", "VP Eng", "--industry", "SaaS")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["mode"], "keyless")
        self.assertEqual(report["email_status"], "UNVERIFIED")
        self.assertEqual(report["held_for_approval"], [])

        c = self.read_contact("jane-doe")
        self.assertEqual(c["company"], "Acme Inc")
        self.assertEqual(c["role"], "VP Eng")
        self.assertEqual(c["industry"], "SaaS")
        self.assertEqual(c["email_status"], "UNVERIFIED")
        self.assertEqual(c["enrichment"]["sources"], ["WEB"])
        self.assertIn("enriched_at", c["enrichment"])

    def test_fill_blanks_only_never_overwrites_human_value(self) -> None:
        """A human-entered company must survive; only the null role is filled."""
        self.write_contacts([{
            "id": "kim-lee", "name": "Kim Lee",
            "company": "HumanCo", "role": None,
            "emails": ["kim@humanco.io"], "email_status": None, "enrichment": None,
        }])
        result = self.run_cli("--contact-id", "kim-lee", "--company", "RobotCo", "--role", "CTO")
        self.assertEqual(result.returncode, 0, result.stderr)
        c = self.read_contact("kim-lee")
        self.assertEqual(c["company"], "HumanCo")   # NOT overwritten
        self.assertEqual(c["role"], "CTO")          # blank filled

    def test_pattern_inferred_email_when_no_address_but_domain_known(self) -> None:
        """No usable email + a known company domain -> pattern-infer, label PATTERN-INFERRED."""
        self.write_contacts([{
            "id": "sam-park", "name": "Sam Park",
            "company": "Acme", "emails": ["placeholder@acme.io"], "email_status": None, "enrichment": None,
        }])
        # placeholder@acme.io is a valid address -> counts as verifiable -> UNVERIFIED, not inferred.
        r1 = self.run_cli("--contact-id", "sam-park")
        self.assertEqual(json.loads(r1.stdout)["email_status"], "UNVERIFIED")

        # Now a contact with NO parseable address but a domain hint carried on a malformed entry.
        self.write_contacts([{
            "id": "lee-wong", "name": "Lee Wong",
            "company": "Acme", "emails": ["@acme.io"], "email_status": None, "enrichment": None,
        }])
        r2 = self.run_cli("--contact-id", "lee-wong")
        report = json.loads(r2.stdout)
        self.assertEqual(report["email_status"], "PATTERN-INFERRED")
        c = self.read_contact("lee-wong")
        self.assertIn("lee.wong@acme.io", c["emails"])
        self.assertIn("PATTERN-INFERRED", c["enrichment"]["sources"])

    def test_idempotent_second_run_fills_nothing(self) -> None:
        self.write_contacts([{
            "id": "jane-doe", "name": "Jane Doe", "company": None,
            "emails": ["jane@acme.com"], "email_status": None, "enrichment": None,
        }])
        self.run_cli("--contact-id", "jane-doe", "--company", "Acme")
        r2 = self.run_cli("--contact-id", "jane-doe", "--company", "Acme")
        self.assertEqual(json.loads(r2.stdout)["filled"], {})

    def test_missing_contact_returns_2(self) -> None:
        self.write_contacts([])
        result = self.run_cli("--contact-id", "nobody")
        self.assertEqual(result.returncode, 2)

    # ---- financial spend gate ----------------------------------------------------------

    def test_paid_keys_present_but_no_approval_are_held(self) -> None:
        """A Firecrawl/PDL key present WITHOUT --approved-spend must be held, not fired; keyless still lands."""
        self.write_contacts([{
            "id": "jane-doe", "name": "Jane Doe", "role": None,
            "emails": ["jane@acme.com"], "email_status": None, "enrichment": None,
        }])
        result = self.run_cli(
            "--contact-id", "jane-doe", "--role", "VP",
            env_extra={"FIRECRAWL_API_KEY": "fake", "PDL_API_KEY": "fake"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(sorted(report["held_for_approval"]), ["FIRECRAWL", "PDL"])
        self.assertEqual(report["mode"], "keyless")
        # Keyless WEB result still applied despite the paid adapters being held.
        self.assertEqual(self.read_contact("jane-doe")["role"], "VP")


class EnrichContactAdapterUnitTests(unittest.TestCase):
    """Direct unit tests of the enrich() core with a stub opener — no real network, no real keys."""

    def setUp(self) -> None:
        self.mod = _load_module()

    def _fake_opener(self, payload: dict):
        class _Resp:
            def __init__(self, body): self._body = json.dumps(body).encode("utf-8")
            def read(self): return self._body
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def opener(req, timeout=None):
            return _Resp(payload)
        return opener

    def test_pdl_adapter_fires_only_with_key_and_approval(self) -> None:
        contact = {"id": "x", "name": "Ada Byte", "company": None, "role": None,
                   "emails": ["ada@bytecorp.com"], "email_status": None, "enrichment": None}
        opener = self._fake_opener({"data": {"job_title": "Head of Data", "job_company_name": "ByteCorp"}})
        report = self.mod.enrich(
            contact, {}, firecrawl_key=None, pdl_key="k", approved_spend=True, opener=opener,
        )
        self.assertEqual(contact["role"], "Head of Data")
        self.assertEqual(contact["company"], "ByteCorp")
        self.assertIn("PDL", report["sources"])
        self.assertEqual(report["mode"], "paid")

    def test_adapter_held_without_approval_even_with_key(self) -> None:
        contact = {"id": "x", "name": "Ada Byte", "role": None,
                   "emails": ["ada@bytecorp.com"], "email_status": None, "enrichment": None}
        opener = self._fake_opener({"data": {"job_title": "Head of Data"}})
        report = self.mod.enrich(
            contact, {}, firecrawl_key="k", pdl_key=None, approved_spend=False, opener=opener,
        )
        self.assertEqual(report["held_for_approval"], ["FIRECRAWL"])
        self.assertIsNone(contact.get("role"))  # adapter did NOT fire

    def test_keyless_enrich_makes_no_network_call(self) -> None:
        """Prove the keyless path never touches the opener (safe to run on every contact-create)."""
        def exploding_opener(req, timeout=None):
            raise AssertionError("keyless mode must not make a network call")
        contact = {"id": "x", "name": "Ada Byte", "company": None,
                   "emails": ["ada@bytecorp.com"], "email_status": None, "enrichment": None}
        report = self.mod.enrich(
            contact, {"company": "ByteCorp"},
            firecrawl_key=None, pdl_key=None, approved_spend=False, opener=exploding_opener,
        )
        self.assertEqual(contact["company"], "ByteCorp")
        self.assertEqual(report["mode"], "keyless")


if __name__ == "__main__":
    unittest.main()
