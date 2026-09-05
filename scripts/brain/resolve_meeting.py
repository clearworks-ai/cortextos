#!/usr/bin/env python3
"""FR-003: validate extraction, quote-gate, resolve one home. No LLM."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from atomic import atomic_write
from extract_meeting import validate_extraction
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, org_brain_root

FREE_MAIL = {
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
}
TWO_PART = {
    "co.uk",
    "org.uk",
    "ac.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "com.br",
    "co.jp",
    "co.in",
    "com.mx",
}
OPEN_STATES = {"scoping", "active", "paused"}
FORWARD = {
    "scoping": "active",
    "active": "delivered",
    "delivered": "accepted",
    "accepted": "adopted",
    "adopted": "closed",
}
ALIASES_REL = Path("orgs/clearworksai/agents/crm-codex/crm/org-aliases.json")
CONTACTS_REL = Path("orgs/clearworksai/agents/crm-codex/crm/contacts.json")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_quote(text: str) -> str:
    t = text.replace("\u2018", "'").replace("\u2019", "'")
    t = t.replace("\u201c", '"').replace("\u201d", '"')
    t = t.replace("\u2013", "-").replace("\u2014", "-")
    t = " ".join(t.casefold().split())
    return t


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def registrable_label(domain: str) -> str:
    d = domain.lower().strip().strip(".")
    parts = d.split(".")
    if len(parts) < 2:
        return d
    last_two = ".".join(parts[-2:])
    if last_two in TWO_PART and len(parts) >= 3:
        return parts[-3]
    return parts[-2]


def _parse_node_block(text: str) -> dict[str, str]:
    if "## Node" not in text:
        return {}
    rest = text.split("## Node", 1)[1]
    nxt = rest.find("\n## ")
    block = rest if nxt < 0 else rest[:nxt]
    out: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        key = k.strip().lower()
        if key:
            out[key] = v.strip()
    return out


def _domains_from_text(text: str) -> list[str]:
    found: list[str] = []
    for line in text.splitlines():
        if re.match(r"^domains:", line, re.I):
            rest = line.split(":", 1)[1]
            found.extend(x.strip().lower() for x in rest.split(",") if x.strip())
    return found


def load_closed_sets(vault: Path) -> dict[str, Any]:
    brain = org_brain_root(vault)
    clients: dict[str, Path] = {}
    orgs: dict[str, Path] = {}
    nodes: dict[str, dict[str, Any]] = {}
    domain_to_slug: dict[str, str] = {}
    for folder, dest in (("clients", clients), ("orgs", orgs)):
        d = brain / folder
        if not d.is_dir():
            continue
        for path in d.glob("*.md"):
            if path.stem.startswith("_"):
                continue
            dest[path.stem] = path
            text = path.read_text(encoding="utf-8")
            for dom in _domains_from_text(text):
                domain_to_slug[registrable_label(dom)] = path.stem
                domain_to_slug[dom] = path.stem
    proj = brain / "projects"
    if proj.is_dir():
        for path in proj.glob("*.md"):
            if path.stem.startswith("_"):
                continue
            text = path.read_text(encoding="utf-8")
            node = _parse_node_block(text)
            nid = node.get("id") or path.stem
            aliases = [a.strip() for a in (node.get("aliases") or "").split(",") if a.strip()]
            nodes[nid] = {
                "path": path,
                "client": node.get("client") or "",
                "aliases": aliases,
                "delivery_state": (node.get("delivery_state") or "").strip(),
                "kind": node.get("kind") or "",
            }
            for dom in _domains_from_text(text):
                domain_to_slug[registrable_label(dom)] = node.get("client") or path.stem
    return {
        "clients": clients,
        "orgs": orgs,
        "nodes": nodes,
        "domain_to_slug": domain_to_slug,
        "brain": brain,
    }


def _load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def quote_grounded(quote: object, blob: str) -> bool:
    if not isinstance(quote, str):
        return False
    n = normalize_quote(quote)
    return bool(n) and n in blob


def quote_gate(extraction: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    blob = normalize_quote(
        " ".join(str(u.get("text") or "") for u in (source.get("text_units") or []) if isinstance(u, dict))
    )
    dropped = {"decisions": 0, "commitments": 0, "promotion": False, "promotion_reason": None}
    decisions = []
    for item in extraction.get("decisions") or []:
        if isinstance(item, dict) and quote_grounded(item.get("quote"), blob):
            decisions.append(item)
        else:
            dropped["decisions"] += 1
    commitments = []
    for item in extraction.get("commitments") or []:
        if isinstance(item, dict) and quote_grounded(item.get("quote"), blob):
            commitments.append(item)
        else:
            dropped["commitments"] += 1
    pds = extraction.get("proposed_delivery_state")
    if pds is not None:
        q = pds.get("quote") if isinstance(pds, dict) else None
        if not quote_grounded(q, blob):
            dropped["promotion"] = True
            dropped["promotion_reason"] = "ungrounded"
            pds = None
    validated = dict(extraction)
    validated["decisions"] = decisions
    validated["commitments"] = commitments
    validated["proposed_delivery_state"] = pds
    validated["dropped"] = dropped
    return validated


def _norm_title(title: str) -> str:
    return " ".join(title.casefold().split())


def _word_boundary_has(haystack: str, needle: str) -> bool:
    n = " ".join(needle.casefold().split())
    if not n:
        return False
    return re.search(r"(?<![a-z0-9])" + re.escape(n) + r"(?![a-z0-9])", haystack) is not None


def _external_participants(source: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for p in source.get("participants") or []:
        if not isinstance(p, dict):
            continue
        if p.get("notetaker"):
            continue
        side = p.get("side")
        spoke = bool(p.get("spoke"))
        if side == "theirs" or (side == "unknown" and spoke):
            out.append(p)
    return out


def resolve(
    source: dict[str, Any],
    closed: dict[str, Any],
    repo_root: Path,
    classification: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not (source.get("participants") or []) and not (source.get("text_units") or []):
        raise SystemExit(5)
    title = str(source.get("title") or "")
    ntitle = _norm_title(title)
    clients: dict[str, Path] = closed["clients"]
    nodes: dict[str, dict[str, Any]] = closed["nodes"]
    domain_to_slug: dict[str, str] = dict(closed["domain_to_slug"])
    aliases = _load_json(repo_root / ALIASES_REL, {})
    contacts = _load_json(repo_root / CONTACTS_REL, {"contacts": []})
    if isinstance(aliases, dict):
        for k, v in aliases.items():
            if "." in k:
                domain_to_slug[k.lower()] = str(v)
                domain_to_slug[registrable_label(k)] = str(v)
    contact_rows = contacts.get("contacts") if isinstance(contacts, dict) else []
    if not isinstance(contact_rows, list):
        contact_rows = []
    for row in contact_rows:
        if not isinstance(row, dict):
            continue
        if not row.get("company"):
            continue
        slug = slugify(str(row.get("company") or ""))
        for em in row.get("emails") or []:
            if "@" in str(em):
                domain_to_slug[registrable_label(str(em).split("@", 1)[1])] = slug or domain_to_slug.get(
                    registrable_label(str(em).split("@", 1)[1]), ""
                )

    externals = _external_participants(source)
    client_cands: set[str] = set()
    org_cands: set[str] = set()
    unknown_labels: dict[str, tuple[str, str]] = {}
    unknown_counts: dict[str, int] = {}
    for p in externals:
        email = str(p.get("email") or "")
        if "@" not in email:
            continue
        domain = email.split("@", 1)[1].lower()
        if domain in FREE_MAIL:
            continue
        lab = registrable_label(domain)
        tld = domain.rsplit(".", 1)[-1]
        mapped = domain_to_slug.get(lab) or domain_to_slug.get(domain) or ""
        if mapped in clients:
            client_cands.add(mapped)
        if mapped in closed["orgs"]:
            org_cands.add(mapped)
        if lab in clients:
            client_cands.add(lab)
        if lab in closed["orgs"]:
            org_cands.add(lab)
        if lab not in clients and lab not in closed["orgs"] and mapped not in clients and mapped not in closed["orgs"]:
            unknown_labels[lab] = (tld, domain)
            unknown_counts[lab] = unknown_counts.get(lab, 0) + 1

    def _also(picked: str) -> list[str]:
        return sorted(c for c in (client_cands | org_cands) if c != picked)

    def _pick(cands: set[str]) -> str:
        counts: dict[str, int] = {}
        for p in externals:
            email = str(p.get("email") or "")
            if "@" not in email:
                continue
            domain = email.split("@", 1)[1].lower()
            if domain in FREE_MAIL:
                continue
            lab = registrable_label(domain)
            slug = domain_to_slug.get(lab) or domain_to_slug.get(domain) or (lab if lab in cands else "")
            if slug in cands:
                counts[slug] = counts.get(slug, 0) + 1
        return min(
            cands,
            key=lambda s: (
                -counts.get(s, 0),
                -sum(
                    1
                    for n in nodes.values()
                    if n.get("client") == s
                    and (n.get("delivery_state") in OPEN_STATES or n.get("delivery_state") == "active")
                ),
                s,
            ),
        )

    # (1) node id in title
    for nid, node in nodes.items():
        if re.search(r"(?<![a-z0-9])" + re.escape(nid.casefold()) + r"(?![a-z0-9])", ntitle):
            return _hit(node, nid, rule=1, clients=clients, client_cands=client_cands)
    # (2) alias in title, exactly one node, corroborated
    alias_hits: list[str] = []
    for nid, node in nodes.items():
        for alias in node["aliases"]:
            if _word_boundary_has(ntitle, alias):
                alias_hits.append(nid)
                break
    alias_hits = list(dict.fromkeys(alias_hits))
    if len(alias_hits) == 1:
        nid = alias_hits[0]
        node = nodes[nid]
        client = node["client"]
        no_ext = not externals
        if client in client_cands or no_ext:
            return _hit(node, nid, rule=2, clients=clients, client_cands=client_cands, corroborated=True)
    # (3) candidate client from non-free-mail domain
    if client_cands:
        picked = _pick(client_cands)
        hit = _client_hit(picked, nodes, clients, rule=3)
        hit["also_present"] = _also(picked)
        return hit
    # (4) contacts.json company
    rule4: set[str] = set()
    for p in externals:
        email = str(p.get("email") or "").lower()
        for row in contact_rows:
            emails = [str(e).lower() for e in (row.get("emails") or [])]
            if email not in emails:
                continue
            company = row.get("company")
            if not company:
                continue
            c = str(company)
            if "." in c and " " not in c:
                slug = registrable_label(c)
            else:
                slug = str(aliases.get(c) or slugify(c)) if isinstance(aliases, dict) else slugify(c)
            if slug in clients:
                rule4.add(slug)
            if slug in closed["orgs"]:
                org_cands.add(slug)
    if rule4:
        picked = _pick(rule4)
        hit = _client_hit(picked, nodes, clients, rule=4)
        hit["also_present"] = _also(picked)
        return hit
    # (5) free-mail → person org page
    for p in externals:
        email = str(p.get("email") or "")
        if "@" not in email:
            continue
        if email.split("@", 1)[1].lower() not in FREE_MAIL:
            continue
        for row in contact_rows:
            emails = [str(e).lower() for e in (row.get("emails") or [])]
            if email.lower() in emails:
                cid = str(row.get("id") or slugify(str(row.get("name") or email)))
                exists = cid in closed["orgs"]
                return {
                    "counterparty_slug": cid,
                    "kind": "person",
                    "relationship": "personal",
                    "home_path": f"orgs/{cid}.md",
                    "node": "none",
                    "created": None if exists else {"kind": "person", "slug": cid, "relationship": "personal"},
                    "confidence": 1.0,
                    "rule": 5,
                    "corroborated": False,
                    "also_present": [],
                }
    cls = classification if isinstance(classification, dict) else {}
    rel_ok = {"prospect", "vendor", "partner", "personal"}
    # (6) org candidate from domain/company, else create from non-free-mail label
    if org_cands:
        picked = _pick(org_cands)
        rel = str(cls.get("relationship") or "")
        return {
            "counterparty_slug": picked,
            "kind": "org",
            "relationship": rel if rel in rel_ok else "org",
            "home_path": f"orgs/{picked}.md",
            "node": "none",
            "created": None,
            "confidence": float(cls.get("confidence") or 0),
            "rule": 6,
            "corroborated": False,
            "also_present": _also(picked),
        }
    if unknown_labels:
        picked = min(unknown_labels, key=lambda s: (-unknown_counts.get(s, 0), s))
        tld, domain = unknown_labels[picked]
        slug = picked
        if slug in closed["orgs"]:
            existing = {d.lower() for d in _domains_from_text(closed["orgs"][slug].read_text(encoding="utf-8"))}
            if domain not in existing:
                slug = f"{picked}-{tld}"
        rel = str(cls.get("relationship") or "")
        if rel not in rel_ok:
            rel = "prospect"
        exists = slug in closed["orgs"]
        return {
            "counterparty_slug": slug,
            "kind": "org",
            "relationship": rel,
            "home_path": f"orgs/{slug}.md",
            "node": "none",
            "created": None if exists else {"kind": "org", "slug": slug, "relationship": rel},
            "confidence": float(cls.get("confidence") or 0),
            "rule": 6,
            "corroborated": False,
            "also_present": _also(slug),
        }
    # (7) only free-mail or email-less external participants
    hard_domain = False
    for p in externals:
        email = str(p.get("email") or "")
        if "@" in email and email.split("@", 1)[1].lower() not in FREE_MAIL:
            hard_domain = True
            break
    if externals and not hard_domain:
        first = externals[0]
        name = str(first.get("name") or "").strip()
        tokens = [t for t in re.split(r"\s+", name) if t]
        if len(tokens) >= 2:
            slug = slugify(name)
        else:
            occurred = str(source.get("occurred_at") or "")
            yyyymm = occurred[:7].replace("-", "") if len(occurred) >= 7 else "000000"
            slug = f"{slugify(name or str(first.get('email') or 'person'))}-{yyyymm}"
        exists = slug in closed["orgs"]
        return {
            "counterparty_slug": slug,
            "kind": "person",
            "relationship": "personal",
            "home_path": f"orgs/{slug}.md",
            "node": "none",
            "created": None if exists else {"kind": "person", "slug": slug, "relationship": "personal"},
            "confidence": float(cls.get("confidence") or 0),
            "rule": 7,
            "corroborated": False,
            "also_present": [],
        }
    # (8) no external participants
    if not externals:
        exists = "clearworks-internal" in closed["orgs"]
        return {
            "counterparty_slug": "clearworks-internal",
            "kind": "org",
            "relationship": "internal",
            "home_path": "orgs/clearworks-internal.md",
            "node": "none",
            "created": None
            if exists
            else {"kind": "org", "slug": "clearworks-internal", "relationship": "internal"},
            "confidence": 1.0,
            "rule": 8,
            "corroborated": False,
            "also_present": [],
        }
    return {}


def _hit(
    node: dict[str, Any],
    nid: str,
    *,
    rule: int,
    clients: dict[str, Path],
    client_cands: set[str],
    corroborated: bool = False,
) -> dict[str, Any]:
    return {
        "counterparty_slug": node["client"],
        "kind": "client",
        "relationship": "client",
        "home_path": f"projects/{nid}.md",
        "node": nid,
        "created": None,
        "confidence": 1.0,
        "rule": rule,
        "corroborated": corroborated,
        "also_present": sorted(client_cands),
    }


def _client_hit(slug: str, nodes: dict[str, dict[str, Any]], clients: dict[str, Path], rule: int) -> dict[str, Any]:
    open_nodes = [
        nid
        for nid, n in nodes.items()
        if n.get("client") == slug and (n.get("delivery_state") in OPEN_STATES or n.get("delivery_state") == "active")
    ]
    if len(open_nodes) == 1:
        nid = open_nodes[0]
        return _hit(nodes[nid], nid, rule=rule, clients=clients, client_cands={slug})
    return {
        "counterparty_slug": slug,
        "kind": "client",
        "relationship": "client",
        "home_path": f"clients/{slug}.md",
        "node": "none",
        "created": None,
        "confidence": 1.0,
        "rule": rule,
        "corroborated": False,
        "also_present": [],
    }


def _apply_promotion(validated: dict[str, Any], resolution: dict[str, Any], closed: dict[str, Any]) -> None:
    dropped = validated.setdefault("dropped", {})
    pds = validated.get("proposed_delivery_state")
    if not pds:
        return
    if resolution.get("node") in (None, "none"):
        validated["proposed_delivery_state"] = None
        dropped["promotion"] = True
        dropped["promotion_reason"] = "no-node"
        return
    node = closed["nodes"].get(resolution["node"], {})
    current = node.get("delivery_state") or ""
    nxt = FORWARD.get(current)
    if pds.get("state") != nxt:
        validated["proposed_delivery_state"] = None
        dropped["promotion"] = True
        dropped["promotion_reason"] = "non-forward"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    args = p.parse_args(argv)

    source_dir = Path(args.source)
    source_path = source_dir / "source.json"
    sha_path = source_dir / "source.sha256"
    extraction_path = source_dir / "extraction.json"
    if not source_path.is_file() or not extraction_path.is_file():
        print("missing source or extraction", file=sys.stderr)
        return 4
    raw = source_path.read_bytes()
    recomputed = _sha(raw)
    if sha_path.is_file() and sha_path.read_text(encoding="utf-8").strip() != recomputed:
        print("source.sha256 mismatch", file=sys.stderr)
        return 4
    try:
        source = json.loads(raw.decode())
        extraction = json.loads(extraction_path.read_text(encoding="utf-8"))
        validate_extraction(extraction, stamped=True)
    except (ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 4
    if extraction.get("inputSha") != recomputed:
        print("extraction.inputSha mismatch", file=sys.stderr)
        return 4
    n_part = len(source.get("participants") or [])
    for c in extraction.get("commitments") or []:
        idx = c.get("owner_participant") if isinstance(c, dict) else None
        if idx is not None and (not isinstance(idx, int) or idx < 0 or idx >= n_part):
            print("owner_participant out of range", file=sys.stderr)
            return 4

    try:
        closed = load_closed_sets(Path(args.vault))
        validated = quote_gate(extraction, source)
        resolution = resolve(source, closed, Path(args.repo_root), extraction.get("classification") if isinstance(extraction.get("classification"), dict) else None)
        if not resolution:
            print("unresolved-technical", file=sys.stderr)
            return 5
        _apply_promotion(validated, resolution, closed)
        resolution["dropped"] = validated.get("dropped") or {}
        resolution["deal_state"] = extraction.get("deal_state")
        resolution["meeting_type"] = extraction.get("meeting_type")
        atomic_write(source_dir / "validated.json", json.dumps(validated, sort_keys=True, indent=2).encode() + b"\n")
        atomic_write(source_dir / "resolution.json", json.dumps(resolution, sort_keys=True, indent=2).encode() + b"\n")
        print(f"home={resolution['home_path']} node={resolution['node']} rule={resolution['rule']}")
        return 0
    except SystemExit as exc:
        code = exc.code
        return int(code) if isinstance(code, int) else 5


if __name__ == "__main__":
    raise SystemExit(main())
