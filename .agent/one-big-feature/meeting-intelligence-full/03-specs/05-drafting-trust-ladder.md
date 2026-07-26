# Spec 05 — §4.5 Drafting: graduated autonomy, and actually fire

**Repo:** `/Users/joshweiss/code/cortextos`
**Status this run:** materialized, NOT dispatched.

**Source (verbatim, Google Doc §4.5):** "Fix the cron first: change meeting-recap-draft cron to spawn-worker exactly like meeting-commitments. This alone takes it from 2 fires to reliable. Give the draft client_context + voice.md so it references the real relationship, not a transcript dump.

3-level trust ladder:
- L1 (default, all): client-facing recaps -> Gmail draft, Josh reviews/sends.
- L2 (conditional auto-complete): internal recaps + low-risk followups, confidence >0.9 -> auto-file without a draft.
- L3 (never auto-send list): hardcoded VIP/client list — never auto-send under any confidence."

## Verified live

- `pa/crons.json` cron `meeting-recap-draft`: `schedule: 4h`, `enabled: true`, but `fire_count: 3` and prompt is a bare `Read .claude/skills/meeting-recap-draft-worker/SKILL.md and follow its instructions.` — NOT wrapped in the `spawn-worker` conditional pattern that `meeting-commitments` uses (`spawn-worker "meeting-commitments-$(date +%s)" --dir ... --parent frank2 ... --prompt "Read .claude/skills/meeting-commitments-worker/SKILL.md and execute it exactly...`).
- Known separate, already-dispatched bug (per research doc, do NOT re-scope into this spec): delivery is broken because `gws-dwd` only implements `+triage`/`+read`, no `+draft` — tracked as `task_1784959165410_09349370`, memory `incident_recap_draft_gws_dwd_missing_send_2026-07-25`. This spec's "fix the cron" scope is the SPAWN-WORKER wrapping, not the gws-dwd `+draft` gap — do not duplicate that already-in-flight fix.

## Build

1. **Cron fix**: rewrite `meeting-recap-draft`'s cron prompt to the same `spawn-worker` pattern as `meeting-commitments` (self-contained short-lived worker, no bootstrapping/heartbeat/prose, `terminate-worker` self-cleanup on completion) — this alone, per the Doc, "takes it from 2 fires to reliable."
2. **Context injection**: give the recap-draft worker spec 02's `client_context` + `voice.md` (locate existing voice/brand file — check `orgs/clearworksai/knowledge/` or agent-level config for an existing `voice.md` before creating one) so drafts reference the real relationship instead of a raw transcript dump.
3. **3-level trust ladder** (new logic in the recap-draft worker):
   - L1 (default, ALL recap types): client-facing recaps → Gmail draft only, Josh reviews/sends manually. This is the current/only behavior today — becomes the explicit default tier.
   - L2 (conditional auto-complete): internal recaps + low-risk followups, confidence > 0.9 → auto-file without a draft (no human review). Needs a confidence-scoring mechanism — not specified further in the Doc; flag as an open design question for the build (candidate: reuse or extend spec 04's relevance-scoring machinery).
   - L3 (never-auto-send list): hardcoded VIP/client list — NEVER auto-send regardless of confidence, even under L2. Needs the actual VIP list defined (Josh's call — do not invent names; ask at build time or check `knowledge/company.md`/CRM for an existing VIP flag).

## Test plan

- Cron fix: confirm `fire_count` climbs reliably post-change (compare pre/post fire cadence over several cycles) instead of stalling at low counts.
- Trust ladder: unit tests for tier routing (L1 always drafts+waits; L2 only auto-completes above the confidence threshold AND not on the L3 list; L3 always drafts+waits regardless of confidence).
- Regression: existing recap content/quality unaffected by the client_context/voice.md injection (spot-check against Doc's own the-humanizer / brand-voice conventions if applicable).
