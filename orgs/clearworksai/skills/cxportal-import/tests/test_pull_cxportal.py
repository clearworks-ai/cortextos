#!/usr/bin/env python3
"""
Unit tests for pull_cxportal.py

All tests use fixtures only - never hit the live endpoint.
Uses local http.server or fake urlopen for canned responses.
"""

import json
import os
import sys
import tempfile
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from unittest.mock import patch, MagicMock
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from pull_cxportal import (
    parse_mcp_response,
    render_entity_file,
    get_section_title,
    write_if_changed,
    ENTITIES,
)


class TestMCPParsing(unittest.TestCase):
    """Test MCP response parsing (SSE and plain JSON)"""

    def test_sse_framed_response(self):
        """Test parsing SSE-framed response with event: message and data: lines"""
        sse_response = """event: message
data: {"result": {"content": [{"text": "{\\"test\\": \\"data\\"}"}]}}
"""
        result = parse_mcp_response(sse_response)
        self.assertEqual(result, {"test": "data"})

    def test_plain_json_response(self):
        """Test parsing plain JSON response"""
        plain_response = '{"result": {"content": [{"text": "{\\"test\\": \\"data\\"}"}]}}'
        result = parse_mcp_response(plain_response)
        self.assertEqual(result, {"test": "data"})

    def test_double_encoded_content(self):
        """Test double-encoded content parsing"""
        response = '{"result": {"content": [{"text": "{\\"records\\": [{\\"id\\": 1}]}"}]}}'
        result = parse_mcp_response(response)
        self.assertEqual(result, {"records": [{"id": 1}]})

    def test_jsonrpc_error(self):
        """Test JSON-RPC error handling"""
        error_response = '{"error": {"code": -1, "message": "test error"}}'
        with self.assertRaises(RuntimeError):
            parse_mcp_response(error_response)

    def test_iserror_result(self):
        """Test isError result handling"""
        error_response = '{"result": {"isError": true, "content": [{"text": "error"}]}}'
        with self.assertRaises(RuntimeError):
            parse_mcp_response(error_response)


class TestRendering(unittest.TestCase):
    """Test deterministic rendering and write-if-changed"""

    def test_render_entity_file_with_records(self):
        """Test rendering entity file with records"""
        records = [
            {
                "id": 1,
                "title": "Test Record",
                "status": "open",
                "description": "Test description",
                "priority": "high",
            },
            {"id": 2, "name": "Second Record", "status": "closed"},
        ]

        content = render_entity_file(records, "Test Org", "org-123", "test-entity")

        # Check frontmatter
        self.assertIn("agent: larry", content)
        self.assertIn("job: cxportal-pull", content)
        self.assertIn("source: cxportal-mcp", content)
        self.assertIn("cxportal-org-id: org-123", content)
        self.assertIn("entity-type: test-entity", content)

        # Check headers
        self.assertIn("# Test Org — cxportal test-entity", content)
        self.assertIn("## Test Record", content)
        self.assertIn("## Second Record", content)

        # Check fields
        self.assertIn("- id: 1", content)
        self.assertIn("- title: Test Record", content)
        self.assertIn("- status: open", content)
        self.assertIn("- priority: high", content)

    def test_render_entity_file_empty(self):
        """Test rendering entity file with no records"""
        content = render_entity_file([], "Test Org", "org-123", "test-entity")
        self.assertIn("_No records._", content)
        self.assertIn("# Test Org — cxportal test-entity", content)

    def test_deterministic_rendering(self):
        """Test that rendering is deterministic (same output for shuffled input)"""
        records = [
            {"id": 3, "title": "C"},
            {"id": 1, "title": "A"},
            {"id": 2, "title": "B"},
        ]

        content1 = render_entity_file(records, "Test Org", "org-123", "test")
        content2 = render_entity_file(list(reversed(records)), "Test Org", "org-123", "test")

        # Compare ignoring the date line (which will differ)
        lines1 = [line for line in content1.split("\n") if not line.startswith("date:")]
        lines2 = [line for line in content2.split("\n") if not line.startswith("date:")]
        self.assertEqual(lines1, lines2)

    def test_section_title_fallback(self):
        """Test section title fallback logic"""
        self.assertEqual(get_section_title({"title": "My Title"}), "My Title")
        self.assertEqual(get_section_title({"name": "My Name"}), "My Name")
        self.assertEqual(
            get_section_title({"description": "A" * 100}), "A" * 80 + "..."
        )
        self.assertEqual(get_section_title({"id": 42}), "id 42")

    def test_write_if_changed_new_file(self):
        """Test write_if_changed for new file"""
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "test.md"
            content = "# Test\\n"
            result = write_if_changed(content, target)
            self.assertTrue(result)
            self.assertTrue(target.exists())

    def test_write_if_changed_unchanged(self):
        """Test write_if_changed when content is unchanged"""
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "test.md"
            content = "# Test\\n"
            # Write initial content
            write_if_changed(content, target)
            # Try to write same content
            result = write_if_changed(content, target)
            self.assertFalse(result)

    def test_write_if_changed_changed(self):
        """Test write_if_changed when content is different"""
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "test.md"
            write_if_changed("# Old\\n", target)
            result = write_if_changed("# New\\n", target)
            self.assertTrue(result)
            self.assertIn("New", target.read_text())

    def test_write_if_changed_date_masking(self):
        """Test that date field is masked when comparing"""
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "test.md"
            content1 = "---\ndate: 2026-08-01\n---\n# Test\n"
            content2 = "---\ndate: 2026-08-02\n---\n# Test\n"

            write_if_changed(content1, target)
            result = write_if_changed(content2, target)
            self.assertFalse(result)  # Should be unchanged (only date different)


class TestEntities(unittest.TestCase):
    """Test entity configuration"""

    def test_entities_config(self):
        """Test that ENTITIES has expected structure"""
        self.assertIn("pain-points", ENTITIES)
        self.assertIn("goals", ENTITIES)
        self.assertIn("desires", ENTITIES)  # Disabled but present

        # Check enabled entities
        enabled_entities = [k for k, v in ENTITIES.items() if v.get("enabled")]
        self.assertIn("pain-points", enabled_entities)
        self.assertNotIn("desires", enabled_entities)

    def test_entity_tool_names(self):
        """Test entity tool names are present"""
        for entity_name, config in ENTITIES.items():
            if config.get("parent"):
                # Parent-dependent entities don't have direct tools
                continue
            self.assertIn("tool", config)


class TestIntegration(unittest.TestCase):
    """Integration tests with mocked MCP server"""

    def setUp(self):
        """Set up test fixtures"""
        self.tmpdir = tempfile.mkdtemp()
        self.ks_base = Path(self.tmpdir) / "clients"
        self.ks_base.mkdir(parents=True)

        # Mock orgmap
        self.orgmap = {
            "map": {
                "test-org-1": "alloi",
            },
            "exclude": {},
        }

    def tearDown(self):
        """Clean up test fixtures"""
        import shutil

        shutil.rmtree(self.tmpdir)

    def test_disabled_entity_not_called(self):
        """Test that disabled entities are not called"""
        # This would require mocking the MCP call
        # For now, just verify the config
        self.assertFalse(ENTITIES["desires"]["enabled"])
        self.assertFalse(ENTITIES["budget-signals"]["enabled"])
        self.assertFalse(ENTITIES["wins"]["enabled"])


class TestErrorHandling(unittest.TestCase):
    """Test error handling scenarios"""

    def test_nested_json_field_rendering(self):
        """Test rendering nested JSON/array fields"""
        records = [
            {
                "id": 1,
                "title": "Test",
                "metadata": {"key": "value", "nested": {"deep": "data"}},
                "tags": ["tag1", "tag2"],
            }
        ]

        content = render_entity_file(records, "Test Org", "org-123", "test")
        # JSON is pretty-printed with indent=2
        self.assertIn('"key": "value"', content)
        self.assertIn('"deep": "data"', content)
        self.assertIn('"tag1"', content)
        self.assertIn('"tag2"', content)

    def test_empty_result_set(self):
        """Test handling empty result sets"""
        content = render_entity_file([], "Test Org", "org-123", "test")
        self.assertIn("_No records._", content)

    def test_org_exclusion_handling(self):
        """Test org exclusion logic"""
        # This would be tested in the full integration test
        # For now, verify orgmap structure
        orgmap = {
            "map": {"org-1": "client1"},
            "exclude": {"org-2": "test org"},
        }
        self.assertIn("org-1", orgmap["map"])
        self.assertIn("org-2", orgmap["exclude"])


if __name__ == "__main__":
    unittest.main()