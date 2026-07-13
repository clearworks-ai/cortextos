from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

try:
    from . import pulse_registry
except ImportError:
    import pulse_registry  # type: ignore[no-redef]


NOTEBOOKLM_BIN = os.environ.get("NOTEBOOKLM_BIN", "/tmp/whisper-venv/bin/notebooklm")
QUALITY_ORDER = {"high": 0, "medium": 1, "emerging": 2, "archival": 3}


class NlmError(RuntimeError):
    def __init__(self, rc: int, stderr: str):
        super().__init__(stderr.strip() or f"NotebookLM command failed with rc={rc}")
        self.rc = rc
        self.stderr = stderr.strip()


class CapError(RuntimeError):
    pass


def nlm(*args: str, timeout: int = 180) -> dict:
    result = subprocess.run(
        [NOTEBOOKLM_BIN, *args, "--json"],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise NlmError(result.returncode, result.stderr)
    return json.loads(result.stdout or "{}")


def nlm_raw(*args: str, timeout: int = 660) -> int:
    result = subprocess.run(
        [NOTEBOOKLM_BIN, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.returncode


def preflight() -> None:
    if not os.path.exists(NOTEBOOKLM_BIN):
        raise RuntimeError(
            f"NotebookLM CLI not found at {NOTEBOOKLM_BIN}. "
            "pip install notebooklm-py into a durable venv; /tmp/whisper-venv is wiped on reboot."
        )
    result = subprocess.run(
        [NOTEBOOKLM_BIN, "status"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown auth failure"
        raise RuntimeError(f"NotebookLM auth check failed ({detail}); run notebooklm login")


def create_notebook(title: str) -> str:
    payload = nlm("create", title)
    notebook = payload.get("notebook") if isinstance(payload.get("notebook"), dict) else {}
    notebook_id = notebook.get("id") or payload.get("id") or payload.get("notebook_id")
    if not isinstance(notebook_id, str) or not notebook_id:
        raise ValueError("NotebookLM create response missing notebook id")
    return notebook_id


def _normalize_title(title: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(title).lower()))


def _normalize_url(url: str) -> str:
    return str(url or "").strip().rstrip("/").lower()


def existing_source_urls(notebook_id: str) -> dict[str, dict[str, str]]:
    payload = nlm("source", "list", "--notebook", notebook_id)
    if isinstance(payload, dict):
        sources = payload.get("sources") or payload.get("items") or []
    elif isinstance(payload, list):
        sources = payload
    else:
        sources = []

    by_id: dict[str, str] = {}
    by_url: dict[str, str] = {}
    for source in sources:
        if not isinstance(source, dict):
            continue
        source_id = source.get("id") or source.get("source_id")
        url = source.get("url")
        if isinstance(source_id, str) and source_id:
            by_id[source_id] = source.get("title") or source.get("source_name") or ""
            if isinstance(url, str) and url.strip():
                by_url[_normalize_url(url)] = source_id
    return {"by_id": by_id, "by_url": by_url}


def pick_seedable(registry: dict, limit: int) -> list[dict]:
    already_seeded = sum(
        1 for source in registry.get("sources", []) if source.get("notebooklm_source_id")
    )
    if already_seeded >= limit:
        raise CapError(
            f"Notebook source cap refusal: {already_seeded} sources already seeded and limit is {limit}"
        )

    seedable = []
    for index, source in enumerate(registry.get("sources", [])):
        if not source.get("active", True):
            continue
        if source.get("notebooklm_source_id"):
            continue
        url = str(source.get("url") or "")
        if url.startswith("notebooklm://"):
            continue
        seedable.append((QUALITY_ORDER.get(source.get("tags", {}).get("quality"), 99), index, source))

    ordered = [source for _, _, source in sorted(seedable, key=lambda item: (item[0], item[1]))]
    remaining = limit - already_seeded
    if len(ordered) > remaining:
        cut = ordered[remaining:]
        print(
            "NotebookLM cap truncated sources: "
            + ", ".join(source.get("source_name", "unknown") for source in cut),
            file=sys.stderr,
        )
        ordered = ordered[:remaining]
    return ordered


def _add_source_with_retry(url: str, notebook_id: str) -> dict:
    try:
        return nlm("source", "add", url, "--notebook", notebook_id)
    except NlmError as exc:
        if "No result found for RPC ID" not in exc.stderr:
            raise
        time.sleep(60)
        return nlm("source", "add", url, "--notebook", notebook_id)


def seed(registry: dict, notebook_id: str, limit: int, dry_run: bool) -> tuple[int, int]:
    picked = pick_seedable(registry, limit)
    if dry_run:
        print(
            json.dumps(
                {
                    "vertical": registry.get("vertical"),
                    "notebook_id": notebook_id,
                    "planned_sources": [source.get("source_name") for source in picked],
                },
                indent=2,
            )
        )
        return len(picked), 0

    existing = existing_source_urls(notebook_id)
    reconciled = False
    for source in registry.get("sources", []):
        current_id = source.get("notebooklm_source_id")
        if current_id and current_id in existing["by_id"]:
            continue
        url_match = existing["by_url"].get(_normalize_url(source.get("url", "")))
        if url_match and source.get("notebooklm_source_id") != url_match:
            source["notebooklm_source_id"] = url_match
            reconciled = True
    if reconciled:
        pulse_registry.save_registry(registry)

    picked = pick_seedable(registry, limit)
    succeeded = 0
    failed = 0
    for source in picked:
        try:
            payload = _add_source_with_retry(source["url"], notebook_id)
        except NlmError as exc:
            print(f"Failed to add {source['source_name']}: {exc.stderr}", file=sys.stderr)
            failed += 1
            continue

        nested_source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
        source_id = nested_source.get("id") or payload.get("source_id") or payload.get("id")
        if not isinstance(source_id, str) or not source_id:
            print(f"Failed to add {source['source_name']}: missing source_id", file=sys.stderr)
            failed += 1
            continue

        source["notebooklm_source_id"] = source_id
        pulse_registry.save_registry(registry)
        succeeded += 1

        wait_rc = nlm_raw("source", "wait", source_id, "-n", notebook_id, "--timeout", "600")
        if wait_rc == 2:
            print(
                f"NotebookLM source wait timed out for {source['source_name']}; processing continues server-side.",
                file=sys.stderr,
            )
        elif wait_rc != 0:
            print(
                f"NotebookLM source wait returned rc={wait_rc} for {source['source_name']}.",
                file=sys.stderr,
            )
    return succeeded, failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vertical", required=True)
    parser.add_argument("--notebook-id")
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--title")
    parser.add_argument("--limit", type=int, default=45)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    registry = pulse_registry.load_registry(args.vertical)
    notebook_id = args.notebook_id or registry.get("notebook_id")

    if args.dry_run:
        if args.create and not notebook_id:
            notebook_id = "pending-create"
        if not notebook_id:
            print(
                "Notebook id required: pass --notebook-id, store registry['notebook_id'], or use --create",
                file=sys.stderr,
            )
            return 2
        try:
            seed(registry, notebook_id, args.limit, True)
        except CapError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        return 0

    try:
        preflight()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if args.create:
        notebook_id = create_notebook(args.title or f"Research Pulse: {registry['display_name']}")
        registry["notebook_id"] = notebook_id
        pulse_registry.save_registry(registry)
    elif not notebook_id:
        print(
            "Notebook id required: pass --notebook-id, store registry['notebook_id'], or use --create",
            file=sys.stderr,
        )
        return 2
    elif registry.get("notebook_id") != notebook_id:
        registry["notebook_id"] = notebook_id
        pulse_registry.save_registry(registry)

    try:
        _, failed = seed(registry, notebook_id, args.limit, False)
    except CapError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
