# Adversarial Review — Week 4 Templates and Settings Validation

Generated: 2026-08-24T15:13:00Z
Status: AWAITING APPROVAL

## Verdict

NEEDS MORE RESEARCH before implementation. The defects are evidence-backed, but the Critical validator rollout and OpenCode permission redesign require migration and compatibility specifications before code changes.

## Root Causes (Architect Consensus)

| Severity | Area | Root Cause | Confidence | File:Line |
|---|---|---|---|---|
| CRITICAL | Runtime config | Missing/unreadable/malformed configs become empty defaults; no runtime schema validation; unsafe defaults enable Claude with permission bypass | High | src/daemon/agent-manager.ts:1780-1811; src/pty/agent-pty.ts:299 |
| HIGH | Cron editor | Dashboard writes retired config.json crons, while scheduler reads crons.json | High | dashboard cron route:39-114; src/daemon/cron-scheduler.ts:407 |
| HIGH | Settings concurrency | Independent unlocked full-file read-modify-write paths can lose updates | High | config route:123; crons route:65,114 |
| HIGH | Dashboard scaffold | Byte-copy without rendering; start precedes registry commit; failure can leave an unregistered running agent | High | dashboard agents route:120-199 |
| HIGH | Secret handling | Newline-capable credentials are interpolated into .env and written without mode 0600 | High | dashboard agents route:95,128,136 |
| HIGH | CLI scaffold | Per-file copy failures are swallowed, success is narrated, and registration continues | High | src/cli/add-agent.ts:124-145,448-466 |
| HIGH | Drift detection | Missing provenance/skipped runtimes/errors collapse into a false PASS | High | src/cli/doctor.ts:327-364 |
| HIGH | Handoff contract | Analyst teaches hard restart without required handoff artifact/resume lifecycle | High | templates/analyst/AGENTS.md:44-74 |
| HIGH | Threshold contract | Type, runtime, and dashboard disagree on defaults/opt-out; partial PATCH can invert ordering | High | src/types/index.ts:238; src/daemon/fast-checker.ts:1175,1349; config route:95,104 |
| HIGH | OpenCode permissions | Framework and native config independently grant blanket bypass/allow-all | High | templates/agent-opencode/config.json:4-6; .opencode/opencode.json:3-17 |
| MEDIUM | Recovery narration | A resolved-but-crashed start is logged as recovered successfully | High | src/daemon/agent-process.ts:357-379; src/daemon/agent-manager.ts:351 |

## Proposed Fixes (Ranked by Risk)

1. **Canonical cron API and revision-aware settings writes** — Codex rating: SOUND.
2. **Runtime-aware manifests with checked/skipped/error accounting** — Codex rating: SOUND.
3. **Shared transactional scaffolder for CLI/dashboard** — Codex rating: SOUND.
4. **Versioned field-aware config validator with migration** — Codex rating: RISKY.
5. **Exact handoff parity and merged threshold validation** — Codex rating: RISKY.
6. **Runtime-specific OpenCode least-privilege policy** — Codex rating: RISKY.

## Architect ↔ Codex Disagreements

No root-cause disagreement. Codex challenged rollout shape: strict validation can halt legacy agents; threshold “unification” can accidentally change policy; and OpenCode restriction can deadlock unattended work unless the capability matrix is proven first.

## What Must Be True for Implementation to Succeed

- Existing config corpus is inventoried and migration-tested before strict validation.
- CLI and dashboard invoke one scaffolding library with a declared transaction boundary.
- Canonical cron writes preserve fire metadata, backups, and hot reload.
- Drift reporting distinguishes clean, skipped, unknown, and errored agents.
- Threshold policy is declared authoritative before constants are changed.
- OpenCode negative enforcement and unattended positive workflows both pass.

## Testing Gate

- Malformed, missing, and wrong-typed configs never launch enabled permission-bypassed sessions.
- Concurrent settings writes preserve both updates or reject one with a revision conflict.
- Every scaffold failure leaves no enabled entry and no running process.
- Dashboard-created agents contain no unresolved required placeholders and .env is mode 0600.
- Dashboard cron saves modify canonical scheduler state exactly once.
- Drift checks cannot PASS with zero checked agents or parse errors.
- Every role template passes the exact context-handoff lifecycle contract.
- Partial threshold PATCH validates the merged object and explicit opt-out.
- OpenCode destructive/external operations are technically denied without approval while approved cron workflows continue.

## Experiments

- exp_1787584392_rex2j — config safe boot
- exp_1787584392_uciha — canonical cron writes
- exp_1787584392_ho3q9 — settings conservation
- exp_1787584392_857fv — scaffold atomicity
- exp_1787584392_khdts — dashboard env integrity
- exp_1787584392_clez2 — drift detection recall
- exp_1787584392_mdq9d — handoff parity
- exp_1787584392_hkr34 — threshold validity
- exp_1787584392_oyg83 — OpenCode enforcement
- exp_1787584392_nloqw — recovery narration

## Recommendation

Specify the validator migration and OpenCode capability policy first. The canonical cron writer, revision-aware settings persistence, runtime-aware drift accounting, and shared transactional scaffolder are ready for bounded engineering plans after approval. No implementation was performed.

