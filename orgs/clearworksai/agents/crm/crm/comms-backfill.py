#!/usr/bin/env python3
"""One-off backfill of the last 7 days of Gmail interactions that the comms-ingest cron
never produced. Pulls sent + received, upserts contacts via helper, logs interactions via
helper, dedupes by (gmail message id). NOT a replacement for the cron — this is the
recovery pass while we diagnose the scheduler.
"""
import json, os, re, subprocess
from pathlib import Path

CRM = Path("/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm")

EMAIL_RE = re.compile(r"<([^>]+@[^>]+)>|([\w.+-]+@[\w.-]+\.\w+)")
NAME_RE = re.compile(r"^([^<]+?)\s*<")

def parse_addr(s):
    """'Lori Bodenhamer <lori@abundowealth.com>' -> ('Lori Bodenhamer', 'lori@abundowealth.com')"""
    if not s: return (None, None)
    m = EMAIL_RE.search(s)
    if not m: return (None, None)
    email = (m.group(1) or m.group(2) or "").strip().lower()
    nm = NAME_RE.match(s)
    name = (nm.group(1).strip().strip('"') if nm else email.split("@")[0]).strip()
    return (name, email)

def slugify(s):
    s = re.sub(r"[^\w\s-]", "", (s or "").lower())
    s = re.sub(r"\s+", "-", s).strip("-")
    return s or "unknown"

JOSH_EMAILS = {"josh@clearworks.ai", "weissjosh0@gmail.com"}
NOREPLY_PATTERNS = ("noreply", "no-reply", "notifications@", "bounce", "mailer-daemon",
                    "postmaster", "support@", "info@", "billing@", "alerts@")

def is_skip_email(email):
    if not email or "@" not in email: return True
    e = email.lower()
    if e in JOSH_EMAILS: return True
    domain = e.rsplit("@", 1)[-1]
    if domain == "clearworks.ai" or domain.endswith(".clearworks.ai"):
        return True
    for p in NOREPLY_PATTERNS:
        if p in e: return True
    return False

def gws_query(query):
    r = subprocess.run(
        ["gws", "gmail", "+triage", "--query", query, "user_google_email='josh@clearworks.ai'"],
        capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"emails": []}

def upsert(cid, name, email, company=None):
    args = ["python3", str(CRM / "upsert-contact.py"),
            "--id", cid, "--name", name, "--type", "person",
            "--email", email, "--source-ref", "comms-ingest-backfill-2026-06-01"]
    if company: args += ["--company", company]
    subprocess.run(args, capture_output=True, text=True, cwd=str(CRM))

def log_interaction(cid, typ, summary, source_ref):
    subprocess.run(
        ["python3", str(CRM / "add-interaction.py"),
         "--contact-id", cid, "--type", typ, "--summary", summary,
         "--source-ref", source_ref, "--sentiment", "neutral"],
        capture_output=True, text=True, cwd=str(CRM))
    # DESIGN-B-crm.md E7: emit per new interaction logged (poll-carried, event-shaped downstream).
    # Best-effort, never blocks the interaction write above.
    payload = json.dumps({"contact_id": cid, "type": typ, "source_ref": source_ref})
    emit_crm_event("crm.email.captured", payload)

def emit_crm_event(event_type, payload):
    """Self-inbox ``EVENT <type> — <json>`` (fast-checker wakes the crm session). Best-effort.
    Test seam: when CRM_EVENT_EMIT_LOG is set, append the line to that file instead of the bus."""
    line = f"EVENT {event_type} — {payload}"
    log_path = os.environ.get("CRM_EVENT_EMIT_LOG")
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        return
    try:
        subprocess.run(
            ["cortextos", "bus", "send-message", "crm", "normal", line],
            capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass

def main():
    # Load existing contacts to know what's already there + map email->id
    contacts = json.loads((CRM / "contacts.json").read_text())["contacts"]
    email_to_id = {}
    for c in contacts:
        for e in (c.get("emails") or []):
            if e and "@" in e: email_to_id[e.strip().lower()] = c.get("id")

    # Track existing interaction source_refs so we dedupe
    seen_refs = set()
    for line in (CRM / "interactions.jsonl").read_text().splitlines():
        line = line.strip()
        if not line: continue
        try:
            sr = json.loads(line).get("source_ref")
            if sr: seen_refs.add(sr)
        except Exception: pass

    stats = {"sent_msgs": 0, "received_msgs": 0,
             "new_contacts": 0, "existing_contacts_touched": 0,
             "interactions_logged": 0, "skipped_already": 0, "skipped_noreply": 0}

    # ---------- SENT (Josh → others) ----------
    sent = gws_query("from:josh@clearworks.ai newer_than:7d -from:sanebox.com")
    for m in sent.get("emails", []):
        stats["sent_msgs"] += 1
        msg_id = m.get("id"); ref = f"gmail:{msg_id}"
        if ref in seen_refs:
            stats["skipped_already"] += 1; continue
        to_field = m.get("to", "")
        if not to_field: continue
        recipients = [parse_addr(part) for part in re.split(r",\s*", to_field)]
        company_hint = lambda e: e.split("@")[1] if "@" in e else None
        for nm, em in recipients:
            if is_skip_email(em):
                stats["skipped_noreply"] += 1; continue
            cid = email_to_id.get(em) or slugify(nm) or em.split("@")[0]
            if cid not in {c.get("id") for c in contacts}:
                upsert(cid, nm or em.split("@")[0], em, company=company_hint(em))
                email_to_id[em] = cid
                contacts.append({"id": cid, "emails": [em]})
                stats["new_contacts"] += 1
            else:
                stats["existing_contacts_touched"] += 1
            summary = f"SENT: {m.get('subject','')[:120]} | {m.get('snippet','')[:200]}"
            log_interaction(cid, "email", summary, ref)
            stats["interactions_logged"] += 1
            seen_refs.add(ref)

    # ---------- RECEIVED (others → Josh) ----------
    recv = gws_query(
        "is:inbox newer_than:7d -category:promotions -category:social -category:updates "
        "-from:sanebox.com -from:noreply -from:no-reply -from:notifications")
    for m in recv.get("emails", []):
        stats["received_msgs"] += 1
        msg_id = m.get("id"); ref = f"gmail:{msg_id}"
        if ref in seen_refs:
            stats["skipped_already"] += 1; continue
        nm, em = parse_addr(m.get("from", ""))
        if is_skip_email(em):
            stats["skipped_noreply"] += 1; continue
        cid = email_to_id.get(em) or slugify(nm) or em.split("@")[0]
        if cid not in {c.get("id") for c in contacts}:
            upsert(cid, nm or em.split("@")[0], em, company=em.split("@")[1] if "@" in em else None)
            email_to_id[em] = cid
            contacts.append({"id": cid, "emails": [em]})
            stats["new_contacts"] += 1
        else:
            stats["existing_contacts_touched"] += 1
        summary = f"RECEIVED: {m.get('subject','')[:120]} | {m.get('snippet','')[:200]}"
        log_interaction(cid, "email", summary, ref)
        stats["interactions_logged"] += 1
        seen_refs.add(ref)

    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
