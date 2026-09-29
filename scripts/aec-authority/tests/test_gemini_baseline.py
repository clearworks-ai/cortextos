import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "gemini_baseline.py"
SPEC = importlib.util.spec_from_file_location("gemini_baseline", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class GeminiBaselineTests(unittest.TestCase):
    def test_load_prompts_preserves_exact_text(self):
        rows = "\n".join(
            f"| L{i:02d} | Cluster {i} | Exact prompt {i}? |" for i in range(1, 26)
        )
        source = f"# Prompts\n\n## Frozen weekly core\n\n| ID | Cluster | Exact prompt |\n|---|---|---|\n{rows}\n\n## Surfaces\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prompts.md"
            path.write_text(source, encoding="utf-8")
            prompts = MODULE.load_prompts(path)
        self.assertEqual(25, len(prompts))
        self.assertEqual("Exact prompt 1?", prompts[0]["prompt_text"])
        self.assertEqual("Exact prompt 25?", prompts[-1]["prompt_text"])

    def test_validate_manifest_schema(self):
        record = {
            "prompt_id": "L01",
            "prompt_text": "Prompt?",
            "cluster": "Local discovery",
            "run_timestamp": "2026-09-25T00:00:00Z",
            "technical_status": "success",
            "grounding_queries": ["query"],
            "citations": [{"source_url": "https://example.com"}],
            "raw_response_path": "raw/L01.json",
        }
        manifest = {
            "schema_version": "gemini-grounded-baseline-manifest/v1",
            "run_id": "test-run",
            "prompt_set_version": "v1",
            "model_requested": "gemini-2.5-flash",
            "model_used": "gemini-2.5-flash",
            "started_at": "2026-09-25T00:00:00Z",
            "prompts": [record],
            "totals": {"status_counts": {"success": 1}},
        }
        MODULE.validate_manifest(manifest)
        duplicate = dict(manifest)
        duplicate["prompts"] = [record, dict(record)]
        with self.assertRaisesRegex(ValueError, "unique"):
            MODULE.validate_manifest(duplicate)

    def test_secret_redaction_before_json_write(self):
        secret = "gemini-secret-do-not-store"
        value = {
            "direct": secret,
            "header": f"x-goog-api-key: {secret}",
            "url": f"https://example.test/path?key={secret}&x=1",
            "nested": [{"message": f"GEMINI_API_KEY={secret}"}],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safe.json"
            MODULE.write_json(path, value, (secret,))
            rendered = path.read_text(encoding="utf-8")
            parsed = json.loads(rendered)
        self.assertNotIn(secret, rendered)
        self.assertIn("[REDACTED]", rendered)
        self.assertEqual("[REDACTED]", parsed["direct"])


if __name__ == "__main__":
    unittest.main()
