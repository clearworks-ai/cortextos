# Codex Critique — Weekly Hooks Audit

## Fix 1: Versioned hook contracts and executable integration tests

**Rating:** SOUND

**Objections:**

- Claude Code does not supply a hook-schema version in the payload. A repository-defined version number can describe cortextOS's adapter, but it cannot prove which vendor schema the installed CLI emitted. Tests need a compatibility matrix keyed to supported Claude Code releases or captured live payloads, not merely a new local `version` field.
- Invoking `cortextos bus hook-*` with a fixture proves the bus entry point and child process, but not settings discovery/merge, matcher selection, host timeout behavior, or the payload actually emitted by Claude Code. The current failures escaped because fixtures mirrored local assumptions. A settings-registration test plus at least one captured/runtime contract test is required.
- The common hook fields already contain useful correlation material (`session_id`, `prompt_id`, `tool_use_id`, `transcript_path`, `cwd`, and `hook_event_name`). `parseHookInput()` currently discards all of it. Creating per-hook versioned types without first preserving the common envelope would repeat the same drift at another layer.
- The CLI wrapper maps `spawnSync().status === null` to exit 0. A hook killed by signal can therefore still look successful. Entry-point tests that assert only an exit code will miss timeout/signal failures unless the runner contract is tested too.
- PostCompact is the correct current event for `compact_summary`, but older supported Claude Code builds may not have the same lifecycle. Moving the hook without declaring the minimum supported CLI version can silently disable it for older deployments.
- Strict rejection of unknown fields would be brittle. Vendor payloads are additive; validation should require the fields needed for a decision while retaining unknown fields for forwards compatibility.

**Alternative interpretation:** The simpler cross-cutting root cause is not an absence of version numbers; it is boundary drift hidden by helper-only and mirrored-logic tests. Preserve the raw common envelope, validate required fields at each adapter, and test the actual CLI/settings boundary against captured supported payloads.

**Risk if implemented as described:** A local “v1” contract and green fixture tests could create stronger false confidence while still diverging from the installed host, or an over-strict parser could turn harmless vendor additions into fleet-wide hook failures.

## Fix 2: Bind approval and question state to request/session/message identity

**Rating:** RISKY

**Objections:**

- Do not invent all of the identity. Claude Code already emits `session_id`, `prompt_id`, and `tool_use_id`; the Telegram layer should add one opaque random callback token that indexes a server-side record containing those authoritative identifiers and the returned Telegram `chat_id`/`message_id`.
- Telegram callback data is size-limited. Packing agent, session, prompt, tool-use, and message identity into every button is likely to exceed the limit and leaks correlation data. An opaque token plus a durable lookup is safer.
- Identity does not by itself make AskUserQuestion safe. FastChecker writes cursor keys before it reads `ask-state.json`; even a perfectly identified callback cannot prove that the foreground PTY is still showing the expected question or that its selection cursor is at the assumed position.
- Ask callbacks and PermissionRequest callbacks are different protocols. Permission/plan hooks wait on a response file, whereas Ask exits immediately and later drives a terminal UI. They should not share a generic “approval state” abstraction unless it models those different completion semantics.
- The current hook contract permits programmatic AskUserQuestion answers through `updatedInput.answers`, and newer PreToolUse supports deferred tool calls. That suggests the more fundamental defect is out-of-band PTY keystroke injection, not merely a missing nonce. The review should evaluate eliminating keystroke navigation rather than hardening it indefinitely.
- One-shot consumption must be atomic. “Check pending, then write” still races under two callbacks. Consumption, decision persistence, and UI narration need an explicit transaction/compare-and-set order, including crash recovery between Telegram send, registry persistence, response consumption, and message edit.
- The state must expire and be garbage-collected without making a late callback recreate it. It also needs behavior for duplicate Telegram delivery, bot restart, daemon restart, superseded prompts, and a response consumed locally but not yet acknowledged to Telegram.
- A Telegram message ID is not globally unique without its chat ID/bot context. Multi-user authorization policy also remains unresolved; binding to the message does not decide which authorized user may act.

**Alternative interpretation:** Permission/plan callbacks mainly lack a durable pending-request registry and atomic one-shot consumption. Ask has a separate architectural problem: it bypasses hook decision output and manipulates a mutable TUI by keystroke. Use runtime-provided IDs for correlation, and redesign Ask around a supported answer/defer channel if possible.

**Risk if implemented as described:** Ad hoc generated IDs may reject legitimate callbacks after restart, exceed Telegram callback limits, or leave the PTY-driving race intact while making the state machinery more complex and harder to recover.

## Fix 3: Make advisory versus authorization policy explicit

**Rating:** RISKY

**Objections:**

- The diagnosis correctly proves fail-open behavior, but it does not prove the intended policy. The plan hook explicitly documents auto-approval after 30 minutes, while the UI says “Approve Plan.” That is a product-policy contradiction, not enough evidence by itself to select deny or allow.
- “Authorization flows require a policy-defined disposition” is too abstract to implement. The policy needs a matrix by hook/event, origin (interactive, cron, worker), operation sensitivity, and failure mode (missing credentials, send failure, malformed response, timeout, daemon restart).
- Failing closed on all degraded paths can deadlock unattended agents for 30 minutes or indefinitely. Cron/worker plan-mode exit is not necessarily equivalent to approval for an external side effect; denying it may trap autonomous work in plan mode without increasing safety.
- Failing open is not the only unsafe behavior. A deny caused by a broken hook can repeatedly retrigger a model/tool loop, create Telegram noise, or prevent recovery. The policy must define bounded retry and operator escalation.
- Templates use `defaultMode: "bypassPermissions"`, so the effective boundary depends on when Claude Code emits PermissionRequest despite that mode. Policy claims require an executable reachability test, particularly for the `.claude/` auto-allow branch.
- UI language must follow policy. If plan review is advisory, remove approval semantics and report “notification unavailable”; if it is mandatory, make the blocking/SLA consequence explicit. A label alone must not determine enforcement.

**Alternative interpretation:** There are two plausible products hiding in one hook: an advisory plan notification for autonomous agents and a human authorization gate for interactive sessions. Split/configure those modes explicitly instead of deriving security posture from the current button text.

**Risk if implemented as described:** A blanket fail-closed conversion would produce long agent stalls and denial loops; a blanket advisory label would normalize wrong-plan disclosure and misleading approvals without fixing correlation.

## Fix 4: Lifecycle-bound turn records and canonical state resolution

**Rating:** RISKY

**Objections:**

- The cron lifetime bug is proven: `onFire` removes `.cron-active` immediately after synchronous enqueue. However, `injectAgentDetailed()` currently returns no receipt or eventual-turn completion handle. “Lifecycle-bound receipt records” therefore requires a new cross-layer protocol, not a marker refactor.
- Cron provenance is known before injection, while `prompt_id`/`session_id` become available only when the host emits hook payloads. The design must explain how an injected receipt is claimed by the correct prompt when Telegram/user messages are queued nearby, deduplicated, or processed after restart.
- Cleanup cannot rely only on Stop. A turn can end via StopFailure, compaction, session switch, crash, or process kill. TTL remains necessary, and its failure bias must be explicit.
- Retaining one global marker until Stop is only an interim fix. It would falsely classify an overlapping or queued interactive turn as cron-originated. Conversely, a per-turn record that is never successfully claimed recreates stale-state denial.
- Canonical path resolution is broader than hooks. `resolvePaths()` itself reconstructs `~/.cortextos/{instance}` and ignores an absolute `CTX_ROOT`, while some hooks honor `CTX_ROOT`. Passing `env.ctxRoot.split('/').pop()` (as the router does) cannot represent a custom root. A single resolver must accept the absolute root and validate agent identity.
- Empty/missing identity needs a declared disposition. Silently using an empty agent directory creates cross-session state sharing, but throwing from best-effort hooks could break the host UI.
- The proposed direction groups unrelated items: cron turn provenance, crash incident provenance, and path canonicalization have different producers and terminal events. One universal record format could obscure those differences.

**Alternative interpretation:** The immediate cron defect is simply premature cleanup after enqueue. A minimal mitigation can retain a scoped token until a later acknowledged lifecycle boundary, but a correct long-term solution must propagate a daemon injection receipt into the host hook envelope or transcript and claim it atomically. Path canonicalization should be a separate utility migration.

**Risk if implemented as described:** A coarse long-lived record can deny real interactive requests; an overengineered ledger without authoritative receipt propagation can accumulate stale records and make provenance less predictable than the current obvious failure.

## Fix 5: Hook-owned deadlines, cancellation, bounded I/O, and degradation events

**Rating:** RISKY

**Objections:**

- A total deadline cannot cancel `execFileSync`, `readFileSync`, or a full JSONL split already in progress. Retrieval must become staged/async or use bounded tail reads with deadline checks; wrapping existing synchronous work in `Promise.race` would only abandon the promise while work continues.
- Inner budgets must leave startup, JSON parsing, stdout flushing, and cleanup headroom. Merely making their arithmetic total 19 seconds under a 20-second host limit is still structurally unsafe.
- Cancellation must kill descendant processes, not only reject a parent promise. The current bus wrapper and host may leave different process-tree behavior on macOS/Windows, and `runHook` currently turns a signal-killed child into exit 0.
- Byte bounds need evidence-preserving semantics. Cutting a JSONL file at an arbitrary byte offset can begin mid-record; widening week/month searches while capping files may still systematically exclude the requested period. Tail parsing, per-period enumeration, deduplication, and provenance have to be designed together.
- Degradation events must not consume the same failing deadline or recursively invoke more hooks. Spawning `cortextos bus log-event` from a nearly timed-out hook can worsen the timeout. Prefer a bounded local append/health marker with daemon-side draining, and rate-limit by a stable error class.
- “Failure” must remain non-blocking for observational hooks but may require a decision for authorization hooks. A universal degraded-state semantic would conflate enforcement with telemetry again.
- Timer cleanup alone is necessary but not sufficient. The fact and context hooks have leaked timers; retrieval's larger problem is serial synchronous work. Crash delivery additionally needs an AbortSignal and response validation, but delivery confirmation and retry ownership are separate from a hook deadline.
- Payload caps and redaction are different controls. A 4 KB secret is still a secret, and truncation can remove the evidence needed to understand a failed tool call.

**Alternative interpretation:** Several findings share a simpler implementation smell—short-lived hook processes are doing daemon-grade work synchronously. Keep hook responsibilities to bounded parsing plus a small durable handoff; move slow retrieval, delivery retry, and analytics processing to daemon-owned workers where cancellation and observability are controllable.

**Risk if implemented as described:** Superficial races/timeouts can leave child work running, corrupt partial state, or emit recursive failure storms while still losing the hook's actual output at the host deadline.

## Fix 6: Reconnect or retire dormant hooks behind schema/privacy/E2E gates

**Rating:** SOUND

**Objections:**

- “Dormant” describes two different states. Fact extraction is partially configured in live agent settings but absent from the bus and incompatible with its event; the router has a bus command but zero audited registrations. They need separate ownership decisions.
- Retirement is the simplest correct outcome unless a current product requirement and consumer are identified. Dormant source plus misleading tests/comments is itself maintenance risk.
- A repository settings scan is not proof of fleet-wide absence because Claude Code merges user, project, managed-policy, plugin, skill, and agent hooks. The report should say “no registration in audited repository/global settings,” not absolute fleet-wide dormancy.
- Reconnecting fact extraction requires PostCompact support, a bus command, template and existing-agent migration, idempotent append semantics, timer cleanup, and an end-to-end test. It also needs protection against duplicate compact events and forged Markdown checkpoint boundaries.
- Reconnecting the router requires separate PostToolUse and PostToolUseFailure parsing, top-level duration handling, payload classification/redaction, size and retention limits, filesystem/dashboard access review, concurrency-safe persistence, and an explicit decision about Telegram volume.
- The router's dormancy and its latent disclosure sink are not two simultaneous active HIGH incidents. While unregistered, the disclosure is a release-blocking activation hazard, not an ongoing data leak.

**Alternative interpretation:** These may be abandoned prototypes rather than broken production features. Delete/retire them and their misleading registrations/tests unless an owner can name the user-visible contract; only then build the smallest event-compatible replacement.

**Risk if implemented as described:** Treating “reconnect” as the default would activate a sensitive, high-volume success-only telemetry sink or a duplicate/injection-prone memory writer. Treating repository scans as complete could also miss an out-of-repository registration during migration.

## Prioritized verdict for the weekly report

### Sufficiently proven at HIGH (report, with consolidation)

1. **Wrong-plan selection and disclosure:** The current ExitPlanMode schema uses `plan` / `planFilePath`; the hook reads obsolete `plan_file` and falls back to the newest file in a shared plans directory. The behavior is proven. Report as **HIGH**. Architect's **CRITICAL** rating is conditional on an unproven mandatory-authorization policy.
2. **Telegram decision integrity:** Ask callbacks lack request/session/message binding and drive PTY keys before validating state; permission/plan callbacks are not one-shot and can narrate a late decision after execution disposition; several previews omit material tails without disclosure. These are related facets of one identity/audit-integrity cluster, not three independent outages. Report the cluster as **HIGH**.
3. **Crash classification and delivery integrity:** Persistent unscoped stdout evidence can reclassify a later crash; Telegram HTTP/API failure is ignored; dedup is committed before delivery. These are proven and can suppress the useful alert. Report one **HIGH** incident. Treat unlocked count/dedup concurrency as supporting risk, not a separate HIGH without runtime concurrency evidence. Also replace “permanently downgrade” with “downgrade while the old signature remains in the last 200 KB.”
4. **Fact extraction is disconnected:** The bus command is absent, core templates omit it, configured PreCompact payloads do not contain the summary it expects, and the timer leak is measured. Nonfunctionality is proven. Report as **HIGH**, not **CRITICAL**, unless the weekly report can show a critical business/recovery dependency on these checkpoints.
5. **Cron provenance expires before the turn:** The marker is removed immediately after enqueue, and the test proves only marker presence during enqueue. Later hooks cannot reliably identify the cron turn. Report as **HIGH** because it defeats the explicit deny-fast contract and can route autonomous permission/question interactions into human flows.
6. **Retrieval has a structurally invalid deadline and incorrect scope/provenance:** Sequential inner timeouts consume the full outer budget before unbounded transcript work, and week/month/history intent still enumerates only three days while omitting file paths. The code evidence is sufficient for **HIGH reliability/correctness risk**. Do not claim observed fleet outage without latency/incidence data.

### Conditional or downgrade before publishing

- **Plan fail-open as CRITICAL:** behavior is proven; security severity is not. Publish as policy-dependent HIGH until advisory-versus-mandatory intent is documented.
- **Retrieval failures narrated as “no hits”:** operational conflation is proven, but the emitted text explicitly warns the model not to conclude that nothing exists. This is **MEDIUM observability/reliability**, and overlaps the deadline finding.
- **Router dormant / latent disclosure:** do not report two active HIGHs. Dormancy may be a missing feature; the unredacted sink is a **release blocker if activation is proposed**, not a current exposure on the audited registrations.
- **Crash count/dedup races:** the read-modify-write race is real, but frequency/impact are not established. Keep it under the combined crash HIGH or rate it MEDIUM.
- **Autonomous `.claude/` auto-allow:** guard ordering is proven, but intended policy and PermissionRequest reachability under `bypassPermissions` are unresolved. Needs a policy decision and integration test before HIGH.

### Architect ↔ Codex disagreements

- Codex downgrades both Architect **CRITICAL** claims: wrong-plan/fail-open to **HIGH pending policy**, and dead fact extraction to **HIGH pending evidence of critical business impact**.
- Codex treats callback identity, late-callback narration, and incomplete previews as one decision-integrity cluster to avoid duplicate severity counting.
- Codex treats router dormancy and router disclosure as mutually contextual: absence now versus activation hazard later, not two concurrent HIGH incidents.
- Codex accepts the retrieval deadline/scope defects but rejects “false no-hits guidance” as a separate HIGH because the hook text already instructs the model to broaden the search.
