# Verified live system facts (checked this session, 2026-07-03). Trust these over the brief where they conflict — but note where they conflict with Josh's DECISIONS.

## Knowledge / RAG stores (the thing to consolidate into ONE reliable indexed system)
- **MMRAG** (ChromaDB, Gemini Embedding-2, 768 dims): LIVE, ~6,478 docs indexed. Upstream-native (kb-query / kb-ingest). Recently hardened: content-hash embedding cache + resumable checkpoints, atomic rebuild, bounded timeouts (PRs #34–37). BUT: the kb-ingest heartbeat was disabled 2026-07-02 over corruption risk, and it was silently CRASHING on a schedule (spawnSync ETIMEDOUT on mmrag.py) while the cron wrapper reported exit 0 — a false-success. Not embedding extracted daily facts.
- **knowledge-sync vault** (Karpathy RAG: raw/ → wiki/ → outputs/): 352–372 wiki articles synthesized by wiki-synthesis.py; wiki is READ-ONLY to agents. Wiki IS published online behind login at the briefs host, but STALE since 2026-06-11 (no re-publish cron). A `_quarantine-2026-07-02/` dir exists.
- **Clearpath Intelligence** (Postgres pgvector, Gemini embedding-001, 3072 dims): technically LIVE (51,158 extractions, 26,620 vectors, 651 contacts updated via email today), BUT Josh has DECIDED to move off it (old/stale; Fireflies→meeting sync frozen since 2026-04-08). Do NOT propose it as the store. It is context, not the answer.
- **claude-mem**: runs but is vestigial; search system was removed. Josh flagged it as unused.
- So the live "which RAG / which knowledge-sync" reality: converge on **MMRAG + knowledge-sync (upstream-native)**, retire Clearpath-as-store and claude-mem, and make the ONE stack reliably ingested + indexed + retrievable.

## Instances
- cortextos1 is the LIVE canonical instance (daemon PID 68094, ~23h uptime, launched --instance cortextos1). `default` is DEAD (frozen Jun 25) yet is the CODE DEFAULT (paths.ts:28, status.ts:12) — bare `cortextos` commands hit the dead instance. 440x state divergence. ALL hot state (crons, tasks, memory, KB) under cortextos1 is OUTSIDE git — single copy, no backup. Stray fragments: frank2/, frank2-state/, state/, stale chromadb.bak/.old/.archived.

## Dashboards / remote surface (goal #2)
- **Briefs** (briefs.clearworks.ai, Railway) = the surface Josh actually uses. Holds its OWN state copy on a /data volume; PUT /api/tasks does a BLIND full-state overwrite (briefs.ts:2357) → a stale browser tab reverts tasks. This is the "Rody/Amara tasks come back, Today cleared" bug he hit Jun 26 → this morning. CRM path there was already fixed with merge-by-id; the tasks path was NOT. Existing (unmerged) specs: dashboard-markdone-bus-writeback, crm-board-durable-persistence.
- **Built-in Next.js dashboard** (cortextos/dashboard): reads the LIVE bus directly (no second copy → stale-overwrite impossible) but is localhost-only; remote deploy needs the fleet filesystem reachable from Railway (big lift).

## Code shape (fresh graphify today: 1,132 nodes / 1,866 edges / 83 communities)
- Structural hub = the DAEMON (FastChecker, AgentProcess, AgentManager). Second center = MMRAG KB engine (mmrag.py). Full report at /Users/joshweiss/code/cortextos/graphify-out/GRAPH_REPORT.md.

## Config-vs-live drift (recurring root cause)
- Agent config.json (git, docs) vs crons.json (live) diverge: Muse's Jun 25 constitution rewrite never propagated to crons (a week undetected); agents read config.json (docs) instead of live crons.json.
