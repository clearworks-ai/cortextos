# Deep pass: src/daemon/handoff-backping.ts (FORK-ONLY, 59 lines — no upstream counterpart)

Analyzed: 2026-08-02 (M1 backfill). `git show upstream/main:src/daemon/handoff-backping.ts` → does not exist. Lineage: back-ping dedup commits `6b7fb16`/`9ecaebc`/`078a9a3` 2026-07-11..16 (SHAs unverified per band-aid table; file confirmed fork-only).

Purpose: pure-function suppression window for handoff "back online" Telegram pings — extracted so it is unit-testable.

## Findings

- **API:** `shouldSuppressBackPing()` (:26-31) — suppress only when a prior ping exists, the 10-min window (`HANDOFF_BACKPING_SUPPRESS_MS`, :5) has not elapsed, and no newer inbound message arrived after the last ping. All three allow-paths short-circuit first — fails open (never suppresses a legitimately new back-ping).
- **State:** one marker file per agent (`state/<agent>/.last-back-ping`, :33-35). `readLastBackPingMs` (:38-48) returns null on missing/unreadable/NaN — fail-open again; `writeLastBackPingMs` (:50-59) is best-effort, swallow-on-error, `mkdirSync recursive` first. No locks, no growth, no timers, no subprocesses, no secrets.
- **Callers:** `agent-process.ts:19-22` (import) and `:1086-1088` — evaluated only at the back-ping emission site. Not on any spawn/exit/supervision path.
- **Known context (MEMORY, incident_backping_dupe_two_emitters_root_cause):** the historical dupe was TWO emitters with only one gated — an agent-process wiring issue, not a defect in this module's logic.

## Verdict: EXONERATED (now with a written trail) — BAND-AID, cheap and safe

Classification stays BAND-AID per the band-aid table: three commits of dedup machinery exist only because fork churn restarts agents often enough for back-ping spam to hurt. Zero instability contribution of its own. Retire in Wave 6 ("handoff-backping dedup" is first in the retirement order) once churn is at upstream levels; no code change needed now.
