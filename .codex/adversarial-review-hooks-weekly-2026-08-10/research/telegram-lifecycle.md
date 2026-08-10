# Adversarial Diagnosis — Telegram and Lifecycle Hooks

Generated: 2026-08-10  
Scope: `src/hooks/hook-ask-telegram.ts`, `hook-permission-telegram.ts`, `hook-planmode-telegram.ts`, `hook-compact-telegram.ts`, `hook-crash-alert.ts`, and `src/hooks/index.ts`, with direct callback, Telegram API, registration, and test-path cross-checks.  
Method: every owned file was read completely. The code graph was used first for symbol and call-path discovery; direct reads were used where the graph exposed only module-level nodes. No `memory/audit-*.md` files were present for cross-reference.

## Ranked findings

### 1. ExitPlanMode reads a retired field, then silently substitutes another session's newest plan

- **Root cause:** `src/hooks/hook-planmode-telegram.ts:112-121`, backed by the machine-global fallback at `:32-49`. The hook looks only for `tool_input.plan_file`. Current Claude Code's PermissionRequest contract supplies the plan as `tool_input.plan` and its path as `tool_input.planFilePath`. When `plan_file` is absent, the hook selects the most recently modified Markdown file anywhere under `~/.claude/plans/`, with no session, cwd, agent, or `session_id` binding.
- **Severity:** **CRITICAL** — an operator can be shown and approve plan B while the pending ExitPlanMode call executes plan A. It can also disclose another project's plan through Telegram.
- **Confidence:** **High.** The current official hook contract documents `plan` and `planFilePath`, the installed CLI is Claude Code 2.1.179, and repository search finds no use of either current field. The sole test fixture asserts the obsolete `plan_file` spelling (`tests/unit/hooks/hooks.test.ts:458-473`). Source: <https://code.claude.com/docs/en/hooks#permissionrequest-decision-control> (ExitPlanMode input section in the same reference).
- **Evidence:** `let planPath = tool_input.plan_file || ''` (`:113`); absence routes to `findMostRecentPlan()` (`:114-115`); that function sorts the shared plan directory solely by mtime (`:32-46`). `parseHookInput` also discards common hook fields such as `session_id` and `cwd` (`src/hooks/index.ts:26-35`), leaving no correlation material.
- **Adversarial counterargument:** The runtime might still inject a compatibility-only `plan_file` field that is absent from public documentation, or every agent might have a separate OS home. This would be disproved by capturing a live 2.1.179 ExitPlanMode hook payload showing no `plan_file`; conversely, a payload containing a correct, session-specific `plan_file` would lower the likelihood. Separate OS homes would reduce cross-agent exposure but not the schema mismatch.
- **What a naive fix would miss:** Merely renaming the field would still ignore the authoritative inline `plan`, retain unbound global fallback behavior, and leave approval of an unmarked partial rendering (finding 2).

### 2. The plan-review gate is fail-open on every degraded path, including an explicit 30-minute non-response

- **Root cause:** `src/hooks/hook-planmode-telegram.ts:94-109`, `:148-178`, and `:181-185`. Cron/worker suppression, missing credentials, Telegram send failure, timeout, and any uncaught exception all emit `allow`. A missing/empty plan is still presented as a reviewable placeholder (`:118-126`). The first 100 lines are taken silently (`:53-62`) before a separate character truncation marker is considered (`:128-130`).
- **Severity:** **CRITICAL** when this hook is treated as an approval gate; unavailable review infrastructure becomes authorization, and an operator may approve an incomplete or unrelated plan.
- **Confidence:** **High** for behavior; **Medium** that the product policy considers it a defect, because comments explicitly describe auto-approval as intentional.
- **Evidence:** `outputDecision('allow')` occurs at `:103`, `:108`, `:152`, `:177`, and `:184`. `resolvePlanDecision(null)` also defines timeout as allow (`:65-68`), and its unit test locks that behavior in (`tests/unit/hooks/hook-planmode-telegram.test.ts:32-34`). The template grants broad tools and uses `defaultMode: "bypassPermissions"` (`templates/agent/.claude/settings.json:2-12`), increasing the consequence of a falsely trusted plan transition.
- **Adversarial counterargument:** ExitPlanMode may be intended only as a convenience notification, not a security boundary, and blocking unattended agents for 30 minutes may be worse operationally. This finding would be disproved as a security defect by a documented policy explicitly stating that plan review is advisory and that non-response is authorization; current names (`PLAN REVIEW`, `Approve Plan`) communicate the opposite to the operator.
- **What a naive fix would miss:** Changing only the timeout default would not address send errors, missing credentials, top-level exceptions, autonomous-session behavior, wrong-plan selection, or silent 100-line truncation.

### 3. AskUserQuestion callbacks are not bound to a request, session, message, or current question

- **Root cause:** `src/hooks/hook-ask-telegram.ts:53-68` and `src/hooks/index.ts:323-370,376-389`. All asks share one mutable `ask-state.json`, while callbacks encode only question and option indices (`askopt_0_1`, `asktoggle_0_1`, `asksubmit_0`) and contain no random request ID. The callback consumer accepts those indices and writes navigation keys before validating the current state (`src/daemon/fast-checker.ts:952-976`); it does not compare `qIdx` with `state.current_question`, message ID, session ID, or the active tool.
- **Severity:** **HIGH** — a delayed click on an old Telegram question, or two overlapping asks, can operate the current TUI and answer a different question. The fixed state file is overwritten before send, so send failure also leaves stale state (`hook-ask-telegram.ts:53-57,72-76`).
- **Confidence:** **High.** Callback strings and the fixed pathname are directly asserted by tests (`tests/unit/hooks/hooks.test.ts:326-395`; `tests/unit/daemon/fast-checker.test.ts:532-657`), but no stale-message, overlap, or q-index mismatch test exists.
- **Evidence:** State overwrite precedes send (`:55-57` versus `:72-76`); all first-question callback IDs are identical across requests (`src/hooks/index.ts:347-370`); FastChecker starts PTY writes based only on the callback indices and only afterward reads shared state.
- **Adversarial counterargument:** A single interactive Claude PTY normally cannot issue a second AskUserQuestion while the first TUI is pending. That reduces true overlap, but it does not neutralize old Telegram messages after later asks or stale state left by send/parse failures. This would be disproved by a callback layer that removes keyboards from every superseded message and rejects callbacks not present in a durable active-request registry; no such binding appears in the inspected path.
- **What a naive fix would miss:** Giving the state file a unique name alone would not bind Telegram buttons to it, reject stale clicks, prevent double submission, or prove the PTY is still displaying the matching question.

### 4. Old rate-limit text can permanently downgrade a later genuine crash

- **Root cause:** `src/hooks/hook-crash-alert.ts:67-88,352-360`. Classification scans the last 200 KB of a persistent `stdout.log` without any timestamp, session boundary, exit-time window, or consumption marker. Any historic `rate_limit_error`, `weekly limit`, or similar signature remaining in the tail reclassifies a later unmarked exit as `rate-limited`.
- **Severity:** **HIGH** — a real crash is excluded from chief/analyst bus alerts (`:429-448`), does not increment the crash counter (`:363-390`), and can be quiet-hours suppressed (`:30-38,419-423`).
- **Confidence:** **High.** The detector is content-only. Tests validate positive and negative strings but never establish recency or session ownership (`tests/unit/hooks/detect-rate-limit-hook.test.ts`).
- **Evidence:** `detectRateLimitInLog(stdoutPath)` is the sole predicate after `endType === 'crash'`; the function reads a raw tail and lowercases it, with no temporal input.
- **Adversarial counterargument:** The stdout log might be truncated on every PTY launch. This would disprove the production impact if the daemon provably creates a new empty per-session file before every session. The inspected hook and tests assume a persistent per-agent `stdout.log`, and the lifecycle test explicitly seeds arbitrary prior content.
- **What a naive fix would miss:** Tightening phrases again would not establish that the matching error belongs to the ending session; the failure is provenance, not regex breadth.

### 5. Lifecycle delivery treats Telegram HTTP failures as success and can outlive the 10-second hook budget

- **Root cause:** `src/hooks/hook-crash-alert.ts:507-515` and `hook-compact-telegram.ts:42-59` call `fetch` directly and never inspect `response.ok` or Telegram's JSON `ok` field. Crash fetch has no abort signal at all. The registered SessionEnd timeout is 10 seconds (`templates/agent/.claude/settings.json:84-91`), while the CLI synchronously waits on the child (`src/cli/index.ts:68-75`). Compact has a 5-second abort but still records neither transport nor HTTP/API failure.
- **Severity:** **HIGH** — 400/401/403/429 responses are silently accepted, and a wedged crash send can be killed by the outer hook timeout (or leave the synchronously spawned child orphaned), precisely when crash visibility is needed.
- **Confidence:** **High** for missing status/timeout handling; **Medium** for orphaning, which depends on Claude Code's process-tree termination semantics.
- **Evidence:** Both catches are empty. By contrast, the shared `TelegramAPI.post` checks Telegram's `result.ok`, throws descriptive API errors, and uses a 15-second abort (`src/telegram/api.ts:735-760`), proving the direct path bypasses existing failure semantics.
- **Adversarial counterargument:** Claude's outer 10-second timeout bounds the user-facing hook, and crash bus messages provide a second channel. That does not turn HTTP 401 into an exception, and bus delivery is also best-effort with ignored callbacks (`hook-crash-alert.ts:137-155`). The missing-timeout impact would be disproved by evidence that the outer runner reliably kills the entire descendant process tree.
- **What a naive fix would miss:** Checking only `response.ok` would miss Telegram JSON-level errors, timeout/process-tree behavior, suppressed retry caused by pre-delivery dedup (finding 6), and the lack of a delivery-failure event.

### 6. Crash deduplication and daily counts are race-prone read/modify/write state, and dedup is committed before delivery

- **Root cause:** `src/hooks/hook-crash-alert.ts:163-178` performs an unlocked read-modify-write of `.crash_alert_dedup.json`; `:367-380` does the same for `.crash_count_today`. Concurrent SessionEnd processes can both observe the old value, both send, and lose a count update. Conversely, dedup timestamps are persisted before bus or Telegram delivery (`:425` precedes `:435-448` and `:507-515`), so a failed first attempt suppresses subsequent attempts for ten minutes.
- **Severity:** **HIGH** — the stated purpose is suppressing duplicate crash storms, but concurrency can defeat suppression, while delivery failure can suppress the first useful retry.
- **Confidence:** **High** for the race and pre-delivery ordering; **Medium** for frequency. The file itself documents two hook firings 13–22 seconds apart (`:230-242`), and separate processes make shared-state concurrency plausible.
- **Evidence:** Plain `readFileSync` → mutate object/count → `writeFileSync` has no lock, exclusive create, rename transaction, or compare-and-swap. Tests call classification synchronously and do not run concurrent hook processes.
- **Adversarial counterargument:** If Claude Code serializes the two SessionEnd hook processes and each filesystem write completes before the next starts, the duplicate-send race will not manifest in the known double-fire path. It would be disproved by process-timestamp evidence showing serialization under all exit/relaunch paths; the lost-retry ordering remains even when serialized.
- **What a naive fix would miss:** Making writes atomic prevents torn files but not lost updates, duplicate logical incidents, delivery-before-commit semantics, or the deliberate suppression of distinct crashes sharing the same `endType` key within ten minutes.

### 7. Permission/plan callbacks are not one-shot and late clicks narrate a decision that no longer controls execution

- **Root cause:** The hooks wait on a generated response path (`hook-permission-telegram.ts:139-169`; `hook-planmode-telegram.ts:133-158`) and delete it on exit (`src/hooks/index.ts:431-438`). FastChecker unconditionally recreates that path and edits the Telegram message for every matching callback (`src/daemon/fast-checker.ts:915-944`), without checking whether a matching hook is still pending. Two rapid clicks can overwrite each other; a click after timeout recreates an orphan file and changes the message to “Approved” or “Denied” after the actual decision has already happened.
- **Severity:** **HIGH** for approval audit integrity; execution may be denied while Telegram says Approved, or a plan may already be auto-approved before a late Denied click.
- **Confidence:** **High.** The consumer has no pending registry lookup or exclusive create and the hook cleanup intentionally removes the only liveness signal.
- **Evidence:** `writeFileSync(responseFile, ...)` is unconditional; answer/edit occurs immediately afterward. Tests assert file creation and labels, but none covers timeout, duplicate callbacks, or conflicting callbacks (`tests/unit/daemon/fast-checker.test.ts:438-493`).
- **Adversarial counterargument:** Telegram normally delivers one callback per human tap, and users rarely press conflicting buttons. Network retries, double taps, and late responses are ordinary enough that an approval UI cannot assume this. A server-side one-shot callback guarantee from Telegram would disprove the duplicate-delivery portion, but not a user clicking after the local 30-minute deadline.
- **What a naive fix would miss:** Disabling the keyboard only after callback processing still leaves the race before the edit, and it cannot establish whether the local hook already timed out or consumed another decision.

### 8. Permission previews omit material content without consistently telling the approver

- **Root cause:** `src/hooks/index.ts:185-210`. Edit old/new strings and Write content are cut at 300 characters with no truncation marker; unknown/MCP tool input is cut at 200 characters with no marker. Only Bash received an explicit warning that the full command will run (`:198-206`). The outer message's 3,800-character marker (`hook-permission-telegram.ts:152-155`) never triggers for these already-shortened previews.
- **Severity:** **HIGH** — destructive or security-relevant payload can sit beyond the displayed prefix while the Telegram approval appears complete.
- **Confidence:** **High.** Unit tests explicitly require Edit truncation but do not require disclosure (`tests/unit/hooks/hooks.test.ts:259-268`).
- **Evidence:** direct `.slice(0, 300)` and `.slice(0, 200)` returns have no suffix. The hook executes the original tool input; previewing does not modify it.
- **Adversarial counterargument:** Paths plus the first 300 characters may be enough for routine edits, and Telegram cannot display an arbitrarily large diff. That is a UX constraint, not evidence that the omitted tail is immaterial. This finding would be weakened if a separate trusted diff view were linked in every permission message; none is built here.
- **What a naive fix would miss:** Adding the word “truncated” improves narration but does not authenticate the full payload, show changed regions beyond the prefix, or cover nested MCP inputs whose important fields serialize late.

### 9. Autonomous deny-fast is ordered after `.claude/` auto-approval

- **Root cause:** `src/hooks/hook-permission-telegram.ts:97-101` permits qualifying Edit/Write operations before cron and worker checks at `:103-133`. Thus the header's claim that cron-originated permission requests are denied immediately is false for `.claude/` writes, including settings and skills that influence future agent behavior.
- **Severity:** **HIGH** if PermissionRequest is the effective gate for these writes; autonomous execution can mutate control-plane configuration without the declared denial or suppression event.
- **Confidence:** **High** for control-flow ordering; **Medium** for runtime reachability because Claude permission rules may bypass PermissionRequest entirely for some pre-allowed edits.
- **Evidence:** `outputDecision('allow')` exits before `readCronActive()` and `isWorkerSession()` are evaluated. Existing deny-fast tests mirror selected logic instead of executing the real main path (`tests/unit/hooks/ws11-worker-and-cron.test.ts:174-217`).
- **Adversarial counterargument:** Auto-approving an agent's own `.claude/` tree may be an intentional exception, and current permission configuration might mean this hook never sees those writes. This would be disproved as a defect by an explicit documented exception and an integration test demonstrating the intended autonomous behavior; neither is present in code comments, which state all cron permission requests deny-fast.
- **What a naive fix would miss:** Reordering one guard would not resolve whether workers and crons are allowed to manage their own configuration by policy, nor whether `bypassPermissions` causes the PermissionRequest hook to be skipped before this code runs.

### 10. Worker exits return before the forensics path the file and tests claim is mandatory

- **Root cause:** `src/hooks/hook-crash-alert.ts:294-320` returns immediately for any worker signal, before directory creation, hook-input read, classification, and `crashes.log` append at `:322-411`. The later `isWorker` variable is hard-coded `false`, making the `worker=1` branch (`:407`) and later worker return (`:417`) unreachable.
- **Severity:** **MEDIUM** — alert suppression works, but worker exit evidence is silently absent, undermining crash/worker-leak diagnosis.
- **Confidence:** **High.** This is direct unreachable control flow.
- **Evidence:** The source comment at `:277-280` and test specification at `tests/unit/hooks/worker-suppression.test.ts:9-14` promise worker logging. The tests only simulate copied snippets (`:112-167`) and never run `main`, so they pass while production returns at line 314.
- **Adversarial counterargument:** The early return may deliberately prioritize zero noise and zero worker I/O, making the comments/tests stale rather than runtime behavior wrong. That would be disproved by accepting worker observability as non-requirement and updating the declared invariant; today every local specification says the opposite.
- **What a naive fix would miss:** Moving the return later without revisiting classification/counting could reintroduce the worker crash pages this guard was built to eliminate.

### 11. Multi-user Telegram authorization is validated as a list but callbacks authorize only the first ID

- **Root cause:** Direct caller integration. `src/daemon/agent-manager.ts:524-535` accepts comma-separated `ALLOWED_USER` values, but passes only `allowedUserId.split(',')[0]` to FastChecker (`:567-574`). The callback path has no outer full-list gate (`:808-813`); FastChecker compares against that single number (`src/daemon/fast-checker.ts:894-902`).
- **Severity:** **MEDIUM** — secondary explicitly authorized users can send messages but cannot approve, deny, or answer hook buttons, producing timeouts and misleadingly dead controls.
- **Confidence:** **High.** The comment claiming multi-user is enforced “by the gates above” does not match callback wiring.
- **Evidence:** Message and reaction paths build the full list elsewhere, while callback routing delegates directly to `checker.handleCallback(query)`.
- **Adversarial counterargument:** Product policy may allow multiple message senders but reserve approvals for the first/principal ID. This would be disproved as a bug by documenting that distinction; the `.env` validation calls the entire list `ALLOWED_USER` and describes multi-user group chats without a role split.
- **What a naive fix would miss:** Passing the whole list changes a security boundary and must preserve exact numeric validation, activity-channel behavior, and denial logging; simply removing the FastChecker check would authorize everyone.

### 12. Suppressed and failed lifecycle notices have incomplete observability, and state-root resolution is inconsistent

- **Root cause:** Quiet-hours and dedup returns occur before lifecycle suppression logging (`hook-crash-alert.ts:419-426` versus `:499-504`), so routine notices suppressed by time or duplication leave no `system_ping_suppressed` event. Nearly every filesystem/send error is swallowed (`:89-91,104-106,155,167-178,378-380,409-411,515`). Additionally, crash state ignores `CTX_ROOT` and reconstructs `~/.cortextos/${CTX_INSTANCE_ID}` (`:286-293`), unlike shared `loadEnv` (`src/hooks/index.ts:49-52`).
- **Severity:** **MEDIUM** — audit trails disappear exactly on suppression/failure paths, and nonstandard/test roots can split marker, count, log, and dedup state from the daemon.
- **Confidence:** **High** for ordering and root inconsistency; **Medium** production impact because the daemon normally derives the same home-based root.
- **Evidence:** Lifecycle tests set `HOME` and omit `CTX_ROOT` (`tests/unit/hooks/hook-crash-alert-lifecycle-gate.test.ts:98-168`), so they cannot detect split-root behavior. Tests mock fetch as unconditional HTTP 200 and do not exercise failure logging.
- **Adversarial counterargument:** Quiet-hours suppression may intentionally leave no event to minimize I/O, and production `CTX_ROOT` currently equals the derived home path. This would reduce impact but not the diagnostic blind spot or the contract inconsistency. A hard invariant forbidding custom roots would disprove the split-root concern; `resolveEnv` explicitly supports `CTX_ROOT` overrides (`src/utils/env.ts:55-59`).
- **What a naive fix would miss:** Adding one catch log would not cover early returns, bus subprocess failures, HTTP status failures, or split state locations, and unbounded error logging could itself create a restart storm.

### 13. Structured hook decisions use immediate `process.exit`, creating a low-frequency stdout truncation risk

- **Root cause:** `src/hooks/index.ts:94-107` writes the PermissionRequest JSON and immediately calls `process.exit(0)` without waiting for the write callback or setting `process.exitCode`. The Ask deny-fast path repeats the pattern (`hook-ask-telegram.ts:41-46`). Node stdout is asynchronous when connected to a pipe, which hook runners normally use.
- **Severity:** **MEDIUM** because loss of the decision can invert or defer a permission outcome depending on Claude Code's default behavior.
- **Confidence:** **Medium.** Payloads are small and often flush successfully; this is a timing hazard, not a guaranteed loss. The unit test explicitly says it cannot test stdout plus exit and only reconstructs the expected object (`tests/unit/hooks/hooks.test.ts:476-503`).
- **Evidence:** no write callback, drain handling, or natural process completion follows either write.
- **Adversarial counterargument:** On the deployed Node/platform combination, small writes to the hook pipe may be effectively synchronous. Repeated child-process stress tests showing complete output under pipe backpressure would disprove practical impact.
- **What a naive fix would miss:** Removing `process.exit` without checking open watchers/timers could leave 30-minute hook processes alive; the lifecycle of each caller matters.

## Cross-cutting diagnosis

The dominant pattern is **identity-free coordination**: plan selection is not bound to the current hook payload/session, ask callbacks are not bound to a unique request/message, rate-limit evidence is not bound to the ending session, and crash dedup is keyed only by end type. The second pattern is **best-effort delivery presented as authoritative state**: failed plan delivery authorizes, late callbacks rewrite narration, crash/compact sends ignore API status, and dedup is recorded before delivery. The third is **tests of mirrored logic rather than executable entry points**, which allowed obsolete schema fixtures and unreachable worker-forensics code to look covered.

## Priority interpretation

1. Treat findings 1–2 as the approval-boundary blockers: the operator cannot know that the displayed plan is the pending plan, and degraded review is authorization.
2. Treat findings 3 and 7 as callback-integrity blockers: a valid authorized click is not necessarily a valid decision for the current pending interaction.
3. Treat findings 4–6 as crash-observability blockers: a true crash can be downgraded or silently undelivered, while concurrent firings can still duplicate alerts and corrupt counts.
4. Findings 8–13 are material hardening and test-honesty gaps but do not independently establish an active fleet outage.

No code changes are proposed or implemented in this diagnosis.
