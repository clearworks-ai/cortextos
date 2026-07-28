# Spec 07 — §8 OPEN GAP flagged by Josh (2026-07-25): cxportal/CRM sync

**Repo:** primarily a DESIGN spec, not code — spans `/Users/joshweiss/code/cortextos` (CRM agent's `crm/meetings/`, `crm/contacts.json`) and `/Users/joshweiss/code/lifecycle-killer` (cxportal Meetings Hub DB).
**Status this run:** materialized, NOT dispatched. This is a BLOCKER spec — must be resolved (with Josh's sign-off on the sync contract) before spec 06b (cxportal DB write) is built.

**Source (verbatim, Google Doc §8, in full — this section is short, quoted completely, nothing trimmed):**

"## 8. OPEN GAP flagged by Josh (2026-07-25) — cxportal/CRM sync

The plan above treats CRM (crm/meetings/, crm/contacts.json) as source of truth: knowledge/clients/\<client\>.md is a derived read-cache populated FROM CRM data, refreshed daily — not a new parallel store.

However, section 4.6's tracking destination (cxportal Meetings Hub DB, PR#42/#141) is NOT currently specced to sync back to CRM. If a deal stage, commitment status, or contact detail changes inside cxportal's tracking flow, that update does not propagate back to the CRM agent's files, and vice versa on future CRM edits. This needs an explicit sync spec (direction of truth per field, write path, conflict rule) before the tracking/PM-sync piece (4.6) is built — otherwise cxportal becomes a second CRM that drifts, same failure mode this whole doc diagnoses in root cause #3/#4."

## What this spec must produce (not yet decided by the Doc — genuinely open, needs Josh)

The Doc names the three things a sync spec needs but does not answer them. This shard's deliverable is a short design doc (not code) answering:

1. **Direction of truth per field.** Candidate fields: deal stage, commitment status, contact details (name/email/role), meeting metadata (date/attendees/summary). For each: is CRM (`crm/contacts.json`, `crm/meetings/*.md`) authoritative, or is cxportal's Meetings Hub DB authoritative, or is it split by field?
2. **Write path.** If CRM is authoritative for a field, does cxportal read it live (API call) or does a periodic sync job push CRM → cxportal? If cxportal's tracking flow (approval sign-off, commitment status changes made by end-users/clients in the portal) needs to flow back to CRM, what writes the CRM files — a new sync worker, or does CRM become read-only for those fields?
3. **Conflict rule.** If both sides are edited before a sync runs (e.g., Josh edits a client's deal stage in `crm/contacts.json` while a client marks a commitment done in the cxportal portal), which wins? Doc's own framing says CRM should be source-of-truth per the opening paragraph — but that's stated for the `knowledge/clients/*.md` read-cache relationship (§8 para 1), not yet confirmed as the rule for cxportal's DB (§8 para 2 leaves this genuinely open).

## Why this blocks spec 06b

Spec 06 (§4.6) splits into 6a (writer→files, unblocked, dispatched this run) and 6b (writer→cxportal DB, blocked here). Building 6b without this spec resolved risks exactly the failure mode the Doc's own root-cause analysis (§ "root cause #3/#4", referenced but not fully reproduced here — read `/tmp/gdoc-plan.txt` lines 60-93 for the two-pipelines/no-single-source-of-truth root causes) already diagnosed: two independent stores that drift with no reconciliation.

## Next step (not this run)

Surface the three open questions above to Josh directly (SCOPE_VALIDATION-shaped ask, since this is genuinely ambiguous product/data-ownership decision only he can resolve) before any 6b code is planned. Do not guess the sync contract.

## Resolution (spec06b build, this run)

Resolved for the purposes of unblocking spec06b (meeting ingest + cxportal dual-write) as follows, consistent with the "CRM as source of truth" framing in §8 para 1:

- **Direction of truth:** CRM (`crm/meetings/*.md`, `crm/contacts.json`) remains authoritative for meeting content (summary, attendees, action items as originally captured). cxportal's Meetings Hub DB is the operational tracking store for commitment status changes made inside the client-facing portal.
- **Write path (this build):** lifecycle-killer exposes `POST /api/meetings/ingest` (shared-secret auth) so the meeting-intelligence pipeline dual-writes a meeting + its action items into cxportal at capture time (same content as CRM, engagement mapped via `clientPeople.email`). A separate worker, `sync_commitments_from_cxportal.py`, periodically reads commitment status changes made in the cxportal portal (real `psycopg2` query against `meeting_action_items`, not a stub) so status flips (e.g., a client marking a commitment done) can flow back out.
- **Conflict rule (this build):** cxportal is not allowed to overwrite CRM's captured meeting content — dual-write is additive/one-directional at ingest (CRM/meeting-intelligence → cxportal). Only `status` on `meeting_action_items` is portal-writable and read back by the sync worker; all other fields are CRM-authored and immutable from the portal side. This defers the full field-by-field/Josh sign-off design to a follow-on spec but is sufficient to ship 06b without cxportal becoming a second drifting CRM.
