#!/usr/bin/env python3

import unittest
from pathlib import Path

STAGED = Path(__file__).resolve().parents[2]


class ChainIntegrationTests(unittest.TestCase):
    def test_pipeline_places_phase_before_workflows_and_solutions(self):
        text = (STAGED / "audit-pipeline" / "SKILL.md").read_text()
        readiness = text.index("audit-ai-adoption-readiness")
        workflows = text.index("audit-workflow-maps")
        solutions = text.index("audit-solution-portfolio")
        self.assertLess(readiness, workflows)
        self.assertLess(readiness, solutions)

    def test_solution_gate_requires_readiness_section(self):
        text = (STAGED / "audit-solution-portfolio" / "SKILL.md").read_text()
        self.assertIn('"04a*ai*adoption*"', text)

    def test_master_assembly_includes_readiness_section(self):
        text = (STAGED / "audit-assemble-master" / "SKILL.md").read_text()
        self.assertIn("04a AI operating environment and adoption", text)


if __name__ == "__main__":
    unittest.main()

