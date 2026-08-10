# Retrieval, Fact Extraction, and Tool-Result Observability — Adversarial Diagnosis

Generated: 2026-08-10 (America/Los_Angeles)  
Scope: `src/hooks/hook-retrieval-enforcer.ts`, `src/hooks/hook-tool-result-router.ts`, `src/hooks/hook-extract-facts.ts`, their registrations, direct callers, and focused tests. Diagnosis only; no fixes proposed or implemented.

## Ranked findings

| Rank | Severity | Confidence | Root cause |
|---:|---|---|---|
| 1 | CRITICAL | High | Fact extraction is nonfunctional at three independent layers: several agents call a nonexistent bus command, generic templates do not register it, and the implementation expects summary fields that `PreCompact` does not send. |
| 2 | HIGH | High | Retrieval's configured 20-second hook budget is smaller than its sequential worst-case work: 20 seconds of subprocess timeouts before unbounded synchronous transcript scans and other overhead. |
| 3 | HIGH | High | Retrieval infrastructure failures are silently rewritten as semantic “no hits,” so operators and the model cannot distinguish an empty KB from timeout, missing executable, permission failure, or store outage. |
| 4 | HIGH | High | The tool-result router is dormant fleet-wide, and even if registered it cannot report failed tool calls or modern Bash durations accurately. |
| 5 | HIGH | High | Retrieval claims provenance and recency it does not provide: month/week/history prompts search only three days, transcript excerpts omit source paths, and selection is score-first rather than recency-first. |
| 6 | HIGH (latent) | High | Enabling the router would persist unredacted, unbounded tool inputs/results—including file content and secrets—to org analytics, with no payload cap. |
| 7 | MEDIUM | High | `hook-extract-facts` leaves a live ten-second timer after stdin closes; a standalone invocation measured 10.08 seconds even when it returned no fact. |
| 8 | MEDIUM | High | Retrieval's advertised KB cache is write-only metadata; qualifying prompts rerun KB search every time, increasing latency and timeout probability. |
| 9 | MEDIUM | Medium-high | Cache/event persistence is not atomic under concurrent hook processes; interruption or parallel calls can reset retrieval state or corrupt/interleave large JSONL events. |
| 10 | MEDIUM | Medium-high | Retrieved and compacted text is treated as authoritative control-bearing text without trust boundaries, creating stored prompt-injection and memory-integrity surfaces. |
| 11 | MEDIUM | High | Tests pass while bypassing the broken lifecycle contracts: no fact-hook main/schema/registration test and no direct router parsing, delivery, failure, or duration test. |

## 1. Fact extraction is dead at registration, command, and event-schema layers

**Root cause:** `hook-extract-facts.ts` models a `PreCompact` payload with `summary`, `transcript`, and `turns` (`src/hooks/hook-extract-facts.ts:22-27`) and returns without writing unless one of those invented summary sources is present (`:100-106`). Current Claude Code `PreCompact` input provides `trigger` and `custom_instructions` plus common fields; the generated summary is a `PostCompact.compact_summary` field, not a `PreCompact.summary` field. Independently, six active agent settings files invoke `cortextos bus hook-extract-facts`, but the bus command table jumps from `hook-compact-telegram` through other hooks without ever declaring `hook-extract-facts` (`src/cli/bus.ts:4569-4612`). Running the built CLI produced `error: unknown command 'hook-extract-facts'`. The generic agent, analyst, and orchestrator templates register only `hook-compact-telegram` in `PreCompact` (for example `templates/agent/.claude/settings.json:95-105`).

**Severity:** CRITICAL. The advertised automatic fact/checkpoint pipeline produces no facts in both newly scaffolded and explicitly wired agents.

**Confidence:** High. This is confirmed by source, fleet settings, runtime CLI behavior, and the current primary hook schema in the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#precompact). The same reference documents `compact_summary` under `PostCompact`.

**Evidence:**

- Implementation contract: `src/hooks/hook-extract-facts.ts:22-27,100-106`.
- Unconditional direct entry point, but no bus entry: `src/hooks/hook-extract-facts.ts:139`; `src/cli/bus.ts:4569-4612`.
- Broken live registrations include `orgs/clearworksai/agents/sage/.claude/settings.json:83-95`, CRM `:84-96`, and Auditos `:69-81`; a current-settings scan found six such files.
- Template omission: `templates/agent/.claude/settings.json:95-105`, `templates/analyst/.claude/settings.json:95-105`, `templates/orchestrator/.claude/settings.json:84-94`.
- Runtime probe: `node dist/cli.js bus hook-extract-facts` returns unknown command.

**Adversarial counterargument / what would disprove it:** A deployment could carry a patched CLI not represented by this checkout, or a wrapper could transform `PreCompact` input into the custom `summary` shape. Recent real `## Compact-time checkpoint` entries proven to originate from this hook, plus a deployed `bus hook-extract-facts` help entry and captured payload containing `summary`, would disprove the fleet-level conclusion. No such wrapper or command exists in the audited repository.

**What a naive fix would miss:** Addressing only registration still leaves the command and payload contract broken; adding only the command still yields empty payloads; changing only the event field still leaves new templates and already-generated agents divergent.

## 2. Retrieval can exceed its entire timeout before transcript work finishes

**Root cause:** `buildAdditionalContext` performs all expensive work serially (`src/hooks/hook-retrieval-enforcer.ts:473-481`). `recentCommits()` permits a 3-second `git rev-parse` and a 5-second `git log` (`:313-331`), then `kbQuery()` permits another 12 seconds (`:174-187`). Those caps already total the 20-second `UserPromptSubmit` setting (`templates/agent/.claude/settings.json:20-27`). After/between them, the hook synchronously discovers, fully reads, splits, and scans as many as 14 transcript JSONL files (`src/hooks/hook-retrieval-enforcer.ts:204-239,247-289`) with no byte, line, or wall-clock budget.

**Severity:** HIGH. On a slow KB/git/filesystem turn, Claude cancels the hook and discards all `additionalContext`; retrieval silently disappears exactly when the dependency is unhealthy or transcripts are large.

**Confidence:** High. The sequential ordering and timeout arithmetic are explicit. The current Claude documentation states that a timed-out `UserPromptSubmit` command hook has its output discarded while the prompt proceeds.

**Adversarial counterargument / what would disprove it:** Production p99 measurements could show git, KB, and transcript scans always complete comfortably below 20 seconds. That would reduce current incidence, but not the structural race: the configured outer deadline is not greater than the sum of inner caps. Bounded transcript sizes and hook latency telemetry with substantial headroom would disprove practical severity.

**What a naive fix would miss:** Raising only the outer timeout does not bound full-file scans, synchronous memory use, or repeated KB work; lowering only one subprocess timeout can increase false empty retrievals while preserving silence.

## 3. Operational failures are narrated as “no hits”

**Root cause:** `kbQuery()` suppresses child stderr and converts every exception—timeout, missing `cortextos`, nonzero exit, bad configuration—to `''` (`src/hooks/hook-retrieval-enforcer.ts:179-190`). `buildAdditionalContext()` then labels that indistinguishable empty string as “MMRAG: no hits above threshold” (`:483-489`). Git, transcript, cache-read, and cache-write errors are also swallowed (`:204-235,253-259,313-339,389-417`), and the top-level rejection handler exits successfully without output (`:541-543`). The generic hook runner also maps a signal-killed child (`status === null`) to exit 0 (`src/cli/bus.ts:3234-3237`).

**Severity:** HIGH. A store outage becomes false epistemic guidance rather than an operational fault, while the success exit prevents ordinary hook error surfaces or health monitors from seeing it.

**Confidence:** High. Every error branch is explicit and there is no event/log/metric call in the retrieval hook.

**Adversarial counterargument / what would disprove it:** A separate supervisor could correlate hook debug notices, child duration, and KB health independently. That would improve operator visibility, but it would not correct the misleading context emitted to the model. Evidence of a structured status returned by `kb-query` and consumed here would disprove the conflation; none is consumed.

**What a naive fix would miss:** Merely changing the words “no hits” does not create a machine-observable distinction among semantic zero results, timeout, corrupt output, missing config, and executable failure.

## 4. Tool-result observability is dormant and its success narration is schema-stale

**Root cause:** The CLI exposes `hook-tool-result-router` (`src/cli/bus.ts:4599-4602`), but a scan of all current `orgs/**/.claude/settings.json`, all three generic templates, and `~/.claude/settings.json` found zero registrations for that command. Existing `PostToolUse` registrations run unrelated JSON-validation/WAL hooks. If the router were registered, current `PostToolUse` fires only after successful tool calls; failures are a separate `PostToolUseFailure` event. Yet the router advertises and computes `fail` statuses (`src/hooks/hook-tool-result-router.ts:197-225`) and has no failure-event parser. It also omits the top-level `duration_ms` field from `HookPayload` (`:28-33,40-48`) and passes only `tool_response` into `bashStatus` (`:283-284`), although current hook input puts duration at top level. Thus modern Bash duration is lost, and “fail” is generally unreachable for genuine execution failures.

**Severity:** HIGH. The claimed activity stream is absent; enabling it as-is would still omit the most important class of events and misrepresent duration/status.

**Confidence:** High. Registration count is zero in current settings, and the event contracts are documented in the [official PostToolUse/PostToolUseFailure reference](https://code.claude.com/docs/en/hooks#posttooluse).

**Adversarial counterargument / what would disprove it:** An out-of-repository policy-managed settings layer could register the command, and an older Claude build could embed duration/exit code inside `tool_response`. A captured live payload plus recent `agent_activity/tool_result` events from this hook would disprove dormancy/schema impact. The audited global user settings also do not register it.

**What a naive fix would miss:** Registration alone would create a success-only, potentially high-volume stream with stale formatting and the security/size hazards below. Teaching `bashStatus` another exit-code spelling would not observe the separate failure event or recover top-level duration.

## 5. Retrieval provenance, time range, and “recency-first” narration are false

**Root cause:** The intent regex explicitly triggers on “last week,” “last month,” and “history” (`src/hooks/hook-retrieval-enforcer.ts:24-33`), but transcript enumeration hard-codes a three-day mtime cutoff (`:204-238`). Candidate selection sorts by keyword score before file recency (`:292-305`) and only sorts timestamps after eight candidates have already been selected (`:307-310`). Output claims “recency-first jsonl reads” (`:497-499`) but prints timestamp and role only, omitting `candidate.filePath` (`:307-310`), despite the directive requiring path/timestamp citations (`:22`).

**Severity:** HIGH. The injected context can look complete and well-sourced while systematically excluding the requested period and making excerpts unauditable across files/sessions.

**Confidence:** High. The contradictory constants, ordering, labels, and output fields are explicit.

**Adversarial counterargument / what would disprove it:** KB hits may cover older periods, and the directive tells the model to search deeper when evidence is thin. That does not disprove the transcript claim: partial three-day hits may look non-thin, and the output still lacks file provenance. A test demonstrating a month-old transcript returned with a source path would disprove it; current logic cannot do so.

**What a naive fix would miss:** Widening the cutoff alone worsens the unbounded scan; adding paths alone does not correct score-first selection, duplicated excerpts, or the mismatch between user time intent and searched window.

## 6. Router persistence is an unredacted, unbounded disclosure and storage sink

**Root cause:** The router writes the complete `tool_input` and `tool_result` to org analytics (`src/hooks/hook-tool-result-router.ts:286-296`). For `Write`, this includes entire file content; Bash commands frequently carry tokens/credentials; reads and agent results may contain sensitive customer data. Neither input parsing (`:40-48`) nor event logging applies redaction or a size cap. `readStdin()` buffers the entire payload (`src/hooks/index.ts:14-20`), and `logEvent()` JSON-stringifies and appends it as one event (`src/bus/event.ts:45-65`).

**Severity:** HIGH (latent while unregistered). If enabled, confidentiality exposure and disk growth occur once per successful tool call and feed the dashboard-visible analytics store.

**Confidence:** High for behavior; exposure impact depends on analytics filesystem/dashboard access controls and actual payload contents.

**Adversarial counterargument / what would disprove it:** Strong filesystem ACLs, dashboard authorization, upstream redaction, and hard payload limits before stdin could constrain exposure. The audited hook performs none of those checks, and the official schema explicitly shows `Write.tool_input.content`.

**What a naive fix would miss:** Truncating only Telegram is irrelevant—the Telegram line is already capped at 200 characters (`:26,305`); the sensitive full payload is the separately persisted analytics metadata.

## 7. Fact extraction's timeout race leaves the process alive for ten seconds

**Root cause:** `Promise.race` creates a ten-second timer but never retains or clears its handle (`src/hooks/hook-extract-facts.ts:81-89`). When stdin closes immediately, `readStdin()` wins, main may return at `:106` or complete the append, but the pending timer keeps the Node event loop alive. The success path does not call `process.exit`; only rejection does (`:139`).

**Severity:** MEDIUM. If the command becomes reachable, every invocation delays compaction by about ten seconds and runs close to the 15-second timeout in current agent settings.

**Confidence:** High. A standalone built-hook probe with `{"summary":"short"}` completed in 10.08 seconds. The focused Vitest suite did not reveal this because the test runner owns process lifetime.

**Adversarial counterargument / what would disprove it:** An invocation wrapper could forcibly exit the child immediately after output/write, or the timer could be unref'd in the built artifact. The current built artifact exhibited the delay, so this is not theoretical.

**What a naive fix would miss:** Increasing the settings timeout would hide cancellation but preserve a deterministic ten-second compaction stall and still not solve the nonexistent command/schema.

## 8. The KB cache records metadata but never caches or suppresses a query

**Root cause:** cache state stores `lastKbQueryNormalized`, `lastKbResultHash`, and `lastKbResultAtMs` (`src/hooks/hook-retrieval-enforcer.ts:43-50,399-405`), and every included query overwrites them (`:512-515`). No decision reads those fields. `shouldRunKbQuery()` depends only on the current prompt/strong keywords (`:438-440`), and `buildAdditionalContext()` calls `kbQuery` whenever that predicate is true (`:476,480`).

**Severity:** MEDIUM. Repeated or semantically identical prompts rerun the expensive KB subprocess, compounding the timeout/rate/resource problem and contradicting the hook's “selective/cached” CLI description (`src/cli/bus.ts:4610-4612`).

**Confidence:** High. Repository references to these fields are limited to parse/write assertions; no cache-hit branch exists.

**Adversarial counterargument / what would disprove it:** The underlying KB CLI may have its own cache. That could reduce compute, but this hook still spawns it and pays startup/deadline cost. A read-side comparison against these fields would disprove the finding; none exists.

**What a naive fix would miss:** Reusing only the stored hash cannot reconstruct prior result text, and prompt normalization truncates at 280 characters (`:105-107`), so a simplistic equality cache would introduce collisions/staleness without a defined TTL or invalidation signal.

## 9. Non-atomic state and concurrent event writes undermine self-healing

**Root cause:** retrieval state is a read-modify-overwrite JSON file (`src/hooks/hook-retrieval-enforcer.ts:389-417`) written with `writeFileSync`, contrary to the repository's atomic-write pattern. A kill during write makes the next read silently reset to `{turnCount: 0}` (`:389-407`), replaying first-turn context and expensive work. Parallel/resumed processes can lose increments and metadata. Separately, current Claude Code runs `PostToolUse` hooks concurrently for parallel tool calls, while the router's potentially large JSON events reach `appendFileSync` with no coordination (`src/bus/event.ts:54-65`). Large write-all operations can interleave under competing processes or amplify disk contention.

**Severity:** MEDIUM. The retrieval failure self-heals in the wrong direction—by silently resetting and increasing workload—and router event-stream integrity becomes least reliable during parallel activity.

**Confidence:** High for non-atomic cache overwrite and reset behavior; medium for observed JSONL interleaving because it depends on filesystem/write size scheduling.

**Adversarial counterargument / what would disprove it:** Strictly serialized prompts, no overlapping resumes, small event writes, and filesystem guarantees observed under stress could make races rare. A crash/concurrency test proving valid monotonic cache/event files would reduce severity. No such test exists.

**What a naive fix would miss:** Atomic rename alone prevents torn cache JSON but not lost updates between two read-modify-write processes; serializing event appends alone does not cap the unbounded payload or protect confidentiality.

## 10. Retrieved/compacted text crosses trust boundaries as instructions and structure

**Root cause:** transcript hits accept any parsed role (`src/hooks/hook-retrieval-enforcer.ts:133-153,282-289`) and inject the text beneath a directive that commands the model to answer from it (`:22,523-528`), without stating that embedded instructions are untrusted data. If `CTX_AGENT_NAME` is absent, transcript directory filtering intentionally admits every project (`:204-210`), creating cross-project context leakage. Fact extraction writes the generated summary verbatim as Markdown (`src/hooks/hook-extract-facts.ts:122-132`); `recall-facts` later splits on attacker-reproducible `## Compact-time checkpoint` / `## Session` headings (`src/cli/bus.ts:1046-1063`), so content can forge additional remembered sections if the pipeline is revived.

**Severity:** MEDIUM. This is a stored prompt-injection/memory-integrity surface and becomes a cross-agent confidentiality issue when required environment identity is missing.

**Confidence:** Medium-high. The trust-boundary absence is explicit; exploitability depends on whether untrusted web/user/tool text enters eligible transcript text or compact summaries and whether environment identity can be missing.

**Adversarial counterargument / what would disprove it:** A guaranteed trusted-only corpus, strict upstream role filtering, mandatory validated `CTX_AGENT_NAME`, and downstream instruction/data separation could eliminate the exploit path. Those guarantees are not enforced here.

**What a naive fix would miss:** Filtering only `role === user` does not make user content trusted; escaping Markdown headings does not neutralize instructions in retrieval context; requiring agent name does not authenticate the provenance of KB/transcript content.

## 11. Passing tests mask lifecycle and schema failures

**Root cause:** `tests/unit/hooks/extract-facts.test.ts:1-52` tests only `extractKeywords`, never `main`, event payload compatibility, memory output, registration, or process lifetime. Router coverage in `tests/unit/hooks/telegram-suppression-guards.test.ts:170-208` is a reimplemented “mirror” of two guard branches, not the actual parser/formatter/logger/fetch path; the only actual module assertion is importability (`:210-218`). Retrieval tests mock every subprocess (`tests/unit/hooks/hook-retrieval-enforcer.test.ts:6-10,78-91`) and do not exercise elapsed deadlines, large transcripts, operational error distinction, provenance, or concurrent cache writes. All 34 focused tests pass.

**Severity:** MEDIUM. Green tests provide false assurance around precisely the integration contracts that are broken.

**Confidence:** High. Test bodies and the passing targeted run were inspected directly.

**Adversarial counterargument / what would disprove it:** Separate end-to-end hook tests may exist outside the searched repository or deployment validation could cover these contracts. No directly relevant tests/callers found by graph-first discovery and repository-wide fallback search do so.

**What a naive fix would miss:** Adding more helper-unit assertions would not validate the actual CLI command, settings registration, current lifecycle payloads, timeout/process behavior, failure-event coverage, or durable output.

## Cross-cutting conclusion

The dominant failure pattern is “fail-open and say nothing.” Fact extraction is currently dead rather than degraded. Retrieval is live in templates and two current agent settings, but its deadline, scan strategy, and error collapsing make absence of context indistinguishable from absence of knowledge. Tool-result routing is dormant; activating it without addressing its current contracts would trade zero observability for success-only, schema-stale, potentially sensitive and unbounded telemetry. These are independent failure layers, so evidence that any one layer works does not establish end-to-end health.

No `audit-*.md` files were present in `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/sage-codex/memory`, so there was no prior sage-codex weekly audit artifact to reconcile.
