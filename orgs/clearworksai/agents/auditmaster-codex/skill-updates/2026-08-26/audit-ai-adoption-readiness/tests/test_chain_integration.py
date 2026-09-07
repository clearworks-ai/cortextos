#!/usr/bin/env python3

import importlib.util
import tempfile
import unittest
from pathlib import Path

STAGED = Path(__file__).resolve().parents[2]
GATE_SPEC = importlib.util.spec_from_file_location(
    "analysis_gate", STAGED / "audit-solution-portfolio" / "scripts" / "analysis_gate.py"
)
GATE = importlib.util.module_from_spec(GATE_SPEC)
GATE_SPEC.loader.exec_module(GATE)


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
        self.assertIn("analysis_gate.py", text)

    def test_solution_gate_passes_with_complete_analysis_set(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in (
                "01-painpoint-atlas.md", "03-systems.md", "04-integration.md",
                "04a-ai-adoption.md", "05-workflows.md", "13-architecture.md",
            ):
                (Path(directory) / name).touch()
            self.assertEqual(GATE.missing_sections(directory), [])

    def test_solution_gate_fails_when_only_readiness_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in (
                "01-painpoint-atlas.md", "03-systems.md", "04-integration.md",
                "05-workflows.md", "13-architecture.md",
            ):
                (Path(directory) / name).touch()
            self.assertEqual(GATE.missing_sections(directory), ["04a*ai*adoption*"])

    def test_master_assembly_includes_readiness_section(self):
        text = (STAGED / "audit-assemble-master" / "SKILL.md").read_text()
        self.assertIn("04a AI operating environment and adoption", text)


if __name__ == "__main__":
    unittest.main()
