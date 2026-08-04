"""Unit tests for P1.0 file_output.py (outputs-router filing helper).

Covers, per the WAVE B adversarial review (04-review.md):
- happy path for each of the 7 --content-type choices
- frontmatter injection for .md/.txt, provenance sidecar for binary/media
- duplicate-destination refusal (no silent overwrite)
- missing --client refusal for --content-type=client
- 3 canonical path-traversal payloads rejected by the --client guard

All runs use a subprocess with HOME pointed at a pytest temp dir, so the
real ~/code/knowledge-sync is never touched. Targets CURRENT main behavior only.
"""

import os
import subprocess
import sys
import tempfile

import pytest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "file_output.py")

COMMON_ARGS = [
    "--agent", "larry",
    "--job", "test-coverage",
    "--source-task", "task_p1_0_test_coverage",
    "--date", "2026-08-03",
]


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test fixtures."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def fake_home(temp_dir):
    """A fake $HOME so KNOWLEDGE_SYNC_BASE resolves inside the temp dir."""
    os.makedirs(os.path.join(temp_dir, "code", "knowledge-sync"))
    return temp_dir


@pytest.fixture
def md_source(temp_dir):
    """A markdown source file to route."""
    path = os.path.join(temp_dir, "artifact.md")
    with open(path, "w") as f:
        f.write("# Test Artifact\n\nbody content\n")
    return path


def run_cli(fake_home, *extra_args):
    """Invoke file_output.py as a subprocess with HOME overridden."""
    env = {**os.environ, "HOME": fake_home}
    return subprocess.run(
        [sys.executable, SCRIPT, *extra_args, *COMMON_ARGS],
        capture_output=True, text=True, env=env,
    )


def ks(fake_home, *parts):
    """Path under the fake knowledge-sync tree."""
    return os.path.join(fake_home, "code", "knowledge-sync", *parts)


def _regular_files_under(root):
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            found.append(os.path.join(dirpath, name))
    return found


@pytest.mark.parametrize("content_type,rel_dest", [
    ("client",  "raw/areas/clearworks/testclient"),
    ("people",  "raw/resources/people"),
    ("org",     "raw/resources/organizations"),
    ("sop",     "raw/resources/reference/clearworks"),
    ("diagram", "raw/areas/clearworks/diagrams"),
    ("session", "raw/sessions"),
    ("media",   "raw/media"),
])
def test_happy_path_routes_to_mapped_dir(fake_home, md_source, content_type, rel_dest):
    extra = ["--content-type", content_type, "--source", md_source]
    if content_type == "client":
        extra += ["--client", "testclient"]
    result = run_cli(fake_home, *extra)

    assert result.returncode == 0, result.stderr
    expected = ks(fake_home, rel_dest, "artifact.md")
    assert result.stdout.strip() == expected
    assert os.path.exists(expected)

    with open(expected) as f:
        content = f.read()
    assert content.startswith("---\n")
    assert "agent: larry" in content
    assert "job: test-coverage" in content
    assert "source-task: task_p1_0_test_coverage" in content
    assert "date: 2026-08-03" in content
    assert "# Test Artifact" in content  # original body preserved

    assert os.path.exists(md_source)  # copy, not move


def test_txt_source_gets_frontmatter(fake_home, temp_dir):
    src = os.path.join(temp_dir, "notes.txt")
    with open(src, "w") as f:
        f.write("plain notes body\n")
    result = run_cli(fake_home, "--content-type", "sop", "--source", src)

    assert result.returncode == 0, result.stderr
    dest = ks(fake_home, "raw/resources/reference/clearworks", "notes.txt")
    assert os.path.exists(dest)
    with open(dest) as f:
        content = f.read()
    assert content.startswith("---\n")
    assert "agent: larry" in content
    assert "plain notes body" in content
    # txt takes the inject branch, NOT the sidecar branch
    assert not os.path.exists(dest + ".provenance.md")


def test_binary_source_creates_provenance_sidecar(fake_home, temp_dir):
    src = os.path.join(temp_dir, "image.png")
    payload = b"\x89PNG\r\n\x1a\n" + b"fake image data"
    with open(src, "wb") as f:
        f.write(payload)
    result = run_cli(fake_home, "--content-type", "media", "--source", src)

    assert result.returncode == 0, result.stderr
    dest = ks(fake_home, "raw/media", "image.png")
    assert os.path.exists(dest)
    with open(dest, "rb") as f:
        assert f.read() == payload  # byte-identical, no frontmatter in binary

    sidecar = dest + ".provenance.md"
    assert os.path.exists(sidecar)
    with open(sidecar) as f:
        prov = f.read()
    assert "agent: larry" in prov
    assert "source-task: task_p1_0_test_coverage" in prov
    assert "date: 2026-08-03" in prov


def test_duplicate_destination_refused(fake_home, md_source):
    first = run_cli(fake_home, "--content-type", "sop", "--source", md_source)
    assert first.returncode == 0, first.stderr
    dest = ks(fake_home, "raw/resources/reference/clearworks", "artifact.md")
    assert os.path.exists(dest)
    with open(dest) as f:
        after_first = f.read()

    second = run_cli(fake_home, "--content-type", "sop", "--source", md_source)
    assert second.returncode == 1
    assert "already exists" in second.stderr
    assert dest in second.stderr
    assert second.stdout.strip() == ""

    with open(dest) as f:
        assert f.read() == after_first  # no overwrite, no double frontmatter


def test_missing_client_for_client_type_refused(fake_home, md_source):
    result = run_cli(fake_home, "--content-type", "client", "--source", md_source)
    assert result.returncode == 1
    assert "Error: --client missing when --content-type=client" in result.stderr
    assert _regular_files_under(ks(fake_home, "raw", "areas", "clearworks")) == []


def test_traversal_dotdot_client_rejected(fake_home, md_source):
    result = run_cli(
        fake_home, "--content-type", "client", "--source", md_source,
        "--client", "../../../../../../etc",
    )
    assert result.returncode == 1
    assert "Error: --client cannot contain '..' path components" in result.stderr
    assert _regular_files_under(ks(fake_home)) == []


def test_traversal_absolute_client_rejected(fake_home, md_source):
    result = run_cli(
        fake_home, "--content-type", "client", "--source", md_source,
        "--client", "/etc/passwd-dir",
    )
    assert result.returncode == 1
    assert "Error: --client must be a relative path, not absolute" in result.stderr
    assert _regular_files_under(ks(fake_home)) == []


def test_traversal_embedded_dotdot_client_rejected(fake_home, md_source):
    result = run_cli(
        fake_home, "--content-type", "client", "--source", md_source,
        "--client", "foo/../../bar",
    )
    assert result.returncode == 1
    assert "Error: --client cannot contain '..' path components" in result.stderr
    assert _regular_files_under(ks(fake_home)) == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
