# Adversarial Review — Weekly Hooks Audit

Generated: 2026-08-10 08:24 PDT
Status: AWAITING APPROVAL

## Verdict

**NEEDS MORE RESEARCH before implementation.** Six HIGH issue clusters are sufficiently proven for operational reporting, but the approval-policy choice and several cross-layer lifecycle designs need explicit decisions and captured runtime contracts before code changes begin.

## Root Causes (Architect Consensus)

| Area | Root Cause | Confidence | File:Line |
|---|---|---|---|
| Wrong plan selection/disclosure | ExitPlanMode reads obsolete `plan_file` and falls back to the newest plan in a shared global directory | High | `src/hooks/hook-planmode-telegram.ts:32-49,112-121` |
| Telegram decision integrity | Ask and permission callbacks lack durable request/session/message binding and one-shot consumption | High | `src/hooks/hook-ask-telegram.ts:53-76`; `src/daemon/fast-checker.ts:915-976` |
| Crash classification/delivery | Persistent unscoped rate-limit text can reclassify later crashes; delivery errors are ignored and dedup precedes delivery | High | `src/hooks/hook-crash-alert.ts:67-92,163-179,352-380,507-515` |
| Fact extraction | Bus command absent, templates omit registration, and implementation expects fields current PreCompact does not emit | High | `src/hooks/hook-extract-facts.ts:22-27,78-139`; `src/cli/bus.ts:4569-4612` |
| Cron provenance | `.cron-active` is removed immediately after enqueue, before turn hooks execute | High | `src/daemon/agent-manager.ts:1319-1337,1419-1448` |
| Retrieval correctness | Sequential inner timeouts consume the full outer budget before unbounded scans; requested temporal scope/provenance are inaccurate | High | `src/hooks/hook-retrieval-enforcer.ts:174-340,451-529` |

## Proposed Fixes (Ranked by Risk)

1. **Reconnect or retire dormant hooks behind schema/privacy/E2E gates** — decide product ownership first, then either remove misleading dead paths or reconnect with current event contracts and migration tests. Codex rating: **SOUND**.
2. **Version and test executable hook boundaries** — preserve the raw common envelope, validate required fields, and test CLI/settings/host timeout behavior against captured supported payloads. Codex rating: **SOUND**.
3. **Bound hook work and surface degradation** — cancel timers, move slow synchronous work to daemon-owned processing, bound I/O, validate delivery, and emit recursion-safe health markers. Codex rating: **RISKY**.
4. **Bind Telegram interactions to durable pending requests** — use runtime IDs plus an opaque callback token, atomic one-shot consumption, expiry, and restart recovery. Codex rating: **RISKY**.
5. **Replace premature cron marker cleanup with lifecycle-bound provenance** — propagate/claim an injection receipt rather than extending a global marker. Codex rating: **RISKY**.
6. **Define advisory versus mandatory approval policy** — specify disposition by origin, sensitivity, failure mode, timeout, and retry behavior before changing fail-open branches. Codex rating: **RISKY**.

## Architect ↔ Codex Disagreements

- Codex downgrades both Architect CRITICAL ratings to **HIGH**: wrong-plan/fail-open severity depends on whether plan review is mandatory authorization, and dead fact extraction lacks proven critical business impact.
- Callback identity, late-callback narration, and incomplete previews are consolidated into one HIGH decision-integrity cluster rather than counted as separate outages.
- Router dormancy and its unredacted telemetry sink are contextual alternatives: absence now versus a release-blocking activation hazard, not two active HIGH incidents.
- Retrieval failure-to-empty conflation is MEDIUM and overlaps the proven HIGH deadline/scope defect because the injected text does tell the model to search more broadly.
- Crash dedup/count races support the combined crash HIGH but remain MEDIUM until runtime concurrency incidence is measured.

## What Must Be True for Implementation to Succeed

- Capture real payloads from every supported Claude Code hook event and declare the minimum supported CLI versions.
- Decide whether plan review is advisory or mandatory for interactive, cron, and worker origins.
- Preserve common runtime identifiers (`session_id`, `prompt_id`, `tool_use_id`, `cwd`) instead of discarding them.
- Define restart-safe pending-request storage, expiry, atomic consumption, and Telegram authorization semantics.
- Define an authoritative cron receipt/turn correlation mechanism; a per-agent boolean marker is insufficient.
- Decide whether fact extraction and tool-result routing have current product owners and consumers.
- Define redaction, payload-size, retention, and access policy before enabling telemetry persistence.
- Ensure hook-owned deadlines leave margin beneath host timeouts and terminate descendant work.

## Testing Gate

- Real CLI entry-point tests for every registered hook, not helper-only or mirrored logic.
- Settings registration/merge tests and captured-payload compatibility fixtures.
- Wrong-plan regression: concurrent sessions/plans must never display or approve the wrong plan.
- Callback regressions: stale, duplicate, conflicting, late, post-restart, and unauthorized callbacks must not alter execution or narration.
- Crash regressions: prior-session rate-limit text, HTTP 4xx/5xx/Telegram API error, timeout, duplicate SessionEnd, and failed-delivery retry.
- Cron provenance test that executes a later hook after asynchronous enqueue and alongside an interactive message.
- Retrieval wall-clock, byte-bound, week/month scope, provenance, dependency-outage, and cache-concurrency tests.
- Fact lifecycle test from actual compact event through durable idempotent checkpoint output.
- Router activation gate covering success and failure schemas, duration, redaction, retention, concurrency, and payload caps.
- Full `npm run typecheck`, focused hook suite, and integration suite must pass before merge.

## Risks If Implemented As-Is

- Renaming payload fields without request binding could preserve wrong-session disclosure.
- Blanket fail-closed approval behavior could deadlock unattended agents or create denial loops.
- A long-lived global cron marker could misclassify overlapping human work.
- Promise-level deadlines around synchronous work could abandon callers while child/filesystem work continues.
- Reconnecting dormant telemetry without privacy controls could create a sensitive, unbounded analytics sink.
- Atomic file replacement alone would not solve logical lost updates or one-shot callback races.

## Recommendation

Report the six proven HIGH clusters now. Do not implement fixes until the plan-review policy, runtime payload contracts, and lifecycle correlation design are decided. The lowest-risk next step is an executable contract-capture/test harness plus an owner decision to reconnect or retire the dormant fact/router hooks.

No source implementation was performed.

