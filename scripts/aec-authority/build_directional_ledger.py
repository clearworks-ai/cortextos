#!/usr/bin/env python3
"""Build a one-run entity/domain ledger from a Gemini baseline manifest."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--entity-review", required=True, type=Path)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    entity_review = load_json(args.entity_review)
    prompt_ids = {record["prompt_id"] for record in manifest["prompts"]}
    unknown_ids = set(entity_review) - prompt_ids
    if unknown_ids:
        raise SystemExit(f"entity review has unknown prompt IDs: {sorted(unknown_ids)}")

    entity_prompts: dict[str, set[str]] = defaultdict(set)
    for prompt_id, entities in entity_review.items():
        for entity in entities:
            entity_prompts[entity].add(prompt_id)

    domain_rows: dict[str, dict[str, Any]] = {}
    citation_records: list[dict[str, Any]] = []
    for record in manifest["prompts"]:
        for citation in record["citations"]:
            domain = citation.get("domain") or "unknown"
            citation_record = {
                "prompt_id": record["prompt_id"],
                "citation_index": citation["citation_index"],
                "domain": domain,
                "title": citation.get("title", ""),
                "source_url": citation["source_url"],
            }
            citation_records.append(citation_record)
            row = domain_rows.setdefault(
                domain,
                {"domain": domain, "prompt_ids": set(), "citation_count": 0, "source_urls": set()},
            )
            row["prompt_ids"].add(record["prompt_id"])
            row["citation_count"] += 1
            row["source_urls"].add(citation["source_url"])

    entities = [
        {"entity": entity, "prompt_ids": sorted(ids), "mentioning_prompt_count": len(ids)}
        for entity, ids in entity_prompts.items()
    ]
    entities.sort(key=lambda row: (-row["mentioning_prompt_count"], row["entity"].lower()))
    domains = [
        {
            "domain": row["domain"],
            "prompt_ids": sorted(row["prompt_ids"]),
            "citation_count": row["citation_count"],
            "source_urls": sorted(row["source_urls"]),
        }
        for row in domain_rows.values()
    ]
    domains.sort(key=lambda row: (-row["citation_count"], row["domain"]))

    clearworks_prompt_ids = sorted(
        record["prompt_id"]
        for record in manifest["prompts"]
        if "clearworks" in record["response_text"].lower()
        or any(
            "clearworks" in (
                citation.get("domain", "")
                + citation.get("title", "")
                + citation.get("source_url", "")
            ).lower()
            for citation in record["citations"]
        )
    )
    ledger = {
        "schema_version": "gemini-one-run-directional-ledger/v1",
        "generated_at": utc_now(),
        "run_id": manifest["run_id"],
        "label": "ONE-RUN DIRECTIONAL — NOT A VISIBILITY SCORE",
        "limitations": [
            "One repetition cannot establish visibility rate, stability, or comparative performance.",
            "Entities are manually reviewed strings from the returned answer text; they are not identity-resolved or independently verified.",
            "Citation URLs are preserved exactly as returned by the Gemini API and may be Google grounding redirect URLs.",
        ],
        "clearworks_exact_string_prompt_ids": clearworks_prompt_ids,
        "entity_mentions": entities,
        "cited_domains": domains,
        "citations": sorted(
            citation_records, key=lambda row: (row["prompt_id"], row["citation_index"])
        ),
    }

    output_json = args.manifest.parent / "returned-entity-domain-ledger.json"
    output_md = args.manifest.parent / "returned-entity-domain-ledger.md"
    output_json.write_text(
        json.dumps(ledger, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    lines = [
        "# Gemini returned-entity and cited-domain ledger",
        "",
        "> **ONE-RUN DIRECTIONAL — NOT A VISIBILITY SCORE.** This is a first-pass inspection of one repetition. It cannot establish rate, stability, or comparative performance.",
        "",
        f"- Run ID: `{manifest['run_id']}`",
        f"- Model: `{manifest['model_used']}`",
        f"- Successful prompts: {manifest['totals']['status_counts'].get('success', 0)}/25",
        f"- Clearworks exact-string appearances: {len(clearworks_prompt_ids)} prompts ({', '.join(clearworks_prompt_ids) or 'none'})",
        f"- Citation records: {len(citation_records)}",
        "- Source URL note: the JSON ledger preserves every API-returned source URL with its exact prompt ID and citation index; some are Google grounding redirect URLs.",
        "",
        "## Returned entity strings",
        "",
        "Manually reviewed from the answer text. Names are not identity-resolved or independently verified.",
        "",
        "| Entity string | Exact prompt IDs | Prompt count |",
        "|---|---|---:|",
    ]
    for row in entities:
        escaped = row["entity"].replace("|", "\\|")
        lines.append(
            f"| {escaped} | {', '.join(row['prompt_ids'])} | {row['mentioning_prompt_count']} |"
        )

    lines.extend(
        [
            "",
            "## Cited domains",
            "",
            "| Domain | Exact prompt IDs | Citation records | API-returned source URLs |",
            "|---|---|---:|---|",
        ]
    )
    for row in domains:
        urls = "<br>".join(f"<{url}>" for url in row["source_urls"])
        lines.append(
            f"| {row['domain']} | {', '.join(row['prompt_ids'])} | {row['citation_count']} | {urls} |"
        )
    lines.extend(
        [
            "",
            "## Interpretation boundary",
            "",
            "This ledger is reconnaissance from one API run. Do not convert mention counts, domain counts, or the absence of Clearworks into a visibility score. The frozen protocol requires repeated runs before rate or stability claims.",
        ]
    )
    output_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(output_json)
    print(output_md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
