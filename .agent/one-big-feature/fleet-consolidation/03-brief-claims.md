# The brief (Fleet Knowledge Map, made 2026-07-02 = YESTERDAY) — treat as CLAIMS to test against the transcripts, not as truth

12 tabs: System Map; Per-Agent I/O; The Holes (8); The Plan (5 phases); CRM Deep Dive; RAG Deep Dive; Stores & Crons; Knowledge Graph; Reliability Gaps; Instances & Consolidation; Failure Patterns; Two Dashboards.

## The 8 Holes it claims
H1 extracted facts never embedded into ChromaDB; H2 semantic KB frozen (kb-ingest heartbeat disabled 2026-07-02); H3 two CRMs no reconciliation; H4 two RAGs no sync; H5 verify-before-claim is willpower not mechanism; H6 handoff fidelity lossy (written ~85% context, tail lost); H7 identity fragmented across 4 namespaces; H8 dead ends — wiki unread, graph never re-indexes, tasks in 3 silos.

## Reliability Gaps R1–R8
R1 handoff fidelity; R2 verify-before-claim enforcement; R3 source-of-truth conflict resolution; R4 identity resolution; R5 fail-loud when store unavailable; R6 observability (what agent DID vs CLAIMED); R7 single points of failure; R8 no memory-correctness test harness.

## Failure Patterns P1–P7
P1 "fixed/live" claimed without verifying running artifact; P2 dashboard rebuilt ~4x keeps regressing (two write-paths, blind full-state PUT); P3 scope compression at dispatch; P4 memory lost at handoff tail; P5 comms dedupe false-positive (byte-hash not source-event); P6 hand-patching recurring bug N times; P7 parallel system built on unverified premise (fleet CRM/MMRAG vs Clearpath).

Governing principle of the brief: CERTAINTY — no claim without a live check against raw reality.

## Where the brief is already WRONG vs live reality (verified this session — proof the brief needs testing, not trusting)
- Its "RAG dimension mismatch (1536 vs 3072)" is FALSE — schema and code are both 3072.
- Its "wiki is a write-only dead end" is FALSE — the wiki is already published online behind login (372 articles), just stale since 2026-06-11 with no re-publish cron.
