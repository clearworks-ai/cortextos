# Brief: Brain source-to-state loop (one meeting, end to end)

Status: APPROVED (Josh, 2026-09-04 21:25 PDT — premises P1–P3 + board G1–G8 locked in chat)
Source: knowledge-sync/raw/areas/clearworks/brain-recovery-audit-2026-09-04/00-DELIVERABLES-A-G.md (E, F, C)
Repo: ~/code/cortextos @ feat/cortextos-backup-dr (deployed branch). Vault: ~/code/knowledge-sync.

## Premise
A Fireflies meeting arrives → durable transcript → bounded Claude extraction (schema-validated in code) →
deterministic home resolution (client/prospect/vendor/person; create the page if new; never ask Josh) →
sourced History line on exactly one canonical org-brain page (project node if one resolves) →
derived views regenerate (client roll-up, STATE.md) → commit SHA is the receipt →
three projections off the same validated JSON: Gmail recap draft, CRM interaction, commitments → bus tasks →
status-update draft from canonical state. Manual first run on one real meeting; no cron, no new DB/daemon/agent.

## What exists (scouted 2026-09-04)
- Fireflies fetch: `orgs/clearworksai/agents/pa/scripts/ff-extractor.py` `fireflies_graphql()` :845 — but every mode calls `require_env("OPENROUTER_API_KEY")` (:1875/:2182/:2255) → dead since Aug 25; no fetch-only path.
- Writeback: `pa/scripts/meeting_writeback.py --payload <json>` — lockfile :40, History prepend :452, dedupe :466; slug-guess writer `guess_client_file` :227-284 (the genesis-gold-group bug). Reads/writes `ORG_ROOT/knowledge/{meetings,clients}`; `orgs/clearworksai/knowledge` → symlink to org-brain.
- Gmail draft: `pa/scripts/meeting_recap_draft.py --payload --ledger` → `gws gmail +draft --to --subject --body` (draft-only by design).
- CRM: `orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py --event-file <json>` → `add-interaction.py` → `interactions.jsonl` (dedupe source_ref+contact_id).
- Tasks: `crm/crm/meeting-fanout.py --event-file` → `cortextos bus create-task <text> --assignee --due` (dedupe via `bus event-dedup`); loads meeting via `ff-extractor --mode full` unless `Deps.load_full` seam is fed.
- Report: `src/bus/delivery-status.ts` pure engine (`buildStatusReportPlan` :489, 13 unit tests); its CLI `delivery-status-plan` removed in `013de1e8`.
- Worker: `cortextos spawn-worker <name> --dir --prompt --parent --model` (Claude Code session; exit code = status). Parent = `pa-codex` (pa is disabled).
- Org-brain: `clients/` (34) + `_template.md`, `meetings/` (199), STATE.md stale since 08-10. `projects/`, `orgs/` do not exist.
- CRM closed sets: `crm-codex/crm/org-aliases.json` (5), `contacts.json` (516), `contact-aliases.json`.

## Locked decisions
- D-01 Canonical = org-brain markdown; new dirs `projects/` (kind: engagement|project, parent:) and `orgs/` (kind: org|person, relationship:). STATE.md derived, never authoritative. (settled, Josh)
- D-02 Every meeting gets a home, system decides; unknown domain → create `orgs/<domain-slug>.md`; `unknown` illegal; no question to Josh. (settled, Josh)
- D-03 Projects not deal-born; Client → Engagement → Project; Alloi seed = alloi-01 MS, alloi-02 IT block, alloi-03 Tactical Reports (parent alloi-01, aliases tacticals…). I write the seed; Josh reviews diff. (settled, Josh)
- D-04 New scripts at REPO level (`scripts/brain/`), never under `orgs/clearworksai/agents/*`. Existing scripts reused in place. (settled, Josh)
- D-05 Transcript durability = vault `raw/media/transcripts/fireflies/<id>/source.json` + sha256, git-committed. (settled, Josh)
- D-06 Extraction = one `spawn-worker` (Claude, Sonnet-5-class) with explicit input path + sha + output schema; validated in code. (settled)
- D-07 Gmail draft, CRM interaction, commitment→task are IN SCOPE as deterministic projections; out: Chroma, wiki, Mission Control, Telegram notify, lifecycle projection. (settled, Josh)
- D-08 Ladder promotion allowed from transcript evidence with verbatim quote in the History line. (settled, Josh)
- D-09 Review gate = terminal `--dry-run` diff, then `--apply`. (settled, Josh)
- D-10 Branch: worktree `brain-loop` → PR into `feat/cortextos-backup-dr`. (directive, coordinator)
- D-11 Acceptance meeting = fireflies 01M1MW2GAZ1DQ0C6PG3KJ557JA "Alloi Tacticals Troubleshooting" 2026-09-04 → alloi → alloi-03 via alias; negative case = unknown-domain meeting → new orgs page. (settled)

## Non-goals
Cron/scheduling; any daemon change; the 13 unpromoted `meeting-*.ts`; Chroma; wiki; Mission Control; Telegram send; sending email.

## Success evidence
All 18 rows of deliverable F pass on the acceptance meeting, twice (idempotent), with the daemon stopped, plus: one Gmail draft exists, one interactions.jsonl row with `source_ref: fireflies:<id>`, N task files with owner+due (N = commitments with owners), one status-update draft — all traceable to the same extraction sha.

## Roast verdict

**RESHAPE** · confidence high · 2026-09-04 · mode=code
Biggest risk: resolver closed-set is thin (org-aliases 5 rows); real key = attendee email → contacts.json (516).
Cheapest 48-hour test (probe): `meeting-crm-sync.py --event-file` with FF_EXTRACTOR unset writes a degraded row → ledger G-01
Cheapest 48-hour test (demo): `--dry-run` human diff on fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA signable without edits → D-12
Binding pivots: (1) no spawn-worker — direct Anthropic call from scripts/brain/; (2) one adapter emits writeback payload + event + full-mode meeting, feeds crm-sync/fanout via load_full seams, computes stable commitmentIds; (3) meeting_writeback.py whitelist rebuild (:471-500, verified) replaced by section-preserving prepend; (4) quote substring-check vs source.json, client-owner commitments never become tasks, free-mail domains never become orgs/ pages. Two receipts: knowledge-sync SHA (org-brain + transcript) and cortextos SHA (interactions.jsonl + tasks).
Scores: Constitution 6/10 · YAGNI 8/10 · Contrarian 4/10 · Code-Researcher 5/10 · Operator 7/10
