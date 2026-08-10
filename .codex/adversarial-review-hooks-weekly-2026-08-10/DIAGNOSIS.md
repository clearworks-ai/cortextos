# Adversarial Diagnosis — Weekly Hooks Audit

Generated: 2026-08-10 08:14 PDT
Subsystem: `src/hooks/`

## Summary

The hooks suite compiles and all 199 focused tests pass, but the executable lifecycle contracts are materially broken. The highest-confidence defects are approval identity/provenance failures, disconnected observability hooks, and asynchronous state markers whose lifetime ends before the agent turn they are meant to describe. Confidence is high because the diagnosis combines full-file review, call-path tracing, registration scans, runtime probes, and focused tests.

## Problem Areas

### Telegram plan and permission integrity

**Root Cause:** `src/hooks/hook-planmode-telegram.ts:32-49,94-121,148-185` reads obsolete `plan_file`, falls back to the newest plan in a shared global directory, and authorizes on missing credentials, send failure, timeout, cron/worker suppression, and top-level failure.

**Severity:** CRITICAL

**Confidence:** High for behavior; medium-high that the review UI is intended as an authorization boundary.

**Evidence:** Current hook input uses `plan` / `planFilePath`; the only fixture asserts the obsolete field. `outputDecision('allow')` is emitted on every degraded path, and the timeout-as-allow behavior is explicitly unit-tested.

**Adversarial Counterargument:** Plan review may be advisory. That would reduce policy severity, but the UI says `PLAN REVIEW` / `Approve Plan`, and cross-session plan selection remains a disclosure and correctness defect.

**What a Naive Fix Would Miss:** Renaming one field does not bind the displayed plan to the pending request or remove the fail-open branches.

### Telegram callback identity and preview integrity

**Root Cause:** `src/hooks/hook-ask-telegram.ts:53-76`, `src/hooks/index.ts:185-210,323-389`, and `src/daemon/fast-checker.ts:915-976` use shared state and callback indices without request/session/message identity. Permission previews silently truncate material payloads, and late callbacks recreate orphan response files while changing Telegram narration after execution has already proceeded.

**Severity:** HIGH

**Confidence:** High.

**Evidence:** Callback data contains no nonce for Ask flows; FastChecker writes PTY navigation keys before validating a current matching state; Edit/Write/MCP previews are sliced without a truncation marker or full-payload reference.

**Adversarial Counterargument:** Interactive PTYs normally serialize prompts. This does not neutralize delayed clicks on old Telegram messages or stale state left after send failure.

**What a Naive Fix Would Miss:** A unique state filename alone does not bind buttons, enforce one-shot consumption, or prove the TUI is still on the corresponding prompt.

### Crash classification and delivery observability

**Root Cause:** `src/hooks/hook-crash-alert.ts:67-92,163-179,352-380,419-448,507-515` classifies from persistent unscoped stdout text, performs unlocked crash-count/dedup read-modify-write, commits dedup before delivery, and treats Telegram HTTP/API failures as success.

**Severity:** HIGH

**Confidence:** High for the defects; medium for concurrency frequency.

**Evidence:** Any historical rate-limit signature in the last 200 KB can downgrade a later real crash. Fetch has no timeout or status/JSON check. Failed first delivery still suppresses retries for ten minutes.

**Adversarial Counterargument:** PTY logs could be truncated per session and SessionEnd firings could be serialized. The audited persistent per-agent log path and double-fire design provide no such guaranteed provenance or serialization.

**What a Naive Fix Would Miss:** Regex tightening or atomic rename alone does not add session identity, logical incident dedup, or delivery-confirmed commit ordering.

### Fact extraction lifecycle is disconnected

**Root Cause:** `src/hooks/hook-extract-facts.ts:22-27,78-139`, `src/cli/bus.ts:4569-4612`, and core template `PreCompact` registrations disagree at three layers: the bus command is absent, templates omit the hook, and implementation expects summary fields that current `PreCompact` does not provide.

**Severity:** CRITICAL

**Confidence:** High.

**Evidence:** Built CLI returns unknown command; scaffold templates register only compact Telegram; current compact summary lives under a different lifecycle event/schema. A runtime probe also measured a deterministic ten-second process lifetime from an uncleared timer.

**Adversarial Counterargument:** A deployment wrapper could transform events or carry a CLI patch not present in this checkout. No wrapper or recent compact checkpoint produced by this hook was found.

**What a Naive Fix Would Miss:** Registration, CLI exposure, event selection/schema, timer cleanup, and end-to-end tests must all agree.

### Retrieval deadline, provenance, and failure semantics

**Root Cause:** `src/hooks/hook-retrieval-enforcer.ts:174-191,204-340,389-418,451-529` serializes inner timeouts totaling the entire 20-second outer budget, then performs unbounded synchronous transcript scans. Errors become empty strings narrated as `no hits`; requested week/month/history windows still scan three days; output omits file provenance.

**Severity:** HIGH

**Confidence:** High.

**Evidence:** Git caps total eight seconds, KB caps twelve seconds, and transcript work remains. The cache records metadata but never suppresses a repeated query. Every major failure path is silent.

**Adversarial Counterargument:** Production p99 may be well below the caps and the underlying KB may cache. That would reduce incidence, not the structural deadline race or false `no hits` narration.

**What a Naive Fix Would Miss:** Raising the outer timeout does not bound reads, distinguish failures, fix temporal scope, or make provenance auditable.

### Tool-result router is dormant and unsafe to enable unchanged

**Root Cause:** `src/hooks/hook-tool-result-router.ts:28-48,270-326` has zero live/template registrations, parses only success-event shape, drops top-level duration, and would persist complete unredacted/unbounded tool inputs and results if enabled.

**Severity:** HIGH (latent security/observability risk)

**Confidence:** High.

**Evidence:** Repository-wide settings scan found no registration. Current failures use `PostToolUseFailure`; router only models `PostToolUse`. Full `tool_input` / `tool_result` flow into analytics without cap or redaction.

**Adversarial Counterargument:** An out-of-repository policy layer could register and pre-redact. Current global settings and repo templates do not.

**What a Naive Fix Would Miss:** Registration alone would create a success-only sensitive telemetry sink.

### Cron turn provenance expires before hook execution

**Root Cause:** `src/daemon/agent-manager.ts:1319-1337,1419-1448` removes `.cron-active` immediately after synchronous enqueue, while `src/hooks/lib/session-context.ts:19-39` reads it later during tool execution.

**Severity:** HIGH

**Confidence:** High.

**Evidence:** The unit test proves only marker presence inside enqueue, not during the asynchronous turn. Later Ask/Plan/Permission hooks therefore normally see an interactive turn and can wait for a human.

**Adversarial Counterargument:** This would be false if injection blocked through the entire model turn; implementation returns the immediate enqueue result.

**What a Naive Fix Would Miss:** A longer global marker misclassifies overlapping human turns. Provenance needs receipt/turn/session identity and lifecycle-bound cleanup.

### State timing, roots, and enforcement fail-open

**Root Cause:** `hook-context-status.ts:44-81`, `hook-idle-flag.ts:15-24`, `hook-loop-detector.ts:88-119,199-281`, and `system-pings.ts:28-43` leak timers, discard samples before parsing session/safety transitions, use split state-root contracts, and collapse lock/write/parse failures into success.

**Severity:** MEDIUM

**Confidence:** High for behavior, medium for fleet incidence.

**Evidence:** Built context-status hook remains alive roughly 1.5 seconds against a two-second budget. Debounce can discard a new-session 99% sample. Loop lock timeout equals the full host timeout, and the advertised 30-minute emergency escape is unreachable under the 60-second history retention.

**Adversarial Counterargument:** Standard daemon env paths align and hooks may serialize in the happy path. Custom roots, overlapping processes, and load are supported enough that silent degradation remains unobservable.

**What a Naive Fix Would Miss:** Throwing errors would turn observability faults into outages; the correct direction needs bounded non-blocking health signals and explicit degraded-state semantics.

## Cross-Cutting Concerns

1. Identity-free coordination: plans, callbacks, cron provenance, crash evidence, and dedup state are not bound to the request/session/turn they represent.
2. Fail-open silence: permission/retrieval/state failures are reported as allow, no hits, or success rather than degraded operation.
3. Dormant contracts: fact extraction and tool-result routing have source and tests but are absent or incompatible at registration/runtime boundaries.
4. Test honesty: helper and mirrored-logic tests pass while entry-point schemas, registration, wall-clock budgets, concurrency, and failure delivery remain untested.

## Proposed Fix Direction

1. Define versioned hook event contracts and add executable integration tests that invoke the real CLI entry points with current payloads and settings.
2. Bind all approval/question state to unpredictable request IDs plus agent/session/message identity, and enforce one-shot consumption before changing UI narration.
3. Make approval policy explicit: advisory flows may fail open only when labeled advisory; authorization flows must surface degraded state and require a policy-defined disposition.
4. Replace per-agent provenance markers with lifecycle-bound turn/receipt records and canonicalize state-root/identity resolution.
5. Give every hook a total deadline smaller than its host budget, cancel timers and child work, bound transcript/payload bytes, and emit rate-limited structured degradation events.
6. Reconnect or retire dormant hooks only after schema, privacy, registration, and end-to-end tests agree.

No implementation was performed.
