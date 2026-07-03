"""Behavioral tests for intel_extractor (registry, routing, extraction).

Run from knowledge-base/scripts:

    python -m _test_clients.test_intel_extractor

Exits 0 on all-pass, 1 on any failure. Zero external deps, zero network:
fake Gemini/Anthropic clients are injected directly (and via the
INTEL_*_CLIENT_FACTORY env hooks in test 5).

Scenarios:
  1. registry_complete: all 27 registry keys present, with prompts for each
  2. routing_exact: route_model matches the Clearpath tier sets for every key,
     including the Haiku fallback
  3. env_override: INTEL_MODEL_* env vars change the routed model id
  4. extraction_with_fakes: injected fake clients produce correctly shaped
     records; a per-category failure is isolated (SKIP) without sinking the rest
  5. factory_env_hook: INTEL_GEMINI_CLIENT_FACTORY resolves a dotted path
"""

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import intel_extractor as ie  # noqa: E402

FAILURES = []

ALL_27_KEYS = {
    "objections", "desires", "problems_pains", "voice_of_customer",
    "client_wins", "question_bank", "budget_signals", "competitive_mentions",
    "relationship_trajectory", "product_praise", "bug_reports", "frictions",
    "feature_requests", "story_bank", "ip_builder", "opportunity_finder",
    "language_patterns", "meeting_outcomes", "action_items_extraction",
    "follow_up_needed", "decisions_made", "financial_impact", "cos_flags",
    "calendar_patterns", "email_communication", "cloud_collaboration",
    "discovery_assessment",
}

SONNET_KEYS = {"story_bank", "ip_builder", "relationship_trajectory",
               "opportunity_finder", "cos_flags"}
FLASH_KEYS = {"voice_of_customer", "desires", "problems_pains", "objections",
              "language_patterns", "competitive_mentions", "client_wins",
              "product_praise"}
FLASH_LITE_KEYS = {"question_bank", "budget_signals", "feature_requests",
                   "frictions", "bug_reports"}
HAIKU_KEYS = ALL_27_KEYS - SONNET_KEYS - FLASH_KEYS - FLASH_LITE_KEYS


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


# ---------------------------------------------------------------------------
# Fakes (Gemini / Anthropic client shapes)
# ---------------------------------------------------------------------------
class _GeminiResponse:
    def __init__(self, text):
        self.text = text


class FakeGeminiClient:
    """Shape-compatible with google.genai: .models.generate_content(...)."""

    def __init__(self, payload_fn):
        self._payload_fn = payload_fn
        outer = self

        class _Models:
            def generate_content(self, model=None, contents=None):
                return _GeminiResponse(outer._payload_fn(model, contents))

        self.models = _Models()


class _TextBlock:
    def __init__(self, text):
        self.text = text


class _AnthropicResponse:
    def __init__(self, text):
        self.content = [_TextBlock(text)]


class FakeAnthropicClient:
    """Shape-compatible with anthropic: .messages.create(...)."""

    def __init__(self, payload_fn):
        self._payload_fn = payload_fn
        outer = self

        class _Messages:
            def create(self, model=None, max_tokens=None, messages=None):
                prompt = messages[0]["content"] if messages else ""
                return _AnthropicResponse(outer._payload_fn(model, prompt))

        self.messages = _Messages()


def fake_gemini_factory():
    """Used by test 5 via the INTEL_GEMINI_CLIENT_FACTORY env hook."""
    return FakeGeminiClient(lambda model, contents: "[]")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_registry_complete():
    print("\n[test 1/5] registry_complete: 27 keys, prompts + tiers for each")
    keys = set(ie.REGISTRY_KEYS)
    _check("registry has exactly the 27 Clearpath keys", keys == ALL_27_KEYS,
           detail=f"missing={ALL_27_KEYS - keys} extra={keys - ALL_27_KEYS}")
    _check("PROMPTS covers every registry key",
           set(ie.PROMPTS) == ALL_27_KEYS,
           detail=f"missing={ALL_27_KEYS - set(ie.PROMPTS)}")
    _check("MODEL_TIERS covers every registry key",
           set(ie.MODEL_TIERS) == ALL_27_KEYS,
           detail=f"missing={ALL_27_KEYS - set(ie.MODEL_TIERS)}")
    _check("every prompt has non-empty prompt_text",
           all(ie.PROMPTS[k].get("prompt_text", "").strip() for k in ALL_27_KEYS))
    required_fields = {"key", "label", "display_category", "description",
                       "primary_field", "person_field"}
    _check("every registry entry has the six mirrored fields",
           all(required_fields <= set(entry) for entry in ie.CATEGORY_REGISTRY))
    _check("spot-check fields: question_bank person_field == askedBy",
           ie.REGISTRY_BY_KEY["question_bank"]["person_field"] == "askedBy")
    _check("spot-check fields: relationship_trajectory has no person_field",
           ie.REGISTRY_BY_KEY["relationship_trajectory"]["person_field"] is None)


def test_routing_exact():
    print("\n[test 2/5] routing_exact: Clearpath tier assignment for all 27 keys")
    expected = {}
    for key in SONNET_KEYS:
        expected[key] = ("anthropic", "claude-sonnet-4-5")
    for key in FLASH_KEYS:
        expected[key] = ("gemini", "gemini-2.5-flash")
    for key in FLASH_LITE_KEYS:
        expected[key] = ("gemini", "gemini-2.5-flash-lite")
    for key in HAIKU_KEYS:
        expected[key] = ("anthropic", "claude-haiku-4-5-20251001")

    mismatches = []
    for key in sorted(ALL_27_KEYS):
        route = ie.route_model(key)
        if (route["provider"], route["model"]) != expected[key]:
            mismatches.append(f"{key}: got {route}, want {expected[key]}")
    _check("all 27 keys route to the exact Clearpath tier", not mismatches,
           detail="; ".join(mismatches))
    _check("Haiku fallback covers 9 keys (27 - 5 - 8 - 5)",
           len(HAIKU_KEYS) == 9, detail=f"got {len(HAIKU_KEYS)}")
    fallback = ie.route_model("meeting_outcomes")
    _check("unlisted key falls back to Haiku",
           fallback == {"provider": "anthropic", "model": "claude-haiku-4-5-20251001"},
           detail=str(fallback))


def test_env_override():
    print("\n[test 3/5] env_override: INTEL_MODEL_* changes the routed model id")
    saved = {name: os.environ.get(name) for name in (
        "INTEL_MODEL_SONNET", "INTEL_MODEL_FLASH",
        "INTEL_MODEL_FLASH_LITE", "INTEL_MODEL_HAIKU")}
    try:
        os.environ["INTEL_MODEL_SONNET"] = "sonnet-custom"
        os.environ["INTEL_MODEL_FLASH"] = "flash-custom"
        os.environ["INTEL_MODEL_FLASH_LITE"] = "flash-lite-custom"
        os.environ["INTEL_MODEL_HAIKU"] = "haiku-custom"
        _check("sonnet override", ie.route_model("story_bank")["model"] == "sonnet-custom",
               detail=str(ie.route_model("story_bank")))
        _check("flash override", ie.route_model("objections")["model"] == "flash-custom")
        _check("flash-lite override", ie.route_model("frictions")["model"] == "flash-lite-custom")
        _check("haiku override", ie.route_model("decisions_made")["model"] == "haiku-custom")
        _check("provider unchanged by override",
               ie.route_model("story_bank")["provider"] == "anthropic")
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    _check("override cleared -> default restored",
           ie.route_model("story_bank")["model"] == "claude-sonnet-4-5")


def test_extraction_with_fakes():
    print("\n[test 4/5] extraction_with_fakes: records + per-category isolation")
    tmpdir = tempfile.mkdtemp(prefix="intel-test-")
    try:
        src = os.path.join(tmpdir, "meeting-transcript.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("Josh: The budget is tight.\nMarcos: We love the dashboard.\n")

        def gemini_payload(model, contents):
            # objections is flash-tier; frictions is flash-lite tier -> raise
            if "friction" in str(contents).lower():
                raise RuntimeError("simulated gemini outage")
            return json.dumps([
                {"objection": "Budget is tight", "speaker": "Josh"},
                {"objection": "Timing concern"},
            ])

        def anthropic_payload(model, prompt):
            return json.dumps([{"story": "Dashboard love story", "speaker": "Marcos"}])

        clients = {
            "gemini": FakeGeminiClient(gemini_payload),
            "anthropic": FakeAnthropicClient(anthropic_payload),
        }
        categories = ["objections", "frictions", "story_bank"]
        records = ie.extract_file(src, categories, clients=clients,
                                  now="2026-07-03T00:00:00+00:00")

        by_cat = {}
        for record in records:
            by_cat.setdefault(record["category"], []).append(record)

        _check("objections produced 2 records", len(by_cat.get("objections", [])) == 2,
               detail=str(by_cat))
        _check("story_bank produced 1 record", len(by_cat.get("story_bank", [])) == 1)
        _check("failed category (frictions) isolated -> zero records, no raise",
               "frictions" not in by_cat)
        rec = by_cat["objections"][0]
        _check("record has the required shape",
               set(rec) == {"category", "content", "person", "source_file",
                            "extracted_at", "model"},
               detail=str(sorted(rec)))
        _check("record content from primary_field", rec["content"] == "Budget is tight")
        _check("record person from person_field", rec["person"] == "Josh")
        _check("person omitted -> None", by_cat["objections"][1]["person"] is None)
        _check("record model matches the routed tier",
               rec["model"] == "gemini-2.5-flash", detail=rec["model"])
        _check("sonnet-tier record model", by_cat["story_bank"][0]["model"] == "claude-sonnet-4-5")
        _check("extracted_at passthrough", rec["extracted_at"] == "2026-07-03T00:00:00+00:00")
        _check("source_file recorded", rec["source_file"] == src)

        # Markdown + JSONL rendering round-trip
        out = os.path.join(tmpdir, "out")
        os.makedirs(out)
        jsonl_path = os.path.join(out, "meeting-transcript.intel.jsonl")
        ie.write_jsonl(records, jsonl_path)
        with open(jsonl_path, encoding="utf-8") as f:
            lines = [json.loads(line) for line in f if line.strip()]
        _check("jsonl has one record per extraction", len(lines) == len(records))
        md = ie.render_markdown(src, records)
        _check("markdown groups by category label",
               "## Objections (objections)" in md and "## Story Bank (story_bank)" in md,
               detail=md[:200])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_factory_env_hook():
    print("\n[test 5/5] factory_env_hook: INTEL_GEMINI_CLIENT_FACTORY dotted path")
    saved = os.environ.get("INTEL_GEMINI_CLIENT_FACTORY")
    try:
        os.environ["INTEL_GEMINI_CLIENT_FACTORY"] = (
            "_test_clients.test_intel_extractor:fake_gemini_factory"
        )
        client = ie.get_gemini_client()
        response = client.models.generate_content(model="x", contents="y")
        _check("factory-built fake client responds", response.text == "[]",
               detail=repr(getattr(response, "text", None)))
    finally:
        if saved is None:
            os.environ.pop("INTEL_GEMINI_CLIENT_FACTORY", None)
        else:
            os.environ["INTEL_GEMINI_CLIENT_FACTORY"] = saved


if __name__ == "__main__":
    test_registry_complete()
    test_routing_exact()
    test_env_override()
    test_extraction_with_fakes()
    test_factory_env_hook()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for failure in FAILURES:
            print(f"  - {failure}")
        sys.exit(1)
    print("ALL PASS (5 scenarios)")
    sys.exit(0)
