# Research — meeting-recap-draft-worker

## Task
Agent-side cortextOS worker skill that auto-drafts a post-meeting recap + next-steps email as a Gmail DRAFT (never sends). NOT a cxportal app feature (Josh corrected twice). planner=fable (Josh explicit via frank2).

## Source files read (evidence)
- `orgs/clearworksai/agents/pa/.claude/skills/meeting-commitments-worker/SKILL.md` — closest sibling. Short-lived worker: task create/complete, `update-cron-fire`, dedup ledger in `state/`, env sourcing `set -a; source frank2/.env; source secrets.env; set +a`, DEGRADED guard when ingest env missing, `cortextos terminate-worker "$CTX_AGENT_NAME"`, literal `DONE`, SILENT-OK. Fireflies touched ONLY via `ff-extractor.py`.
- `orgs/clearworksai/agents/pa/.claude/skills/transcript-scanner-worker/SKILL.md` — second sibling; append-only dedup ledger keyed by source id, md5 fallback pattern.
- `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` — the single fleet Fireflies touchpoint. Findings:
  - `TRANSCRIPT_FIELDS` (35-61) already fetches `title`, `date`, `organizer_email`, `participants`, `summary{overview,shorthand_bullet,action_items,keywords}`, `sentences`. `run()` emits only commitments — a recap emit path needs NO GraphQL change.
  - Noise gate constants at 136-151: `VAGUE_ACTION_PREFIXES`, `SUPPRESSED_NAMES` (Marcos/Santa Ana hard-no), `GENERIC_OWNERS`. Applied inside `refine_items` (691-725) via `has_concrete_action`, `is_suppressed`, `refine_inbound_item`.
  - `save_watermark` (286-307) advances `state/ff-extractor-watermark.json` — the sibling commitments-worker depends on it. A recap mode MUST NOT touch it or POST, or it starves that worker's freshness window.

## Reuse decision
Add an additive `--recap`/`--recap-ledger` flag to ff-extractor.py (keeps it the single Fireflies touchpoint; a sibling importer would need an importlib shim because of the hyphenated filename). Recap mode never reads/writes the watermark and never POSTs; freshness comes from the worker's own read-only dedup ledger. Noise gate reused by function call, not copy.

## Output contract
Worker session composes recap + next-steps and calls Gmail MCP `create_draft` (self-draft to weissjosh0@gmail.com, never send). Dedup ledger `frank2/state/meeting-recap-drafts-surfaced.txt`, append-only, script read-only, worker appends only after draft success.
