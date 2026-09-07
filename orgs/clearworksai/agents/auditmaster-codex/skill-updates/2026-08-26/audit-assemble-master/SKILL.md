---
name: audit-assemble-master
description: "Audit chain — FINAL: assemble the master report + produce the client-safe version. Stitch all sections (00–13) into one deliverable, then strip internal/sensitive material for the client-facing copy. Read audit-foundation first."
triggers: ["assemble master", "master report", "client version", "strip sensitive", "final deliverable", "client-safe"]
---

## Client-facing output discipline (EVERY client — OCG, Logic TCG, MSIA, all)
This deliverable goes to the client. Apply `audit-foundation` › CLIENT-FACING VOICE before writing a word:
- **Objective only.** State facts the client cannot argue with. No editorializing, no superlatives or ranking, no descriptive adjective added for effect. Walking one back means DELETING it, not softening it ("#1" → "most time-consuming" is the same error).
- **Titles/headers = one plain statement.** No second clause, no `—`/`→`/`;` tail, no cost/cause/quote/parenthetical/adjective in a title; detail goes in the body fields.
- **Deduplicate.** One problem = one entry across all instances ("source attribution not tracked" is ONE item covering every channel, not one per channel). Don't split into per-instance copies; don't merge unrelated facts into one entry because you decided they relate.
- **No internal/process language.** The client never sees how we found it: no "re-scan," "re-attributed," "supersedes," our internal cluster/grouping names, or notes to Josh. Reframe natively under the client's own categories and names.
- **Facts in fields; quote only when genuinely necessary; "Not quantified" beats an invented figure or characterization.**
- **Josh ≠ the client.** Josh directs the work; the deliverable is FOR the client. Never address Josh as the client or write "your" meaning the client's.


# Assemble Master + Client Version (FINAL)
**Goal:** the assembled deliverable (OCG had `OCG-Busywork-Audit-MASTER.html`) + a **client-safe version** (OCG had `CLIENT-VERSION-STRIP-PLAN.md`). Reference: `~/code/auditos/reports/ocg-deliverable/` (the MASTER.html + CLIENT-VERSION-STRIP-PLAN.md + client/ folder). Read `audit-foundation`.

## ⛔ MECHANICAL GATE — run this script, don't rely on reading a checklist (Josh, 2026-07-30)
A prose checklist can be skipped by not reading it carefully — that already happened once (Studio PCH shipped with 2 of 4 required diagram types before this gate existed). This is now a required, scripted step, not a memory aid:
```bash
python3 ~/code/cortextos/orgs/clearworksai/agents/auditmaster/plugins/cortextos-agent-skills/skills/audit-assemble-master/scripts/assembly-check.py <client-slug>
```
It checks: all 4 standard diagram types present, swimlane count matches the workflow-maps source, and final PDF page count against the MSIA 99pp reference (fails if under 50% with no justification). **Run it and get a PASS before telling Josh assembly is done — a FAIL means it isn't, regardless of how complete it feels.** If a check can't apply to a given client (e.g. no ROI section because it's a reference deck, not a sales proposal), that's a stated exception to confirm with Josh, not a reason to skip the gate.

## ⛔ HARD RULE — never shorten, never summarize away real content (Josh, 2026-07-30)
The master assembly is the FULL depth of every section that exists, not a condensed digest. Violating any of these is a redo, not a style note:
- **Every section in FULL, start to finish** — every named pain point, every integration gap, every workflow, every solution cluster, every KPI, with its real citation. Theme-summarizing a list ("8 pillars of pain") instead of listing every item is under-delivering, not concision.
- **Every diagram type gets embedded, not just one kind.** A client audit typically has: current-state system connection map (phase 3), current+future architecture diagram (phase 6/13), and per-workflow swimlanes (phase 5) — check what diagram types this engagement actually produced and embed ALL of them. If a diagram was only ever sent via Telegram/chat and never saved to the repo, that is a GAP — locate/rebuild it before assembly, don't silently ship without it.
- **Every real photo/visual asset sourced this engagement gets used**, not cited-but-omitted. If real client photography was pulled (e.g. from the client's own site), it goes IN the document, not just referenced in an appendix.
- **Match the reference deliverable's real depth**, not an arbitrary shorter draft. Before calling assembly done, check the actual page/word count of the gold-standard reference for this client tier (e.g. `wc -w` the source, check page count of a comparable prior client's branded PDF) and confirm you're in the same range — don't ship something a fraction of the size without flagging exactly why (source material genuinely thinner) rather than quietly shipping short.
- **Never delegate the assembly structure to an unbriefed subagent.** If using a subagent for assembly, the subagent's prompt MUST include this hard rule + the checklist below verbatim, not a paraphrase — an unbriefed subagent will default to conservative brevity and skip diagrams it doesn't know to look for.

## Assembly checklist (run before calling it done)
- [ ] Every deliverable section 00 through the last one that exists is represented in FULL (not summarized), each with its real content and citations.
- [ ] Every diagram TYPE produced this engagement is embedded (connection map, architecture diagram, swimlanes per workflow) — cross-check against what was actually built/sent during the engagement, not just what's already saved to disk.
- [ ] Every real photo/visual asset sourced for this engagement is embedded, not just cited.
- [ ] Cover page and every page with text over an image has sufficient contrast/scrim — visually verify (render to image via `pdftoppm` and inspect, or check computed contrast) that no title text disappears into a photo background.
- [ ] Word/page count checked against a comparable reference deliverable for this client tier; any shortfall is explained explicitly to Josh, not silently shipped.
- [ ] Any name/role anonymization convention already locked for this client is applied consistently across BOTH the prose AND any diagram images (a common miss: diagrams keep real first names while prose uses role tags).

## Build
1. **Assemble** the full deliverable from the sections in order (00 anchor → 01 atlas+appendices → 03 systems → 04 gaps → 04a AI operating environment and adoption → 05 workflows → 13 architecture → 02 solutions → 06 ROI → 07 roadmap → 08 KPIs → 09 pricing) — using whichever of these sections actually exist for this client (e.g. no ROI/pricing if this is a reference deck, not a sales proposal — confirm with Josh, don't assume). One coherent document (markdown → HTML/PDF for the client).
2. **Client-version strip plan + strip:** produce a `CLIENT-VERSION-STRIP-PLAN.md` listing exactly what is removed/softened, then the client-safe copy in a `client/` subfolder. **Remove ALL of `_SENSITIVE-internal-notes.md`** content: named personnel/termination plans, leader-on-leader criticism, anything the interviewer said to cut, sharp personal remarks. Replace sensitive citations with the neutral equivalents already noted in the atlas.
3. **De-identification guard (grep before ship):** beyond removing `_SENSITIVE`, some legitimate pains carry *de-identified* criticism (e.g. "two key staff whose information I don't trust"). Keep the pain, but `grep` the client copy to confirm no name is ever attached to a distrust/criticism/termination line — and that no specific person is re-identifiable from context (role + count can fingerprint someone in a small org). Drop `_RATES-internal.md` and any individual comp entirely; ROI shows savings only, never a person's salary. Also exclude internal nav/working docs (INDEX, `01`/`02` anchors, source extracts) from the client package.
4. **Final Rule Zero pass:** every client-facing claim still traces to a non-sensitive source; nothing fabricated; both/and intact; no over-sell.
5. **Lock with Josh** before anything goes to the client (external communication — always his call).

## Done when the master assembles all sections IN FULL per the hard rule above, every diagram type + real photo is embedded, the assembly checklist is complete, the strip plan documents every redaction, the client copy is clean of sensitive material, and Josh has approved the client version.
