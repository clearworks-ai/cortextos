# State, Context, and Loop-Control Hooks — Adversarial Diagnosis

Generated: 2026-08-10
Scope: `hook-loop-detector.ts`, `hook-context-status.ts`, `hook-idle-flag.ts`, `hooks/lib/session-context.ts`, `system-pings.ts`, and directly relevant callers/tests. Diagnosis only.

No `memory/audit-*.md` files were present under `sage-codex` to cross-reference. Code discovery used the codebase-memory graph first; targeted `rg` was used only where hook registration/config files and the graph's missing `system-pings` inbound edges required it.

## Ranked findings

### 1. Cron-originated turn detection is removed before the turn begins

- **Root cause:** `src/daemon/agent-manager.ts:1419-1448` writes `.cron-active`, calls the synchronous prompt-injection method at `:1439`, and unlinks the marker in `finally` at `:1443-1448`. `AgentManager.injectAgent()` / `injectAgentDetailed()` (`src/daemon/agent-manager.ts:1319-1337`) return only the immediate enqueue result; they do not await the agent's turn. Therefore, by the time later tool hooks call `readCronActive()` (`src/hooks/lib/session-context.ts:19-39`), the marker is normally already absent.
- **Severity:** HIGH
- **Confidence:** High. The lifetime mismatch is explicit in the control flow. The unit test `tests/unit/daemon/agent-manager-cron-active.test.ts:64-84` only proves the marker exists *inside the synchronous inject call*, then incorrectly labels immediate cleanup as “after the turn.” It does not execute a later PreToolUse/PostToolUse hook.
- **Evidence:** `shouldDenyFast()` is consumed later by AskUserQuestion, ExitPlanMode, and tool-result hooks (`src/hooks/hook-ask-telegram.ts:32-47`, `hook-planmode-telegram.ts:94-105`, `hook-tool-result-router.ts:278-303`); `hook-permission-telegram.ts:103-123` independently relies on the same marker. With the marker gone, cron turns take the interactive path, including Telegram approval/question flows that can wait for a human.
- **Adversarial counterargument:** This would be false if `injectAgent()` blocked until the full model turn and all hooks completed. Its implementation disproves that: it returns `entry.process.injectMessageDetailed(text).ok` synchronously. Runtime evidence showing `.cron-active` present during actual later hook execution would disprove the practical impact, but the current lifecycle provides no such retention path.
- **What a naive fix would miss:** Merely retaining a global marker for ten minutes would misclassify an overlapping human-originated turn as cron-originated. The state model has no turn/session/receipt identity, and a single per-agent file cannot safely represent concurrent provenance. Tests must cover hook execution after asynchronous injection and overlap with a human message, not only marker existence during enqueue.

### 2. The context-status hook keeps every real write process alive for 1.5 seconds

- **Root cause:** `src/hooks/hook-context-status.ts:52-58` creates a 1.5-second timeout but never stores or clears it when stdin ends/errors. The successful path has no explicit exit (`:79-81`), so the live timer keeps Node's event loop open after the atomic write.
- **Severity:** MEDIUM
- **Confidence:** High. A direct built-hook probe with complete stdin took **1.67 seconds real time** while successfully writing the file. The configured statusLine timeout is only two seconds (`src/cli/bus.ts:4864-4869`), leaving roughly 330 ms for CLI startup, scheduling, filesystem latency, and load spikes.
- **Evidence:** The stated contract says the hook “must complete quickly” (`hook-context-status.ts:12-13`), yet every non-debounced successful execution sits near the hard timeout. Under load, the host can kill the hook close to or during its write, converting ordinary latency into stale/missing telemetry.
- **Adversarial counterargument:** If the statusLine host forcibly reaps the complete subprocess immediately after consuming output, the dangling timer may not matter. The measured standalone CLI path shows normal Node lifecycle does wait for it, and the hook produces no stdout that would give the host an earlier completion signal.
- **What a naive fix would miss:** Raising the two-second hook timeout only hides the leak and increases process overlap. Timer cleanup must cover `end`, `error`, timeout, parse failure, and write failure; tests need a wall-clock/handle-liveness assertion rather than only payload assertions.

### 3. The mtime debounce can discard the only fresh-session or threshold-crossing sample

- **Root cause:** `src/hooks/hook-context-status.ts:44-48` checks output-file mtime and returns before reading stdin. It does not know whether the skipped payload carries a different `session_id`, a newer context percentage, or a transition into/out of overflow.
- **Severity:** MEDIUM
- **Confidence:** High for data loss; Medium for incident frequency. A fresh pre-existing status file followed immediately by a `session_id:new, used_percentage:99` invocation exited in ~0.18 s and left the old payload unchanged.
- **Evidence:** FastChecker trusts any status younger than ten minutes and only resets per-session handoff state after it observes a changed non-null session ID (`src/daemon/fast-checker.ts:1300-1364`). Dropping the first new-session sample can temporarily preserve a stale high reading and stale session identity, exactly where wrong handoff/restart decisions are most expensive. Conversely, dropping an upward threshold crossing delays warning/handoff until a later refresh.
- **Adversarial counterargument:** Sequential Claude statusLine invocations may normally be more than 500 ms apart—especially because of finding 2—so this path may be rare. It remains reachable through overlapping hook processes or another writer touching the shared file; evidence that the host strictly serializes all writers and always produces a follow-up sample before FastChecker polls would lower severity.
- **What a naive fix would miss:** Removing debounce without first fixing the leaked timer can amplify process churn. Debouncing by output-file age is the wrong granularity: session changes and safety-state transitions cannot be coalesced like redundant same-session samples.

### 4. Hook state paths are split between two root-resolution contracts, and loop state permits an empty shared identity

- **Root cause:** `hook-context-status.ts:37-42` and `hook-loop-detector.ts:257-260` use `CTX_ROOT` (falling back to `~/.cortextos/default`), while `hook-idle-flag.ts:15-22` derives `~/.cortextos/${CTX_INSTANCE_ID}` and `system-pings.ts:34-39` calls `resolvePaths()`, which also derives `~/.cortextos/${instanceId}` (`src/utils/paths.ts:26-49`) and ignores `CTX_ROOT`. Additionally, the loop detector converts a missing `CTX_AGENT_NAME` to `''` (`hook-loop-detector.ts:257`) and writes under the instance-wide `state/` root, whereas the other state hooks return when identity is missing.
- **Severity:** MEDIUM
- **Confidence:** High for code/schema drift; Medium for production impact because standard `AgentPTY` currently sets both variables consistently (`src/pty/agent-pty.ts:98-105`). A prior internal review already disclosed the mismatch as an unfixed follow-up (`.agent/one-big-feature/daemon-supervision-liveness-watchdog/PR-BODY.md:46-48`).
- **Evidence:** With a custom `CTX_ROOT`, context telemetry/loop state and idle/suppression events can land in different instance trees. FastChecker reads its resolved `paths.stateDir`, so a misplaced `last_idle.flag` produces up to ten minutes of false “typing,” and a misplaced suppression event disappears from the expected activity feed. Missing agent identity makes unrelated manual/degraded hook invocations share `state/loop-detector.json` and its lock.
- **Adversarial counterargument:** In the daemon-managed happy path, `CTX_ROOT` equals `~/.cortextos/${CTX_INSTANCE_ID}` and `CTX_AGENT_NAME` is always set, so no divergence occurs. This finding is disproved operationally only if custom roots/manual invocation are unsupported invariants and validated before every hook launch; the code currently documents neither invariant nor rejects violations consistently.
- **What a naive fix would miss:** Changing only `hook-idle-flag` leaves `system-pings` and `hook-crash-alert` on the alternate resolver. Changing only fallbacks leaves the empty-agent shared namespace. The path contract needs one canonical state-dir input and consistent identity validation across every writer/reader.

### 5. Loop-detector lock timeout equals the entire hook budget, producing a silent fail-open path

- **Root cause:** `hook-loop-detector.ts:260-269` acquires the generic synchronous file lock without custom timing. `withFileLockSync` waits up to 5,000 ms (`src/utils/lock.ts:113-136`), while the installed PreToolUse hook timeout is also five seconds (`templates/agent/.claude/settings.json:52-59`, mirrored by the other core templates). The top-level rejection handler silently exits zero (`hook-loop-detector.ts:283`), and state-save errors are independently swallowed (`:112-118`).
- **Severity:** MEDIUM
- **Confidence:** High for the failure mode; Medium for frequency. Any contention, stuck live-PID lock, filesystem latency, or state-write failure makes the enforcement hook consume its whole host budget or lose persistence, then allow the tool call with no diagnostic event.
- **Evidence:** There is no time margin for CLI startup or error reporting. A timeout killed by the hook host cannot reach the catch at all; an internal throw that does reach it is indistinguishable from success because the handler exits zero. Repeated save failure prevents history accumulation, disabling loop detection indefinitely.
- **Adversarial counterargument:** A single agent PTY usually invokes PreToolUse serially, so contention should be uncommon, and atomic state writes reduce corruption. Parallel sessions/manual invocations sharing one agent state, a stale lock, or the empty-agent path in finding 4 defeats that assumption. Runtime lock-contention metrics showing zero waits over representative fleet history would lower priority.
- **What a naive fix would miss:** Shortening the lock wait without defining an explicit contention policy increases immediate fail-open frequency. Extending the hook timeout worsens tool latency. The missing piece is observable, bounded behavior under contention and write failure, plus recovery that distinguishes “detector unavailable” from “call allowed.”

### 6. The advertised 30-minute emergency escape is unreachable in normal monotonic time

- **Root cause:** Loop evidence expires after 60 seconds (`hook-loop-detector.ts:38-44`, `:199`), blocked calls are not recorded (`:242-248`), and the emergency escape requires 30 minutes of continuous blocking (`:223-229`). Once the original history ages past 60 seconds, `wouldBlockReason` becomes null, the next call is allowed, and `firstBlockedAt` is reset (`:212-220`) long before 30 minutes.
- **Severity:** MEDIUM
- **Confidence:** High. The escape unit test fabricates a state with a 30-minute-old `firstBlockedAt` and simultaneously fresh alternating history (`tests/unit/hooks/loop-detector.test.ts:157-168`), a combination the production transition function cannot naturally produce.
- **Evidence:** The self-healing/narration contract at `hook-loop-detector.ts:17-20` and alert text at `:238` cannot occur under the configured constants. Ping-pong is worse during the first minute: detection counts historical alternations across the pair (`:149-160`), so even a third, fundamentally different tool can remain blocked while the triggering pair is retained; blocked alternatives cannot enter history to prove the workflow changed.
- **Adversarial counterargument:** Clock rollback, hand-edited state, or another writer continuously injecting fresh history could make the escape branch reachable. Those are not the claimed “continuously blocked” production state machine. A property test generating only valid transitions and reaching `action:'escape'` would disprove this finding.
- **What a naive fix would miss:** Lowering the escape timer alone does not fix the ping-pong wedge or define which tool should be allowed for recovery. Recording every blocked call recreates the self-perpetuating loop the current comments warn against. Recovery semantics must distinguish a genuinely different action from another member of the blocked pattern.

### 7. Safety-state degradation is intentionally silent, so stale state looks healthy

- **Root cause:** All assigned hooks collapse materially different failures into success/no-op: malformed cron markers return interactive mode (`session-context.ts:19-38`); loop-state parse/write/entry-point failures become empty state or exit zero (`hook-loop-detector.ts:88-118`, `:283`); context parse/write failures return or exit zero (`hook-context-status.ts:60-81`); idle writes swallow errors (`hook-idle-flag.ts:19-26`); suppression-event logging catches every error (`system-pings.ts:28-43`).
- **Severity:** MEDIUM
- **Confidence:** High. This is explicit control flow, not an inferred exception path.
- **Evidence:** The downstream readers cannot tell “healthy and idle/interactive/allowed” from “writer broken.” FastChecker silently skips unreadable/stale context (`fast-checker.ts:1307-1341`), and unreadable idle state is interpreted as active (`:1880-1892`). No counter, last-error marker, rate-limited stderr, or repair attempt exposes repeated failures.
- **Adversarial counterargument:** Hooks must never block Claude/compaction, and stderr itself can become user-visible noise; fail-open/best-effort behavior is defensible. That argues for non-blocking diagnostics, not for making persistent safety-control failure indistinguishable from success. Evidence that daemon-level health checks already monitor each artifact's freshness/write failures would reduce this gap; no such end-to-end health signal was found in the reviewed callers.
- **What a naive fix would miss:** Throwing or exiting nonzero would turn observability faults into agent outages. Diagnostics must be bounded and recursion-safe (for example, rate-limited state/event health markers), and recovery must avoid relying on the same broken path it is reporting.

## Cross-cutting conclusion

The highest-risk defect is not a parser edge case but a provenance/lifecycle mismatch: per-turn facts are represented by per-agent files with lifetimes unrelated to actual turns. The context debounce, cron marker, idle flag, loop history, and suppression logs all assume one serialized writer and perfectly aligned environment paths. Tests mostly validate isolated payload shapes and synchronous moments; they do not exercise asynchronous turn duration, overlapping producers, hook-budget exhaustion, or degraded filesystem behavior. No CRITICAL finding was established from the reviewed evidence; finding 1 is HIGH, and findings 2–7 are MEDIUM.
