import os
import sys
from types import SimpleNamespace


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag
from _test_clients.fault_injection import _InjectedAPIError


class _EmbedValues:
    def __init__(self, values):
        self.values = values


class _EmbedResponse:
    def __init__(self, values):
        self.embeddings = [_EmbedValues(values)]


class _GenerateResponse:
    def __init__(self, text):
        self.text = text
        self.usage_metadata = None


class _ScriptedModels:
    def __init__(self, generate_script, embed_script):
        self._generate_script = list(generate_script)
        self._embed_script = list(embed_script)
        self.generate_attempts = 0
        self.embed_attempts = 0

    def generate_content(self, model=None, contents=None, **kwargs):
        if self.generate_attempts >= len(self._generate_script):
            raise RuntimeError("generate_content script exhausted")
        outcome = self._generate_script[self.generate_attempts]
        self.generate_attempts += 1
        if isinstance(outcome, Exception):
            raise outcome
        return _GenerateResponse(outcome)

    def embed_content(self, model=None, contents=None, config=None, **kwargs):
        if self.embed_attempts >= len(self._embed_script):
            raise RuntimeError("embed_content script exhausted")
        outcome = self._embed_script[self.embed_attempts]
        self.embed_attempts += 1
        if isinstance(outcome, Exception):
            raise outcome
        return _EmbedResponse(outcome)


class _ScriptedClient:
    def __init__(self, generate_script, embed_script):
        self.models = _ScriptedModels(generate_script, embed_script)


def _parse_outcome(token):
    if token == "timeout":
        return TimeoutError("timed out")
    if token == "200":
        return "hello world"
    if token == "embed-ok":
        return [0.1, 0.2, 0.3]
    if token == "400":
        return _InjectedAPIError(400, "INVALID_ARGUMENT", "bad request")
    raise ValueError(f"unknown scripted token: {token}")


def _parse_script(spec):
    tokens = [token.strip() for token in spec.split(",") if token.strip()]
    return [_parse_outcome(token) for token in tokens]


def make_client(api_key=None):
    generate_spec = os.environ.get("MMRAG_TEST_GENERATE_SCRIPT", "200")
    embed_spec = os.environ.get("MMRAG_TEST_EMBED_SCRIPT", "embed-ok")
    return _ScriptedClient(_parse_script(generate_spec), _parse_script(embed_spec))


def _get_scripted_client(monkeypatch, generate_spec, embed_spec):
    monkeypatch.setenv("MMRAG_GEMINI_CLIENT_FACTORY", "_test_clients.test_timeout_hardening:make_client")
    monkeypatch.setenv("MMRAG_TEST_GENERATE_SCRIPT", generate_spec)
    monkeypatch.setenv("MMRAG_TEST_EMBED_SCRIPT", embed_spec)
    return mmrag.get_genai_client("fake-key")


def test_timeout_paths_are_bounded_and_return_control(monkeypatch):
    monkeypatch.setattr(mmrag.time, "sleep", lambda _: None)

    generate_client = _get_scripted_client(monkeypatch, "timeout,timeout,timeout", "embed-ok")
    generate_raised = None
    try:
        mmrag._retry_generate_content(
            generate_client,
            model="x",
            contents=["x"],
            backoffs=(0, 0, 0),
        )
    except Exception as exc:
        generate_raised = exc

    embed_client = _get_scripted_client(monkeypatch, "200", "timeout,timeout,timeout")
    embed_raised = None
    try:
        mmrag.embed_content(embed_client, {}, "chunk")
    except Exception as exc:
        embed_raised = exc

    assert isinstance(generate_raised, TimeoutError)
    assert isinstance(embed_raised, TimeoutError)
    assert generate_client.models.generate_attempts == 3
    assert embed_client.models.embed_attempts == 3


def test_transient_timeout_then_success(monkeypatch):
    monkeypatch.setattr(mmrag.time, "sleep", lambda _: None)

    generate_client = _get_scripted_client(monkeypatch, "timeout,200", "embed-ok")
    generate_response = mmrag._retry_generate_content(
        generate_client,
        model="x",
        contents=["x"],
        backoffs=(0, 0, 0),
    )

    tracker_calls = []
    mmrag._tracker = SimpleNamespace(track_embedding=lambda content: tracker_calls.append(content))
    embed_client = _get_scripted_client(monkeypatch, "200", "timeout,embed-ok")
    embed_values = mmrag.embed_content(embed_client, {}, "chunk")
    mmrag._tracker = None

    assert generate_response.text == "hello world"
    assert generate_client.models.generate_attempts == 2
    assert embed_values == [0.1, 0.2, 0.3]
    assert embed_client.models.embed_attempts == 2
    assert tracker_calls == ["chunk"]


def test_non_transient_api_error_still_fast_fails(monkeypatch):
    monkeypatch.setattr(mmrag.time, "sleep", lambda _: None)

    generate_client = _get_scripted_client(monkeypatch, "400,200", "embed-ok")
    generate_raised = None
    try:
        mmrag._retry_generate_content(
            generate_client,
            model="x",
            contents=["x"],
            backoffs=(0, 0, 0),
        )
    except Exception as exc:
        generate_raised = exc

    mmrag._tracker = SimpleNamespace(track_embedding=lambda content: (_ for _ in ()).throw(AssertionError("tracker should not run")))
    embed_client = _get_scripted_client(monkeypatch, "200", "400,embed-ok")
    embed_raised = None
    try:
        mmrag.embed_content(embed_client, {}, "chunk")
    except Exception as exc:
        embed_raised = exc
    finally:
        mmrag._tracker = None

    assert isinstance(generate_raised, _InjectedAPIError)
    assert isinstance(embed_raised, _InjectedAPIError)
    assert generate_raised.code == 400
    assert embed_raised.code == 400
    assert generate_client.models.generate_attempts == 1
    assert embed_client.models.embed_attempts == 1
