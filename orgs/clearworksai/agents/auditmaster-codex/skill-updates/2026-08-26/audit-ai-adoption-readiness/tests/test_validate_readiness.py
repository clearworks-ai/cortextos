#!/usr/bin/env python3

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("validate_readiness", ROOT / "scripts" / "validate_readiness.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReadinessValidatorTests(unittest.TestCase):
    def setUp(self):
        self.payload = json.loads((ROOT / "tests" / "fixtures" / "valid-ledger.json").read_text())

    def test_valid_fixture(self):
        self.assertEqual(MODULE.validate(self.payload), [])

    def test_cross_client_evidence_fails(self):
        payload = copy.deepcopy(self.payload)
        payload["findings"][0]["evidence"][0]["evidence_client"] = "another-client"
        self.assertTrue(any("crosses the client boundary" in error for error in MODULE.validate(payload)))

    def test_invalid_state_fails(self):
        payload = copy.deepcopy(self.payload)
        payload["findings"][0]["state"] = "realized"
        self.assertTrue(any("findings[0].state" in error for error in MODULE.validate(payload)))

    def test_not_established_requires_question(self):
        payload = copy.deepcopy(self.payload)
        payload["evidence_gaps"] = []
        self.assertTrue(any("not_established areas require" in error for error in MODULE.validate(payload)))

    def test_duplicate_area_fails(self):
        payload = copy.deepcopy(self.payload)
        payload["assessment_areas"].append(copy.deepcopy(payload["assessment_areas"][0]))
        self.assertTrue(any("duplicated" in error for error in MODULE.validate(payload)))

    def test_validation_is_idempotent(self):
        before = json.dumps(self.payload, sort_keys=True)
        first = MODULE.validate(self.payload)
        second = MODULE.validate(self.payload)
        after = json.dumps(self.payload, sort_keys=True)
        self.assertEqual(first, second)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()

