#!/usr/bin/env python3
"""FR-003: validate extraction, quote-gate, resolve one home. No LLM."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

from atomic import atomic_write
from extract_meeting import RELATIONSHIPS, validate_extraction
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, org_brain_root

FREE_MAIL = {
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "icloud.com",
    "me.com",
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
# Plan v2 (R4b Phase 1, 2026-09-08): P-1 internal roster and P-4 date-aware
# employer history. Both gitignored data files, never committed real names
# to the (public) repo (see the README in that directory) -- absent files
# load as empty and are a no-op, never an error.
INTERNAL_ROSTER_REL = Path("orgs/clearworksai/agents/crm-codex/crm/internal-roster.json")
EMPLOYER_HISTORY_REL = Path("orgs/clearworksai/agents/crm-codex/crm/employer-history.json")

# Plan v2 (R4b Phase 1) coordinator correction 2026-09-08: resolve() has no
# applied-state/receipt input (it takes only source, closed sets, repo_root,
# classification), so "already applied to production" cannot be inferred --
# it must be an explicit id allow-list passed in by the caller. These are
# the two AIA LA office-hours meetings R4 already applied to
# orgs/aia-la.md rule 10; Phase 2 migrates them under the staging-first
# protocol, so P-1/P-2/P-3/P-4 must all be no-ops for these ids (enforced
# as a full-resolution invariant in resolve(), not just a P-3 skip).
PROTECTED_MEETING_IDS: frozenset[str] = frozenset(
    {
        "01KYGEE6TGNCNZ1YMYHQMZH9KC",
        "01KZ4G1SY192WQRSQD5SGCR171",
    }
)

# P1' (R4b plan v3, G0a-v3 approved): placeholder/device/email-as-name
# participant-name shapes. Anchored and casefolded (re.IGNORECASE). Applied
# ONLY to the candidate list rule 7 picks `first` from — never to the shared
# `externals` list read by rules 3/5/6/9/10 (G0a C-4: a global filter
# returns {} -> exit 5 for 17 currently-ok meetings).
_PLACEHOLDER_PARTICIPANT_NAME_RE = re.compile(
    r"^speaker\s*\d+$"
    r"|^guest$"
    r"|^unknown$"
    r"|^user\s*\d+$"
    r"|^\s*[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\s*$"
    r"|['’]s\s+(?:iphone|ipad)\b"
    r"|^\s*(?:iphone|ipad)\b"
    # G0a I-1 (R4b plan v2 Phase 1): a redacted/partial phone number is a
    # device-dial placeholder, not a name -- required BEFORE P-1 ships, so
    # removing a roster member (e.g. Mrin) from a two-participant meeting
    # never promotes a phone number to candidates[0] and mints a junk
    # orgs/1-310-00.md-shaped page.
    r"|^\s*\+?\d[\d\s().*–-]{5,}\s*$",
    re.IGNORECASE,
)

# P3' (R4b plan v3, G0a-v3 approved): description-shaped classification
# org_name — a placeholder-for-a-real-name the classifier emits when it
# could not identify the counterparty (e.g. "Client (name not stated)").
# Applied ONLY at the rule-9 and rule-10 call sites (G0a-v3 A-1: the shared
# `slug_for_cls` at :319 also feeds `_pick`'s tie-break at :379, which
# drives rules 3/4/5/6 — those rules keep the RAW org_name).
_DESCRIPTION_SHAPED_ORG_NAME_RE = re.compile(
    r"\(\s*name\s+not\b"
    r"|\bnot\s+(?:stated|mentioned|specified|given|provided)\b"
    r"|\bunspecified\b"
    r"|\bunnamed\b"
    r"|\bundisclosed\b"
    r"|^\s*unknown\b"
    r"|^\s*client\s*[\(:]"
    r"|^\s*client\s+organization\b"
    r"|^\s*nonprofit\s+(?:organization|client|foundation)\b"
    r"|^\s*not\s+specified\b"
    r"|^\s*union\s*\("
    r"|\b[\w.&/-]+['’]s?\s+(?:[\w.&/-]+\s+){0,3}"
    r"(?:organization|organisation|company|nonprofit|non-profit|foundation|firm|business|practice|team|agency|shop)\b"
    r"|^\s*[\w.&/ -]{0,40}\b(?:conservation|advocacy)?\s*nonprofit\s*\(",
    re.IGNORECASE,
)


def _is_placeholder_participant_name(name: Any) -> bool:
    text = str(name or "").strip()
    if not text:
        return True
    return bool(_PLACEHOLDER_PARTICIPANT_NAME_RE.search(text))


def _is_description_shaped_org_name(name: Any) -> bool:
    text = str(name or "").strip()
    if not text:
        return False
    return bool(_DESCRIPTION_SHAPED_ORG_NAME_RE.search(text))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_quote(text: str) -> str:
    t = text.replace("\u2018", "'").replace("\u2019", "'")
    t = t.replace("\u201c", '"').replace("\u201d", '"')
    t = t.replace("\u2013", "-").replace("\u2014", "-")
    t = " ".join(t.casefold().split())
    return t


def _deaccent(text: str) -> str:
    """NFKD-fold and drop combining marks so accented letters survive slugging.
    Without this `Verónica Zárate` slugs to `ver-nica-z-rate` (R4b, 2026-09-11)."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(text)) if not unicodedata.combining(c))


def slugify(text: str) -> str:
    folded = re.sub(r"[^a-z0-9]+", "-", _deaccent(text).lower()).strip("-")
    if folded:
        return folded
    # All-accent / non-latin input: keep the pre-fold behaviour rather than
    # returning an empty slug (which would collide across meetings).
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def _candidate_tier(slug: str, clients: dict[str, Any], closed: dict[str, Any]) -> int:
    """0 = client-tier, 1 = everything else. Josh 2026-09-11: "with a client the
    client always wins" — a meeting holding both a client and a vendor belongs to
    the CLIENT regardless of participant count (Russian Riverkeeper + 4 Upcode
    attendees is a Russian Riverkeeper meeting). Clearworks + a vendor alone is
    fine as the vendor."""
    if slug in clients:
        return 0
    page = (closed.get("orgs") or {}).get(slug)
    if page is not None:
        try:
            rel = _relationship_from_text(Path(page).read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            rel = None
        if rel == "client":
            return 0
    return 1


def _norm_entity(text: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", _deaccent(str(text or "")).lower())


def _existing_page_for_org_name(org_name: Any, clients: dict[str, Any], closed: dict[str, Any]) -> tuple[str, str] | None:
    """(kind, slug) of an EXISTING client/org page the classification names, else None.
    Exact or prefix match in either direction on normalized names, both sides >= 4
    chars. Deliberately NOT substring: "OU" would otherwise match genesisgoldgroup."""
    n = _norm_entity(org_name)
    if len(n) < 4:
        return None
    pages: list[tuple[str, str]] = [("clients", c) for c in clients] + [("orgs", o) for o in closed.get("orgs", {})]
    for kind, slug in pages:
        if _norm_entity(slug) == n:
            return (kind, slug)
    for kind, slug in pages:
        pn = _norm_entity(slug)
        if len(pn) >= 4 and (n.startswith(pn) or pn.startswith(n)):
            return (kind, slug)
    return None


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


def _relationship_from_text(text: str) -> str | None:
    for line in text.splitlines():
        if re.match(r"^relationship:", line, re.I):
            val = line.split(":", 1)[1].strip().lower()
            return val or None
    return None


def _org_name_from_text(text: str) -> str | None:
    """Parse a '- CRM org name: X' (or bare 'CRM org name: X') line from a client/org page."""
    for line in text.splitlines():
        m = re.match(r"^\s*-?\s*CRM org name\s*:\s*(.+)$", line, re.I)
        if m:
            val = m.group(1).strip()
            return val or None
    return None


def _community_org_slug(org_name: str) -> str:
    """D: normalize community/teaching-session org names to one deterministic slug.

    Strip parentheticals, then strip the standalone words 'office hours'/'community',
    then slugify. 'AIA LA (Office Hours community)' and 'AIA LA Office Hours' both
    normalize to 'aia-la'.
    """
    s = re.sub(r"\([^)]*\)", "", str(org_name or ""))
    s = re.sub(r"\b(office hours|community)\b", "", s, flags=re.I)
    return slugify(s)


def _company_slug(company: str, aliases: Any) -> str:
    """G-32/G-55: alias table first (keys are display names), only then slugify(company)."""
    c = str(company)
    if "." in c and " " not in c:
        return registrable_label(c)
    if isinstance(aliases, dict):
        return str(aliases.get(c) or slugify(c))
    return slugify(c)


def load_closed_sets(vault: Path) -> dict[str, Any]:
    brain = org_brain_root(vault)
    clients: dict[str, Path] = {}
    orgs: dict[str, Path] = {}
    nodes: dict[str, dict[str, Any]] = {}
    domain_to_slug: dict[str, str] = {}
    org_name_to_slug: dict[str, str] = {}
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
            oname = _org_name_from_text(text)
            if oname:
                org_name_to_slug[_norm_title(oname)] = path.stem
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
        "org_name_to_slug": org_name_to_slug,
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
    dropped = {"decisions": 0, "commitments": 0, "open_questions": 0, "promotion": False, "promotion_reason": None}
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
    open_questions = []
    for item in extraction.get("open_questions") or []:
        if isinstance(item, dict) and quote_grounded(item.get("quote"), blob):
            open_questions.append(item)
        else:
            dropped["open_questions"] += 1
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
    validated["open_questions"] = open_questions
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


def _meeting_id(source: dict[str, Any]) -> str:
    src = source.get("source")
    if not isinstance(src, dict):
        return ""
    return str(src.get("id") or "")


def _load_roster_names(repo_root: Path) -> set[str]:
    """P-1 (plan v2 Phase 1): roster is a DATA file, not code -- Josh Weiss
    and Mrin/Mrinmayi Sawant ONLY (Josh 2026-09-08). Normalized-name
    aliases, matched by name regardless of Fireflies side/spoke (G0a I-2:
    the roster must include short-form variants like "Mrin S." that appear
    in the live batch). Absent file -> empty roster, never an error."""
    data = _load_json(repo_root / INTERNAL_ROSTER_REL, {"names": []})
    names = data.get("names") if isinstance(data, dict) else None
    if not isinstance(names, list):
        names = []
    return {_norm_title(str(n)) for n in names if str(n).strip()}


def _external_participants(source: dict[str, Any], roster: set[str] | None = None) -> list[dict[str, Any]]:
    roster = roster or set()
    out = []
    for p in source.get("participants") or []:
        if not isinstance(p, dict):
            continue
        if p.get("notetaker"):
            continue
        # P-1: a roster member is "ours" by normalized NAME regardless of
        # the stored side/spoke -- filtered out of the external-participant
        # view every rule reads, never by mutating the stored envelope
        # (participants[] stays byte-identical; only this in-memory view
        # changes). A meeting whose only participants are roster members
        # therefore falls through to the existing "no externals" rule.
        pname = _norm_title(str(p.get("name") or ""))
        if pname and pname in roster:
            continue
        side = p.get("side")
        spoke = bool(p.get("spoke"))
        if side == "theirs" or (side == "unknown" and spoke):
            out.append(p)
    return out


_TRAILING_PAREN_QUALIFIER_RE = re.compile(r"\s*\(([^()]*)\)\s*$")
_TRAILING_ORG_QUALIFIER_RE = re.compile(r",\s*[^,]+$")


def _strip_name_qualifiers(name: Any) -> str:
    """P-2 (plan v2 Phase 1): strip ONE trailing parenthetical and a
    trailing ', <Org>' qualifier before contact matching -- e.g. 'Jay
    Owens, CCA Systems (HeHim)' -> 'Jay Owens'.

    Guards (G0a-measured traps, do not re-introduce):
    - Never strip a trailing parenthetical whose content is the only
      identity evidence in the slot: an email address. 'Erin Morris
      (erin@erinmorris.com)' is returned unchanged.
    - A name with neither shape is returned unchanged: 'Kevin Collins -
      CTO @ Turazo' has no trailing parenthetical and no comma, so nothing
      strips.
    """
    text = str(name or "").strip()
    if not text:
        return text
    m = _TRAILING_PAREN_QUALIFIER_RE.search(text)
    if m and "@" not in m.group(1):
        text = text[: m.start()].rstrip()
    m2 = _TRAILING_ORG_QUALIFIER_RE.search(text)
    if m2:
        text = text[: m2.start()].rstrip()
    return text


_OFFICE_HOURS_TITLE_RE = re.compile(r"(?<![a-z0-9])office\s+hours?(?![a-z0-9])", re.IGNORECASE)


def _is_office_hours_title(ntitle: str) -> bool:
    """P-3 (plan v2 Phase 1): TITLE-ANCHORED only -- checks the meeting
    title, never a substring match anywhere in the transcript body or the
    classifier's org_name/evidence text."""
    return bool(_OFFICE_HOURS_TITLE_RE.search(ntitle))


def _office_hours_home(closed: dict[str, Any]) -> dict[str, Any]:
    """P-3: office-hours sessions are Clearworks-internal teaching, never
    the attendee's org (Josh 2026-09-08: "the office hours just make them
    clearworks internal"). Same clearworks-internal payload shape as rule
    8, kept under a distinct rule number so a P-3 hit is distinguishable
    from "no external participants" in resolution.json."""
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
        "rule": 11,
        "corroborated": False,
        "also_present": [],
    }


def _load_employer_history(repo_root: Path) -> dict[str, list[dict[str, Any]]]:
    """P-4 (plan v2 Phase 1): person -> [{date_from, date_to, slug}, ...],
    keyed by contact id (falls back to normalized contact name). Absent
    file -> empty map, never an error."""
    data = _load_json(repo_root / EMPLOYER_HISTORY_REL, {})
    if not isinstance(data, dict):
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for key, entries in data.items():
        if isinstance(entries, list):
            out[_norm_title(str(key))] = [e for e in entries if isinstance(e, dict)]
    return out


def _employer_slug_at(
    row: dict[str, Any], occurred_at: Any, history: dict[str, list[dict[str, Any]]]
) -> str | None:
    """P-4: employer AT MEETING TIME, never current employer. Consulted
    BEFORE the CRM-company resolution so a person whose contacts.json
    company reflects today's employer still routes historical meetings to
    the employer they had when the meeting happened (G0a-measured trap:
    a contact's 12 batch meetings predate a later employer switch and
    must not follow the current company to the wrong client). Silent
    no-op when there is no entry or no date overlap -- callers fall back
    to the ordinary company resolution."""
    if not history:
        return None
    keys = []
    cid = _norm_title(str(row.get("id") or ""))
    if cid:
        keys.append(cid)
    pname = _norm_title(str(row.get("name") or ""))
    if pname:
        keys.append(pname)
    entries: list[dict[str, Any]] = []
    for k in keys:
        entries = history.get(k) or []
        if entries:
            break
    if not entries:
        return None
    date_part = str(occurred_at or "")[:10]
    if not date_part:
        return None
    for entry in entries:
        slug = entry.get("slug")
        if not slug:
            continue
        date_from = str(entry.get("date_from") or "0000-00-00")
        date_to = str(entry.get("date_to") or "9999-99-99")
        if date_from <= date_part <= date_to:
            return str(slug)
    return None


def resolve(
    source: dict[str, Any],
    closed: dict[str, Any],
    repo_root: Path,
    classification: dict[str, Any] | None = None,
    protected_ids: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    if not (source.get("participants") or []) and not (source.get("text_units") or []):
        raise SystemExit(5)
    # Plan v2 (R4b Phase 1) coordinator correction 2026-09-08: protection is
    # an explicit id allow-list (resolve() has no applied-state input), and
    # it is a FULL-RESOLUTION invariant -- a protected meeting id disables
    # P-1/P-2/P-3/P-4 entirely and reproduces the exact unmodified rule
    # ladder, not just a P-3 skip.
    is_protected = _meeting_id(source) in protected_ids
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
        slug = _company_slug(str(row.get("company") or ""), aliases)
        for em in row.get("emails") or []:
            if "@" in str(em):
                domain_to_slug[registrable_label(str(em).split("@", 1)[1])] = slug or domain_to_slug.get(
                    registrable_label(str(em).split("@", 1)[1]), ""
                )

    roster = set() if is_protected else _load_roster_names(repo_root)
    employer_history = {} if is_protected else _load_employer_history(repo_root)
    externals = _external_participants(source, roster)
    # F5 (round 2): cls / cls_label / slug_for_cls are shared by the rule-9
    # override AND the _pick tie-break below — compute them once, up front,
    # instead of inside rule 9 (previous location).
    cls = classification if isinstance(classification, dict) else {}
    cls_domain = str(cls.get("domain") or "").strip().lower()
    cls_org_name = str(cls.get("org_name") or "").strip()
    cls_label = registrable_label(cls_domain) if cls_domain else None
    slug_for_cls = slugify(cls_org_name) if cls_org_name else cls_label
    client_cands: set[str] = set()
    org_cands: set[str] = set()
    unknown_labels: dict[str, tuple[str, str]] = {}
    unknown_counts: dict[str, int] = {}
    all_label_counts: dict[str, int] = {}
    for p in externals:
        email = str(p.get("email") or "")
        if "@" not in email:
            continue
        domain = email.split("@", 1)[1].lower()
        if domain in FREE_MAIL:
            continue
        lab = registrable_label(domain)
        tld = domain.rsplit(".", 1)[-1]
        all_label_counts[lab] = all_label_counts.get(lab, 0) + 1
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

    # G-R4: contacts.json can map a domain label to a company slug that matches
    # no real client/org page (alias values are display names, or a later
    # contact row's company overwrites an earlier, correct one). A plain
    # `domain_to_slug.get(lab) or ... or (lab if lab in cands else "")` chain
    # silently drops that participant's vote when the mapped value is truthy
    # but wrong. Check membership independently instead (mirrors the
    # candidate-collection loop above).
    def _counts(cands: set[str]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for p in externals:
            email = str(p.get("email") or "")
            if "@" not in email:
                continue
            domain = email.split("@", 1)[1].lower()
            if domain in FREE_MAIL:
                continue
            lab = registrable_label(domain)
            mapped = domain_to_slug.get(lab) or domain_to_slug.get(domain) or ""
            slug = mapped if mapped in cands else (lab if lab in cands else "")
            if slug:
                counts[slug] = counts.get(slug, 0) + 1
        return counts

    def _also(picked: str) -> list[str]:
        return sorted(c for c in (client_cands | org_cands | rule4) if c != picked)

    def _pick(cands: set[str]) -> str:
        counts = _counts(cands)
        # F5 (round 2, brief A): ties -> prefer the candidate matching
        # classification.org_name/domain, then most open engagement nodes,
        # then alphabetical.
        cls_match = {v for v in (cls_label, slug_for_cls) if v}
        return min(
            cands,
            key=lambda s: (
                _candidate_tier(s, clients, closed),
                -counts.get(s, 0),
                -(1 if s in cls_match else 0),
                -sum(
                    1
                    for n in nodes.values()
                    if n.get("client") == s
                    and (n.get("delivery_state") in OPEN_STATES or n.get("delivery_state") == "active")
                ),
                s,
            ),
        )

    # B: contacts.json (by email or normalized name) beats a bare email-domain
    # guess for a named person. Match every external participant against
    # contacts.json; resolve their company to a client via the alias table
    # (existing _company_slug) or, when the alias table's value is a display
    # name rather than a slug, via a client page's declared "CRM org name:".
    def _resolve_company_slug(company: Any) -> str | None:
        if not company:
            return None
        company_str = str(company)
        slug = _company_slug(company_str, aliases)
        if slug in clients or slug in closed["orgs"]:
            return slug
        # F2 (round 2): org-aliases values are display names, not slugs, so
        # a contact's company rarely slugifies straight to a real page. Find
        # a domain-like alias KEY whose VALUE normalizes to this company, and
        # resolve THAT domain's registrable label through domain_to_slug /
        # clients / orgs (e.g. "msia.org" -> "Movement of Spiritual
        # Awareness" -> label "msia" -> clients/msia.md). The "CRM org
        # name:" page-line path below stays as a secondary fallback.
        if isinstance(aliases, dict):
            # N4 (round 3): canonicalize the company string through the alias
            # table BEFORE normalizing, so a contact whose company is an
            # alias KEY (e.g. "Movement of Spiritual Awareness Internationale
            # (MSIA)") resolves exactly like one whose company is already the
            # alias VALUE ("Movement of Spiritual Awareness") — otherwise the
            # reverse lookup below compares the raw key string against alias
            # VALUES and never matches.
            canonical = aliases.get(company_str, company_str)
            target = _norm_title(str(canonical))
            for k, v in aliases.items():
                if _norm_title(str(v)) != target:
                    continue
                if "." not in k or " " in k:
                    continue
                lab = registrable_label(k)
                # N7 (round 3): try the pristine, page-frontmatter-only
                # domain map (closed["domain_to_slug"], immune to a later
                # contact row's company-name slugification clobbering an
                # already-correct page mapping for this label — see F3)
                # before the local, contacts-overlaid map.
                mapped = (
                    closed["domain_to_slug"].get(lab)
                    or closed["domain_to_slug"].get(k.lower())
                    or domain_to_slug.get(lab)
                    or domain_to_slug.get(k.lower())
                    or ""
                )
                if mapped in clients or mapped in closed["orgs"]:
                    return mapped
                if lab in clients or lab in closed["orgs"]:
                    return lab
        alt = closed["org_name_to_slug"].get(_norm_title(company_str))
        if alt:
            return alt
        return None

    def _rows_matching_name(name_norm: str) -> list[dict[str, Any]]:
        if len(name_norm.split()) < 2:
            # R3-1 (round 4, Critical): a bare first name is not an identity
            # (mirrors rule 7's len(tokens) >= 2) — matching it against a
            # contacts.json row let the B override (rule 4) silently re-home
            # a meeting onto that row's company over the real email-domain
            # pick (production repro: "Michelle" -> clients/alloi.md rule 4,
            # over the correct clients/oakrootsaccounting.md rule 3). This
            # guard applies to every name candidate tried below, raw or
            # P-2-stripped.
            return []
        return [row for row in contact_rows if _norm_title(str(row.get("name") or "")) == name_norm]

    def _match_contact(p: dict[str, Any]) -> dict[str, Any] | None:
        email = str(p.get("email") or "").strip().lower()
        if email:
            for row in contact_rows:
                emails = [str(e).lower() for e in (row.get("emails") or [])]
                if email in emails:
                    return row
        raw_name = str(p.get("name") or "")
        pname = _norm_title(raw_name)
        if not pname:
            return None
        matches = _rows_matching_name(pname)
        if not matches and not is_protected:
            # P-2: strip ONE trailing parenthetical and a trailing
            # ", <Org>" qualifier and retry — ONLY as a fallback when the
            # raw name found nothing, so an exact raw match (e.g. a contact
            # row whose own stored name carries the identical qualifier)
            # is never disturbed.
            stripped_norm = _norm_title(_strip_name_qualifiers(raw_name))
            if stripped_norm and stripped_norm != pname:
                matches = _rows_matching_name(stripped_norm)
        if not matches:
            return None
        if len(matches) == 1:
            return matches[0]
        # F4 (round 2): real contacts.json has normalized-name collisions,
        # including true two-company collisions (e.g. one person's name
        # shared by two different real companies on file). Picking the
        # first row on file order is silent and file-order-dependent. If the
        # colliding rows resolve to DIFFERENT company slugs, treat this as
        # no match at all rather than guessing.
        slugs = {s for s in (_resolve_company_slug(m.get("company")) for m in matches) if s}
        if len(slugs) > 1:
            return None
        # N6 (round 3): when every match "agrees" (0 or 1 distinct resolved
        # slug), don't just hand back matches[0] on file order — that can be
        # a row whose OWN company fails to resolve even though a sibling row
        # (same name) resolves fine, silently discarding a usable identity.
        # Prefer a match whose company actually resolves; fall back to
        # matches[0] only when none of them do.
        if slugs:
            return next(m for m in matches if _resolve_company_slug(m.get("company")))
        return matches[0]

    rule4: set[str] = set()
    name_only_rule4: set[str] = set()
    for p in externals:
        row = _match_contact(p)
        if not row:
            continue
        # P-4: employer AT MEETING TIME wins over the CRM row's (possibly
        # current-day) company when a date-ranged override exists for this
        # meeting's occurred_at; otherwise fall back to the ordinary
        # company resolution, byte-identical to before P-4.
        slug = _employer_slug_at(row, source.get("occurred_at"), employer_history) or _resolve_company_slug(
            row.get("company")
        )
        if not slug:
            continue
        p_email = str(p.get("email") or "").strip().lower()
        has_email = "@" in p_email
        # N5 (round 3): org_cands must require the participant's email to
        # have ACTUALLY matched this contact row's emails, not merely "the
        # participant has some email" — a participant can carry an unrelated
        # (non-contact) email while still being identified by NAME, and that
        # must not silently route the meeting to the identified org via
        # rule 6 (F7's DECISION was "email-matched contacts", not "any
        # contact match on an emailed participant").
        email_matched = has_email and p_email in {str(e).lower() for e in (row.get("emails") or [])}
        if slug in clients:
            rule4.add(slug)
            if not has_email:
                name_only_rule4.add(slug)
        if slug in closed["orgs"] and email_matched:
            org_cands.add(slug)

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
    # P-3 (plan v2 Phase 1): office-hours sessions are Clearworks-internal,
    # never the attendee's org or a community org page — a categorical Josh
    # ruling inserted after rules 1-2 and before rule 10 (coordinator
    # correction 2026-09-08: the plan's ladder is not a literal executable
    # order; P-1/P-2/P-4 transform inputs to the unchanged rule ladder, only
    # this is a new branch, and it must sit here — before rule 10's
    # community-org door AND before the rules 3/4/9 email/domain path below
    # — so a real client email present on an office-hours meeting (e.g. the
    # 7 meetings a ReThink Media attendee's email otherwise wins) does not
    # pre-empt it). Protected ids (already-applied production homes) are a
    # full-resolution no-op, never reaching this branch.
    if not is_protected and _is_office_hours_title(ntitle):
        return _office_hours_home(closed)
    # (10) community / teaching sessions: no external participant has an
    # email at all (nothing for rule 3/4/5/6 to see) and the classifier calls
    # it a colleague/personal community context with a named org — home is
    # that community's org page, never a person page carved from an attendee.
    # F1 (round 2): this MUST run before the B override / rule 3-4 default /
    # rule 6, otherwise a name-only attendee whose company happens to have a
    # page (contacts.json) pre-empts the community predicate and routes the
    # meeting to that attendee's own org/client instead of the community org.
    no_external_emails = not any("@" in str(p.get("email") or "") for p in externals)
    # R3-2 (round 4, Important, coordinator-decided option b): a single
    # email-less external is a 1:1, not a community/teaching session — leave
    # it to rule 7's person page instead of creating a new org page named by
    # whatever the classifier put in org_name (production repro: "Steven
    # Burns" -> WRONGLY created orgs/core-boards.md; D-20 accepted the
    # existing orgs/steven-burns-faia.md person page). R1/R2 (5 externals)
    # are unaffected.
    # P3' (R4b plan v3): a description-shaped org_name is treated as ABSENT
    # for rule 10's page-creation door — sanitized HERE, at the rule-10 call
    # site only. cls_org_name (raw) still feeds slug_for_cls / _pick's
    # tie-break for rules 3/4/5/6 above, untouched.
    cls_org_name_10 = "" if _is_description_shaped_org_name(cls_org_name) else cls_org_name
    if (
        externals
        and len(externals) >= 2
        and no_external_emails
        and cls.get("relationship") in {"colleague", "personal"}
        and cls_org_name_10
    ):
        slug = _community_org_slug(cls_org_name_10)
        if slug:
            # N2 (round 3): don't create a duplicate orgs/<slug>.md beside an
            # existing clients/<slug>.md for the same normalized org name —
            # reuse the client page instead (same class of bug as F3/rule 9).
            if slug in clients:
                hit = _client_hit(slug, nodes, clients, rule=10)
                hit["also_present"] = []
                return hit
            # Also honour a page-declared org name (a client/org page whose
            # "- CRM org name:" line normalizes to classification.org_name,
            # even when its file slug differs from _community_org_slug's
            # computed value) before falling back to create-or-reuse-by-slug.
            existing_org_slug = closed["org_name_to_slug"].get(_norm_title(cls_org_name_10))
            # R3-3 (round 4, Minor): org_name_to_slug is built from BOTH
            # clients/ and orgs/ pages (load_closed_sets), so a
            # page-declared name that resolves to an existing CLIENT page
            # must reuse it too — otherwise this door creates a duplicate
            # orgs/<slug>.md beside clients/<existing_org_slug>.md (the N2
            # bug via a second path).
            if existing_org_slug and existing_org_slug in clients:
                hit = _client_hit(existing_org_slug, nodes, clients, rule=10)
                hit["also_present"] = []
                return hit
            if existing_org_slug and existing_org_slug in closed["orgs"]:
                page_rel = _relationship_from_text(
                    closed["orgs"][existing_org_slug].read_text(encoding="utf-8")
                )
                rel = page_rel if page_rel in RELATIONSHIPS else str(cls.get("relationship"))
                return {
                    "counterparty_slug": existing_org_slug,
                    "kind": "org",
                    "relationship": rel,
                    "home_path": f"orgs/{existing_org_slug}.md",
                    "node": "none",
                    "created": None,
                    "confidence": float(cls.get("confidence") or 0),
                    "rule": 10,
                    "corroborated": False,
                    "also_present": [],
                }
            exists = slug in closed["orgs"]
            rel = str(cls.get("relationship"))
            return {
                "counterparty_slug": slug,
                "kind": "org",
                "relationship": rel,
                "home_path": f"orgs/{slug}.md",
                "node": "none",
                "created": None if exists else {"kind": "org", "slug": slug, "relationship": rel},
                "confidence": float(cls.get("confidence") or 0),
                "rule": 10,
                "corroborated": False,
                "also_present": [],
            }
    # (B, folded into rule 4) contacts.json identifies a person by name that a
    # bare email-domain guess cannot see at all (no email on that participant
    # object). When that identity resolves to a different client than the
    # domain/contacts pick would otherwise reach, the identified contact wins.
    default_pick: str | None = None
    if name_only_rule4:
        b_pick = _pick(name_only_rule4)
        if client_cands:
            default_pick = _pick(client_cands)
        elif rule4:
            default_pick = _pick(rule4)
        if default_pick != b_pick:
            hit = _client_hit(b_pick, nodes, clients, rule=4)
            hit["also_present"] = _also(b_pick)
            return hit
    # (3) candidate client from non-free-mail domain
    default_pick = None
    default_rule = 0
    if client_cands:
        default_pick = _pick(client_cands)
        default_rule = 3
    elif rule4:
        default_pick = _pick(rule4)
        default_rule = 4
    # (9) high-confidence classification over a minority client candidate:
    # only overrides an existing rule-3/4 pick (never fires when there is no
    # recognized client candidate at all — that stays rule 6/unknown-label
    # territory), and only when the classified org actually outnumbers it.
    if default_pick is not None:
        cls_conf = float(cls.get("confidence") or 0)
        # P3' (R4b plan v3): a description-shaped org_name is treated as
        # ABSENT for rule 9's page-creation door, sanitized HERE at the
        # rule-9 call site only — this falls back to the same cls_label
        # (domain-derived) slug the code already uses when org_name is
        # empty, so rule 9 still resolves by domain (never shadowed by a
        # garbage name). The module-level slug_for_cls (raw) is untouched
        # and still feeds _pick's tie-break for rules 3/4/5/6 above.
        sanitized_cls_org_name = "" if _is_description_shaped_org_name(cls_org_name) else cls_org_name
        slug_for_cls_9 = slugify(sanitized_cls_org_name) if sanitized_cls_org_name else cls_label
        already_matches = default_pick in {cls_label, slug_for_cls_9}
        if cls_conf >= 0.8 and slug_for_cls_9 and not already_matches:
            cls_count = all_label_counts.get(cls_label, 0) if cls_label else 0
            default_count = _counts({default_pick}).get(default_pick, 0)
            if cls_count > default_count:
                rel = str(cls.get("relationship") or "")
                if rel not in RELATIONSHIPS:
                    rel = "prospect"
                if slug_for_cls_9 in clients:
                    hit = _client_hit(slug_for_cls_9, nodes, clients, rule=9)
                    hit["also_present"] = _also(slug_for_cls_9)
                    return hit
                if cls_label and cls_label in clients:
                    hit = _client_hit(cls_label, nodes, clients, rule=9)
                    hit["also_present"] = _also(cls_label)
                    return hit
                # F3 (round 2): before creating a new org page, check whether
                # this classified domain is already declared on an EXISTING
                # page (from page frontmatter via closed["domain_to_slug"],
                # not the contacts-overlaid local `domain_to_slug` — a
                # contact row's company can slugify to something that
                # doesn't match the page's own slug and silently mask it).
                existing_page_slug = closed["domain_to_slug"].get(cls_label) if cls_label else None
                if existing_page_slug and existing_page_slug in clients:
                    hit = _client_hit(existing_page_slug, nodes, clients, rule=9)
                    hit["also_present"] = _also(existing_page_slug)
                    return hit
                if existing_page_slug and existing_page_slug in closed["orgs"]:
                    page_rel = _relationship_from_text(
                        closed["orgs"][existing_page_slug].read_text(encoding="utf-8")
                    )
                    if page_rel in RELATIONSHIPS:
                        rel = page_rel
                    return {
                        "counterparty_slug": existing_page_slug,
                        "kind": "org",
                        "relationship": rel,
                        "home_path": f"orgs/{existing_page_slug}.md",
                        "node": "none",
                        "created": None,
                        "confidence": cls_conf,
                        "rule": 9,
                        "corroborated": False,
                        "also_present": _also(existing_page_slug),
                    }
                org_slug = slug_for_cls_9 if slug_for_cls_9 in closed["orgs"] else (
                    cls_label if cls_label and cls_label in closed["orgs"] else slug_for_cls_9
                )
                exists = org_slug in closed["orgs"]
                if exists:
                    page_rel = _relationship_from_text(closed["orgs"][org_slug].read_text(encoding="utf-8"))
                    if page_rel in RELATIONSHIPS:
                        rel = page_rel
                return {
                    "counterparty_slug": org_slug,
                    "kind": "org",
                    "relationship": rel,
                    "home_path": f"orgs/{org_slug}.md",
                    "node": "none",
                    "created": None if exists else {"kind": "org", "slug": org_slug, "relationship": rel},
                    "confidence": cls_conf,
                    "rule": 9,
                    "corroborated": False,
                    "also_present": _also(org_slug),
                }
    if default_pick is not None:
        hit = _client_hit(default_pick, nodes, clients, rule=default_rule)
        hit["also_present"] = _also(default_pick)
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
    rel_ok = {"prospect", "vendor", "partner", "personal"}
    # (6) org candidate from domain/company, else create from non-free-mail label
    if org_cands:
        picked = _pick(org_cands)
        org_path = closed["orgs"].get(picked)
        page_rel = _relationship_from_text(org_path.read_text(encoding="utf-8")) if org_path else None
        cls_rel = str(cls.get("relationship") or "")
        if page_rel in RELATIONSHIPS:
            rel = page_rel
        elif cls_rel in RELATIONSHIPS:
            rel = cls_rel
        else:
            print(
                f"ambiguous-relationship: no relationship: frontmatter on orgs/{picked}.md "
                "and no valid classification.relationship",
                file=sys.stderr,
            )
            raise SystemExit(5)
        return {
            "counterparty_slug": picked,
            "kind": "org",
            "relationship": rel,
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
        # P1' (R4b plan v3): filter placeholder/device/email-as-name shapes
        # OUT OF THE CANDIDATE LIST rule 7 picks `first` from ONLY — this
        # `candidates` list is local to rule 7 and must never replace the
        # shared `externals` list rules 3/5/6/9/10 read above.
        # F2 (2026-09-11): before minting a person page, if the sanitized
        # classification names an org that ALREADY has a page, file the
        # meeting there. Exact or prefix match on both sides, minimum 4
        # normalized chars, never arbitrary substring — measured: substring
        # sends "OU" to clients/genesisgoldgroup because "ou" occurs inside
        # "genesisgold-grou-p". Creates nothing.
        _cls_name_7 = "" if _is_description_shaped_org_name(cls_org_name) else cls_org_name
        _cls_page = _existing_page_for_org_name(_cls_name_7, clients, closed)
        if _cls_page is not None:
            _kind, _slug = _cls_page
            if _kind == "clients":
                _cls_hit = _client_hit(_slug, nodes, clients, rule=7)
                _cls_hit["also_present"] = []
                return _cls_hit
            return {
                "counterparty_slug": _slug,
                "kind": "org",
                "relationship": str(cls.get("relationship") or "client"),
                "home_path": f"orgs/{_slug}.md",
                "node": "none",
                "created": None,
                "confidence": float(cls.get("confidence") or 0),
                "rule": 7,
                "corroborated": False,
                "also_present": [],
            }
        candidates = [p for p in externals if not _is_placeholder_participant_name(p.get("name"))]
        if not candidates:
            # Fallback (G0a C-4 / G0b AR-001): every rule-7 candidate was a
            # placeholder — take the existing rule-8 home rather than
            # fabricate a person page from a classifier artefact.
            return _rule8_home(closed)
        first = candidates[0]
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
        return _rule8_home(closed)
    return {}


def _rule8_home(closed: dict[str, Any]) -> dict[str, Any]:
    """The rule-8 payload — shared by the real "no external participants"
    branch and rule 7's P1' all-placeholders fallback so the two paths can
    never drift (exact literal per :824-839 as of 3e98d519)."""
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
        "also_present": sorted(c for c in client_cands if c != node["client"]),
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
        resolution = resolve(
            source,
            closed,
            Path(args.repo_root),
            extraction.get("classification") if isinstance(extraction.get("classification"), dict) else None,
            protected_ids=PROTECTED_MEETING_IDS,
        )
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
