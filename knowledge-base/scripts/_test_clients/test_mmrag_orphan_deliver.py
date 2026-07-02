import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace


HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag


class FakeCollection:
    def __init__(self, name, count):
        self.name = name
        self._count = count

    def count(self):
        return self._count


class FakeChroma:
    def __init__(self, collections):
        self.collections = dict(collections)
        self.deleted = []

    def list_collections(self):
        return [SimpleNamespace(name=name) for name in self.collections]

    def get_collection(self, name):
        return self.collections[name]

    def delete_collection(self, name):
        self.deleted.append(name)
        self.collections.pop(name, None)


def _patch_deliver_env(monkeypatch):
    monkeypatch.setattr(mmrag, "load_config", lambda: {})
    monkeypatch.setattr(mmrag, "get_api_key", lambda config: "key")
    monkeypatch.setattr(mmrag, "get_genai_client", lambda api_key: object())
    monkeypatch.setattr(mmrag, "get_chroma_collection", lambda name: object())


def test_reap_orphans_deletes_only_empty_agent_collections():
    chroma = FakeChroma({
        "agent-test-x": FakeCollection("agent-test-x", 0),
        "agent-test-y": FakeCollection("agent-test-y", 3),
        "shared-test": FakeCollection("shared-test", 0),
    })

    report = mmrag._reap_orphan_collections(chroma, dry_run=False, agent_names={"test-y"})

    assert report["orphans_found"] == 1
    assert report["orphans_reaped"] == 1
    assert chroma.deleted == ["agent-test-x"]
    assert "agent-test-y" in chroma.collections
    assert "shared-test" in chroma.collections


def test_reap_orphans_is_idempotent():
    chroma = FakeChroma({
        "agent-test-x": FakeCollection("agent-test-x", 0),
    })

    first = mmrag._reap_orphan_collections(chroma, dry_run=False, agent_names=set())
    second = mmrag._reap_orphan_collections(chroma, dry_run=False, agent_names=set())

    assert first["orphans_reaped"] == 1
    assert second["orphans_reaped"] == 0


def test_deliver_path_mode_returns_link_object(tmp_path, monkeypatch, capsys):
    source_file = tmp_path / "logan.md"
    source_file.write_text("# Logan\n", encoding="utf-8")

    _patch_deliver_env(monkeypatch)
    monkeypatch.setattr(mmrag, "_deliver_to_dashboard", lambda file_path: "https://briefs.example/briefs/logan")

    mmrag.cmd_deliver(SimpleNamespace(
        target=str(source_file),
        to="dashboard",
        collection="shared-clearworksai",
        top_docs=3,
        yes=False,
        json=True,
    ))

    payload = json.loads(capsys.readouterr().out)
    assert payload["delivered_path"] == str(source_file.resolve())
    assert payload["destination"] == "dashboard"
    assert payload["link"] == "https://briefs.example/briefs/logan"


def test_deliver_query_mode_requires_yes_when_ambiguous(tmp_path, monkeypatch, capsys):
    source_file = tmp_path / "logan.md"
    source_file.write_text("# Logan\n", encoding="utf-8")

    _patch_deliver_env(monkeypatch)
    monkeypatch.setattr(
        mmrag,
        "_resolve_delivery_source",
        lambda client, config, collection, target, top_docs: (
            source_file.resolve(),
            {"mode": "query", "documents": [], "warning": "ambiguous"},
        ),
    )

    mmrag.cmd_deliver(SimpleNamespace(
        target="logan currie",
        to="dashboard",
        collection="shared-clearworksai",
        top_docs=3,
        yes=False,
        json=False,
    ))

    output = capsys.readouterr().out
    assert "Re-run with --yes" in output
