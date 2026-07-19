# 01 — Research: `industry-resource-map` skill (AEC-only MVP)

## Problem

Every muse research/content session re-discovers the same internal + external resources from
scratch: `find /` for the notebooklm binary, grep-hunt for the Alloi audit and
marketing-intelligence-v3 by hand, `notebooklm status` to learn a notebook was already wired as
context. Josh watched a full session of this manual rediscovery and asked for it to become a
one-time-built, reusable index per vertical — NOT ad hoc rediscovery every session.

This is the architect plan produced by muse (handoff `handoff-2026-07-18T23-24-50Z.md`), captured
here verbatim in intent as the research grounding for the OBF build.

## What already exists (do NOT rebuild)

- **`research-pulse` skill** (`orgs/clearworksai/agents/muse/.claude/skills/research-pulse/`):
  SKILL.md + scripts (`pulse_registry.py`, `discover.py`, `seed_notebook.py`, `backfill.py`) +
  templates + tests. Owns curated recurring EXTERNAL sources and the delta cron.
- **research-pulse registries**: `orgs/clearworksai/agents/muse/state/research-pulse/registry/{aec,nonprofit,ocg}.json`.
  Strict schema for pollable external sources (feed_url required, fixed source_type vocab). The
  `research-pulse-delta` cron depends on that shape.
- **`research-pulse-delta` cron**: polls the AEC/nonprofit/ocg external-source registries
  independently. Exists already; unaffected by this skill.
- **NotebookLM AEC Pulse corpus**: notebook id `7f3b85b7-5adc-4869-ace9-7e056354f4eb`; binary NOT
  on PATH at `/private/tmp/whisper-venv/bin/notebooklm` (ref memory
  `reference_notebooklm_aec_pulse_corpus.md`).
- **Clearworks positioning corpus**: marketing-intelligence-v3.md (v3 is current, no v4), Alloi AI
  Operations Audit, "integration failure not tool failure" thesis + Divergence Test
  (ref memory `reference_clearworks_integration_failure_positioning.md`).

## Why a NEW skill, not a research-pulse rewrite

research-pulse's registry has a strict pollable-external-source schema (feed_url required, fixed
source_type vocab) the delta cron depends on. Internal docs (client audits, positioning docs,
distilled memory, notebooks, resolved tooling paths) don't fit that shape and must NOT be forced
into it. `industry-resource-map` reads the research-pulse registry BY REFERENCE and adds an
internal-resource layer on top — it never duplicates or rewrites the registry.

## Core design (from architect plan)

1. **New skill, sibling to research-pulse.** Reads research-pulse registry by reference.
2. **Data model:** one manifest per vertical at
   `orgs/clearworksai/agents/muse/state/resource-map/<vertical>.json`. References research-pulse's
   registry path + notebook_id; adds an `internal` block:
   - `client_audits[]`
   - `positioning_docs[]` (marketing-intelligence-vN, latest flagged)
   - `research_docs[]` (ad hoc under `~/code/knowledge-sync/raw/areas/clearworks/research/`)
   - `memory_refs[]` (muse distilled memory files)
   - `notebooks[]`
   - `live_search[]` (last30days query patterns that returned signal, with date)
   - `tooling{}` (resolved binary paths — e.g. the notebooklm CLI location, so `find /` never
     happens again)
3. **Internal discovery:** glob the known doc roots + keyword-score against vertical name and tag
   vocab. NO hardcoded per-client paths. Ambiguous matches surfaced for human yes/no, never
   auto-included.
4. **Composition:** research-pulse keeps owning curated recurring external sources + the delta
   cron, unchanged. last30days stays a knox-subagent-only dispatch (existing muse CLAUDE.md hard
   rule), unchanged — this skill just remembers which queries returned signal. No new cron for v1.
5. **Stale-data awareness (Josh hard requirement):** the skill must be AWARE of the
   `research-pulse-delta` cron and be able to ASK it to refresh when the registry data is stale —
   never assume the registry is current. (Mechanism: read registry freshness metadata; if stale,
   trigger/announce a delta refresh before composing the map.)
6. **Skill flow mirrors research-pulse Step 0-7:** preflight (resolve tooling) → define vertical →
   pull external (read registry, check freshness, request delta if stale) → discover internal
   (glob+score) → curate (human confirm) → record live-search patterns → write manifest +
   human-readable `.md` twin → report (counts, paths, notebook link, gaps).
7. **MVP scope: AEC only** — the hot/live vertical. Prove the pattern with one build. Later
   (out of scope): auto-refresh cron, client-to-vertical tagging automation, feed manifest into
   NotebookLM, cross-vertical dedup.
8. **Stays manual by design:** which internal docs are relevant (match proposes, human confirms),
   last30days query wording quality, external source curation (already manual in research-pulse).

## Open scope question — resolved before dispatch

- **Plan engine:** Josh confirmed "K3" (kimi-k3). BLOCKER discovered: plan/specs are
  provenance-authored stages requiring a Claude-subagent transcript under `~/.claude/projects`;
  kimi-k3 runs via the Opencoder bus worker and cannot produce a signable transcript. PR #119
  wired K3 as a routing choice only; the provenance bridge was never built. Fork surfaced to Josh:
  (A) plan with opus now + file the K3→provenance bridge separately, or (B) build the bridge first.
  Research stage is provenance-independent and identical on either path — authored now.

## Acceptance shape (feeds the plan/specs stage)

- New skill dir `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/` with SKILL.md
  + scripts + tests, mirroring research-pulse structure.
- Manifest writer producing `state/resource-map/aec.json` + human-readable `aec.md` twin.
- Reads research-pulse `registry/aec.json` by reference (path + notebook_id), never mutates it.
- Freshness check + delta-refresh request path against the research-pulse-delta cron.
- Internal discovery = glob known roots + keyword-score; ambiguous → human confirm, never
  auto-include; no hardcoded per-client paths.
- Tests covering: manifest schema, registry-by-reference read, freshness/stale-detection, internal
  discovery scoring, human-confirm gating.
