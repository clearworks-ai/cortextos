#!/usr/bin/env python3
"""Run one auditable Gemini API baseline with Google Search grounding."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import socket
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_FALLBACK_MODEL = "gemini-3.8-flash"
TRANSIENT_HTTP_STATUSES = {429, 500, 502, 503, 504}
PROMPT_ID = re.compile(r"^[LCUPXTI]\d{2}$")
SECRET_PATTERNS = (
    re.compile(r"(?i)(x-goog-api-key\s*[:=]\s*)[^\s,}\]\[]+"),
    re.compile(r"(?i)(gemini_api_key\s*[:=]\s*)[^\s,}\]\[]+"),
    re.compile(r"(?i)([?&]key=)[^&\s]+"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_prompts(path: Path) -> list[dict[str, str]]:
    """Load the frozen Markdown prompt table without altering prompt text."""
    prompts: list[dict[str, str]] = []
    in_core = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line == "## Frozen weekly core":
            in_core = True
            continue
        if in_core and line.startswith("## "):
            break
        if not in_core or not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.split("|")[1:-1]]
        if len(cells) != 3 or not PROMPT_ID.fullmatch(cells[0]):
            continue
        prompts.append({"prompt_id": cells[0], "cluster": cells[1], "prompt_text": cells[2]})

    ids = [prompt["prompt_id"] for prompt in prompts]
    if len(prompts) != 25 or len(ids) != len(set(ids)):
        raise ValueError(f"expected 25 unique frozen prompts, found {len(prompts)}")
    return prompts


def redact_secrets(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    """Recursively redact known values and common API-key serializations."""
    if isinstance(value, dict):
        return {key: redact_secrets(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_secrets(item, secrets) for item in value]
    if not isinstance(value, str):
        return value

    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(r"\1[REDACTED]", redacted)
    return redacted


def write_json(path: Path, value: Any, secrets: tuple[str, ...] = ()) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_value = redact_secrets(value, secrets)
    rendered = json.dumps(safe_value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(rendered)
        temporary_path = Path(handle.name)
    os.replace(temporary_path, path)


def request_body(prompt_text: str) -> dict[str, Any]:
    return {
        "contents": [{"parts": [{"text": prompt_text}]}],
        "tools": [{"google_search": {}}],
    }


def parse_payload(data: bytes) -> Any:
    text = data.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"unparsed_body": text}


def one_request(
    *, prompt_text: str, model: str, api_key: str, timeout: float
) -> dict[str, Any]:
    body = request_body(prompt_text)
    request = Request(
        f"{API_ROOT}/{model}:generateContent",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "clearworks-aec-authority-baseline/1.0",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    started_at = utc_now()
    start = time.monotonic()
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = parse_payload(response.read())
            return {
                "timestamp": started_at,
                "duration_ms": round((time.monotonic() - start) * 1000),
                "model": model,
                "http_status": response.status,
                "technical_status": "success",
                "response": payload,
            }
    except HTTPError as error:
        payload = parse_payload(error.read())
        return {
            "timestamp": started_at,
            "duration_ms": round((time.monotonic() - start) * 1000),
            "model": model,
            "http_status": error.code,
            "technical_status": "http_error",
            "response": payload,
        }
    except (URLError, TimeoutError, socket.timeout) as error:
        return {
            "timestamp": started_at,
            "duration_ms": round((time.monotonic() - start) * 1000),
            "model": model,
            "http_status": None,
            "technical_status": "network_error",
            "error": f"{type(error).__name__}: {error}",
        }


def error_message(attempt: dict[str, Any]) -> str:
    response = attempt.get("response")
    if isinstance(response, dict):
        error = response.get("error")
        if isinstance(error, dict):
            return str(error.get("message", ""))
    return str(attempt.get("error", ""))


def is_model_rejection(attempt: dict[str, Any]) -> bool:
    message = error_message(attempt).lower()
    return attempt.get("http_status") in {400, 404} and (
        "model" in message
        and any(term in message for term in ("not found", "not supported", "unavailable"))
    )


def call_with_retries(
    *,
    prompt_text: str,
    model: str,
    api_key: str,
    timeout: float,
    max_retries: int,
    retry_base_seconds: float,
) -> list[dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    for retry in range(max_retries + 1):
        attempt = one_request(
            prompt_text=prompt_text, model=model, api_key=api_key, timeout=timeout
        )
        attempts.append(attempt)
        transient = (
            attempt["technical_status"] == "network_error"
            or attempt.get("http_status") in TRANSIENT_HTTP_STATUSES
        )
        if not transient or retry == max_retries:
            break
        time.sleep(retry_base_seconds * (2**retry))
    return attempts


def response_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    for candidate in payload.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if isinstance(part.get("text"), str):
                parts.append(part["text"])
    return "\n".join(parts)


def grounding_metadata(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    candidates = payload.get("candidates", [])
    if not candidates:
        return {}
    metadata = candidates[0].get("groundingMetadata", {})
    return metadata if isinstance(metadata, dict) else {}


def citation_domain(uri: str, title: str) -> str:
    hostname = (urlparse(uri).hostname or "").lower().removeprefix("www.")
    title_candidate = title.lower().strip().removeprefix("www.")
    if hostname.endswith("google.com") and re.fullmatch(
        r"[a-z0-9.-]+\.[a-z]{2,}", title_candidate
    ):
        return title_candidate
    return hostname


def extract_citations(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    chunks = metadata.get("groundingChunks", [])
    supports = metadata.get("groundingSupports", [])
    segments_by_index: dict[int, list[dict[str, Any]]] = {}
    for support in supports:
        segment = support.get("segment", {})
        for index in support.get("groundingChunkIndices", []):
            segments_by_index.setdefault(index, []).append(segment)

    citations: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        web = chunk.get("web", {}) if isinstance(chunk, dict) else {}
        uri = web.get("uri")
        if not isinstance(uri, str) or not uri:
            continue
        title = web.get("title", "")
        citations.append(
            {
                "citation_index": index,
                "title": title,
                "source_url": uri,
                "domain": citation_domain(uri, title),
                "support_segments": segments_by_index.get(index, []),
            }
        )
    return citations


def classify_final_attempt(attempt: dict[str, Any]) -> str:
    if attempt["technical_status"] != "success":
        return attempt["technical_status"]
    payload = attempt.get("response", {})
    if not isinstance(payload, dict):
        return "invalid_response"
    if payload.get("promptFeedback", {}).get("blockReason"):
        return "blocked"
    if not payload.get("candidates"):
        return "invalid_response"
    return "success"


def usage_metadata(payload: Any) -> dict[str, int]:
    if not isinstance(payload, dict):
        return {}
    usage = payload.get("usageMetadata", {})
    return {
        key: value
        for key, value in usage.items()
        if isinstance(value, int) and not isinstance(value, bool)
    }


def summarize_totals(records: list[dict[str, Any]], http_requests: int) -> dict[str, Any]:
    status_counts: dict[str, int] = {}
    usage_counts: dict[str, int] = {}
    grounded_successes = 0
    for record in records:
        status = record["technical_status"]
        status_counts[status] = status_counts.get(status, 0) + 1
        if status == "success" and (record["grounding_queries"] or record["citations"]):
            grounded_successes += 1
        for key, value in record["usage_metadata"].items():
            usage_counts[key] = usage_counts.get(key, 0) + value
    return {
        "prompt_records": len(records),
        "http_requests": http_requests,
        "retries_or_model_fallback_requests": http_requests - len(records),
        "status_counts": status_counts,
        "grounded_successes": grounded_successes,
        "usage_counts": usage_counts,
    }


def validate_manifest(manifest: dict[str, Any]) -> None:
    required = {
        "schema_version",
        "run_id",
        "prompt_set_version",
        "model_requested",
        "model_used",
        "started_at",
        "prompts",
        "totals",
    }
    missing = required - manifest.keys()
    if missing:
        raise ValueError(f"manifest missing fields: {sorted(missing)}")
    prompts = manifest["prompts"]
    if not isinstance(prompts, list):
        raise ValueError("manifest prompts must be a list")
    ids = [record.get("prompt_id") for record in prompts]
    if len(ids) != len(set(ids)):
        raise ValueError("manifest prompt IDs must be unique")
    per_prompt_required = {
        "prompt_id",
        "prompt_text",
        "cluster",
        "run_timestamp",
        "technical_status",
        "grounding_queries",
        "citations",
        "raw_response_path",
    }
    for record in prompts:
        absent = per_prompt_required - record.keys()
        if absent:
            raise ValueError(
                f"prompt {record.get('prompt_id')} missing fields: {sorted(absent)}"
            )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-file", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--prompt-set-version", default="aec-authority-core-v1")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--fallback-model", default=DEFAULT_FALLBACK_MODEL)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--retry-base-seconds", type=float, default=10.0)
    parser.add_argument("--inter-prompt-delay", type=float, default=1.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.run_id):
        raise SystemExit("--run-id may contain only letters, numbers, dot, underscore, hyphen")
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is not set")

    prompts = load_prompts(args.prompt_file)
    randomizer = random.Random(args.seed)
    randomizer.shuffle(prompts)
    output_dir = args.output_dir / args.run_id
    raw_dir = output_dir / "raw"
    manifest_path = output_dir / "manifest.json"
    source_text = args.prompt_file.read_text(encoding="utf-8")
    started_at = utc_now()
    active_model = args.model
    model_change: dict[str, Any] | None = None
    records: list[dict[str, Any]] = []
    http_requests = 0

    manifest: dict[str, Any] = {
        "schema_version": "gemini-grounded-baseline-manifest/v1",
        "run_id": args.run_id,
        "protocol_version": "aec-authority-baseline-v1",
        "prompt_set_version": args.prompt_set_version,
        "prompt_source": str(args.prompt_file),
        "prompt_source_sha256": sha256_text(source_text),
        "provider": "Google",
        "platform": "Gemini API",
        "surface": "Gemini API with Google Search grounding",
        "ui_or_api": "API",
        "endpoint": API_ROOT + "/{model}:generateContent",
        "model_requested": args.model,
        "model_used": active_model,
        "model_change": None,
        "search_mode": "google_search",
        "started_at": started_at,
        "finished_at": None,
        "repetition": 1,
        "randomization_seed": args.seed,
        "request_order": [prompt["prompt_id"] for prompt in prompts],
        "locale": "not_provided_to_api",
        "device_location_state": "not_provided_to_api",
        "logged_in": False,
        "memory_state": "fresh_independent_request_per_prompt",
        "personalization_state": "none_provided",
        "connected_apps_state": "none",
        "prompts": records,
        "totals": summarize_totals(records, http_requests),
    }
    write_json(manifest_path, manifest, (api_key,))

    for position, prompt in enumerate(prompts, start=1):
        attempts = call_with_retries(
            prompt_text=prompt["prompt_text"],
            model=active_model,
            api_key=api_key,
            timeout=args.timeout,
            max_retries=args.max_retries,
            retry_base_seconds=args.retry_base_seconds,
        )
        http_requests += len(attempts)

        if (
            active_model == args.model
            and model_change is None
            and is_model_rejection(attempts[-1])
        ):
            rejected = attempts[-1]
            model_change = {
                "from": args.model,
                "to": args.fallback_model,
                "at_prompt_id": prompt["prompt_id"],
                "timestamp": utc_now(),
                "reason": error_message(rejected),
                "rejected_http_status": rejected.get("http_status"),
            }
            active_model = args.fallback_model
            fallback_attempts = call_with_retries(
                prompt_text=prompt["prompt_text"],
                model=active_model,
                api_key=api_key,
                timeout=args.timeout,
                max_retries=args.max_retries,
                retry_base_seconds=args.retry_base_seconds,
            )
            attempts.extend(fallback_attempts)
            http_requests += len(fallback_attempts)

        final_attempt = attempts[-1]
        payload = final_attempt.get("response")
        metadata = grounding_metadata(payload)
        status = classify_final_attempt(final_attempt)
        raw_relative = f"raw/{prompt['prompt_id']}.json"
        receipt = {
            "schema_version": "gemini-grounded-raw-receipt/v1",
            "run_id": args.run_id,
            "prompt_id": prompt["prompt_id"],
            "request": {
                "model": final_attempt["model"],
                "body": request_body(prompt["prompt_text"]),
            },
            "attempts": attempts,
            "final_response": payload,
        }
        write_json(output_dir / raw_relative, receipt, (api_key,))

        record = {
            "run_id": args.run_id,
            "prompt_set_version": args.prompt_set_version,
            "prompt_id": prompt["prompt_id"],
            "prompt_text": prompt["prompt_text"],
            "prompt_text_sha256": sha256_text(prompt["prompt_text"]),
            "cluster": prompt["cluster"],
            "model_label": final_attempt["model"],
            "run_timestamp": final_attempt["timestamp"],
            "repetition": 1,
            "request_order_position": position,
            "technical_status": status,
            "http_status": final_attempt.get("http_status"),
            "attempt_count": len(attempts),
            "response_text": response_text(payload),
            "grounding_queries": metadata.get("webSearchQueries", []),
            "citations": extract_citations(metadata),
            "usage_metadata": usage_metadata(payload),
            "error": None if status == "success" else error_message(final_attempt),
            "raw_response_path": raw_relative,
        }
        records.append(record)
        manifest["model_used"] = active_model
        manifest["model_change"] = model_change
        manifest["totals"] = summarize_totals(records, http_requests)
        validate_manifest(manifest)
        write_json(manifest_path, manifest, (api_key,))
        print(
            f"[{position:02d}/25] {prompt['prompt_id']} {status} "
            f"model={final_attempt['model']} citations={len(record['citations'])}",
            flush=True,
        )
        if position < len(prompts):
            time.sleep(args.inter_prompt_delay)

    manifest["finished_at"] = utc_now()
    manifest["totals"] = summarize_totals(records, http_requests)
    validate_manifest(manifest)
    write_json(manifest_path, manifest, (api_key,))
    print(f"manifest={manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
