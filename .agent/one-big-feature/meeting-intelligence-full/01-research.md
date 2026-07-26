# Research — meeting-intelligence-full (the 6-piece meeting mega-build + CRM/cxportal sync)

Date: 2026-07-26. Synthesized from two already-existing, already-approved sources — no new research performed, this file composes them for the OBF pipeline's required `01-research.md` slot.

## Source 1 — `.agent/one-big-feature/meeting-followup/01-research.md` (Fable, 2026-07-25, live-state-verified)

That doc's findings, reproduced by reference (see the file itself for full detail — not duplicated here to avoid drift):
- What EXISTS and is LIVE: Fireflies extractor (`frank2/scripts/ff-extractor.py`, 3 modes), commitments surfacing (live 2h cron), recap Gmail draft (live cron, delivery broken separately), transcript scanner (live, unrelated), the writer (`meeting-intelligence-engineer` Step 4 — manual only, NOT cron-wired), kb-dream skip tracking (merged), orphan audit (live but structurally blind), Fireflies webhook (deployed in `~/code/briefs`, unwired from delivery).
- THE GAP: no automation calls the writer; two downstream consumers (overdue-chase, orphan-audit) read empty `knowledge/meetings/` + `knowledge/clients/` stores every 2h; the wiring task was queued and never executed; recap delivery separately broken (gws-dwd missing `+draft`, already dispatched elsewhere).
- Reuse verdict: compose existing pieces (extractor, commitments surfacing, recap draft cron, writer schema, worker skeleton, conditional-spawn wiring pattern already proven in `pre-meeting-brief-page`) — new pieces are 1 SKILL.md + 1 small extractor flag + 1 cron-prompt edit.

## Source 2 — Google Doc `1TA9bZpm6l6Rc2p8O2K9Oz7N8b1iqpk-kyWIvIsEkBGI`, §4 (target architecture) + §8 (CRM/cxportal sync gap)

Fetched 2026-07-26 via Google Drive MCP (`read_file_content`), full doc read to `/tmp/gdoc-plan.txt` (55,079 chars), sections 4.1–4.6 (lines 417–486) and §8 (lines 1292–1299) read in full and reproduced verbatim in `02-master-plan.md`'s SCOPE_LOCK table and in each of `03-specs/01`–`07`. Root-cause framing (Doc lines 60–93): two independent Fireflies pipelines (frank2's poller + crm agent's `fireflies-ingest.py`) persist to two private flat-file stores; the actual product database (cxportal's 14-table Meetings Hub, PR #42) receives nothing; 55 real meeting files sit in `crm/meetings/`, invisible to pa/frank2's crons that read the empty `knowledge/` dirs instead.

The Doc's target architecture (§4) is one pipeline, one owner, seven stages: Capture (4.1, webhook) → Context load (4.2) → Extract (4.3) → Relevance+dedup (4.4) → [Store+track (4.6) / Draft (4.5) / Follow-up]. §8 is a same-day addendum (2026-07-25) flagging that 4.6's cxportal DB write has no defined sync contract back to CRM — a genuine open design question, not yet answered by the Doc itself.

Doc's own recommended build order (§5 "smallest first build," lines 493–529): build the context layer (4.2) first — "every downstream complaint is fed by the context-free extractor" — NOT the webhook (4.1), NOT the PM sync (4.6), NOT the trust ladder (4.5).

## Reconciling the two sources — why this run's dispatch order differs from the Doc's own §5 recommendation

Josh's task instruction for this run explicitly named "wiring the meeting-intelligence-engineer Step4 writer to an actual cron" as the highest-priority piece to dispatch first, citing the prior incident diagnosis (`incident_meeting_intel_writeback_built_never_wired_2026-07-25`). That directive overrides the Doc's own §5 ordering for THIS run's first dispatch only — see `02-master-plan.md`'s "Known-gap cross-reference" section for the full rationale (smallest, most mechanical, most already-proven shard; unblocks two already-live downstream consumers). All other pieces (01–05, 07, 06b) retain the Doc's own recommended sequencing for follow-up dispatch.

## Verified live facts used in the specs (2026-07-26, re-verified independent of both source docs)

- `orgs/clearworksai/knowledge/meetings/` = README.md only; `orgs/clearworksai/knowledge/clients/` = `_template.md` only — zero real files, confirmed live.
- `orgs/clearworksai/agents/crm/crm/meetings/` = 55 real `.md` files, confirmed via `find`.
- `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py`: `ACTION_ITEMS_PROMPT` at line 86, `refine_items` at line 716, `run_full` at line 1112 (no ledger param today), `--recap-ledger` pattern at line 906 (the flag to mirror for a new `--full-ledger`).
- `pa/crons.json`: `meeting-commitments` (2h, spawn-worker pattern, fire_count 477), `meeting-recap-draft` (4h, bare prompt NOT spawn-worker-wrapped, fire_count only 3), `pre-meeting-brief-page` (15m, conditional-spawn pattern to mirror for the writeback wiring).
- `~/code/briefs`: `src/briefs.ts:2551` webhook route + `:169,172` config fields already exist, deployed via PR #24, just unregistered/unwired from the two pollers.
- `~/code/lifecycle-killer` (cxportal): `migrations/0009_meetings_hub.sql` — Meetings Hub schema shipped PR #42 (+#43 admin meeting-detail endpoint, +#44 seed data).
