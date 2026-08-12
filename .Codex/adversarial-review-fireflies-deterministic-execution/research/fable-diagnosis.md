# Fable Adversarial Diagnosis — Fireflies Deterministic Execution

Date: 2026-08-11  
Mode: diagnosis only; no production code changed

## Recovered intent

After every meaningful meeting, cortextOS should remove the follow-up burden from Josh. A webhook should start one durable run that turns the meeting into operational outcomes: the meeting record is filed, Josh's commitments become visible tasks/reminders, the client recap becomes a real draft awaiting approval, CRM records and opportunity/deal candidates are handled safely, and PA returns one concise receipt saying what was created and what needs review.

The assistant is not successful because it received the webhook, spawned a worker, wrote a Markdown note, or emitted an internal event. It is successful only when those user outcomes exist or the run ends in a visible, retryable failure.

## Verdict

This is simultaneously a deployment failure, a contract regression, and an execution architecture failure.

1. Both real webhooks were received and both writeback workers ran. Triggering is not the missing boundary.
2. The live writeback workers ran under `pa-codex` and executed its stale plugin/extractor path. Their payloads defaulted to `meeting_type=other` and `commitmentIds=[]`, even when the transcript plainly described a sales/deal event and multiple commitments.
3. The daemon treated writeback success as meeting success, dispatched downstream consumers, and permanently recorded their dedupe keys before their outcomes were known. The deterministic Python consumers were detached with stdout/stderr discarded. There is therefore no durable evidence that either consumer succeeded, and a failed first attempt is not naturally retryable.
4. The coordinator independently recovered both transcripts and wrote useful Markdown recap/tracker documents, but it was explicitly forbidden to create tasks because the prompt assumed fanout had already done so. Fanout produced no commitment tasks, approvals, reminders, followup rows, or Telegram receipt. Both coordinator PTYs later hit the ten-minute reaper despite printing `DONE`.
5. The current meeting-chain spec had already narrowed the frozen system intent: actual Gmail drafts and approval surfaces became a Markdown "recap DOC" in a backend-only chain. Automatic creation/proposal of a new CRM opportunity was never made an explicit requirement at all.
6. Repair commits `352e6078`/`56f2157c` and `2fb8c535` were not ancestors of production `main` (`5389b713`) and were not in the running build. Even if merged, the tests still prove payload construction and dispatch, not the end-user outcome.

Highest-confidence root cause of the missing user outcome: cortextOS has no durable definition or transaction for "meeting handled." It marks intermediate boundaries successful, runs critical work through unsupervised LLM sessions and detached subprocesses, and has no mandatory PA-visible completion receipt. The two meetings exposed several manifestations of that same architectural error.

## Evidence sources and method

Code discovery used the codebase-memory graph first for:

- `createBridgeServer`
- `trySpawnMeetingWriteback`
- `trySpawnWorkerForEvent`
- `planWorkerSpawn`
- `AgentManager.spawnWorker`
- `WorkerProcess`
- `maybeEmitMeetingEvent`
- `dispatchMeetingConsumers`

Shell inspection was then limited to exact known files, git history/reflog/branches, configs, and live logs/artifacts. No production scripts were re-run and no CRM data was mutated.

## End-to-end path and exact boundaries

| Boundary | Code | What it actually proves | What it does not prove |
|---|---|---|---|
| Webhook accepted | `src/cli/webhook-bridge.ts:693-1002` | HMAC/body/target accepted | No work completed |
| Spawn request accepted | `src/daemon/worker-spawn-plan.ts:92-115` | IPC returned `success` for `spawn-worker` | Worker script has not finished |
| Worker started | `src/daemon/agent-manager.ts:1211-1294`; `src/daemon/worker-process.ts:20-194` | PTY is running | Correct skill/version or outputs |
| Writeback success | `/tmp/ff-meeting-event-<id>.json` and `meeting_writeback.py` | Meeting/client note written and payload says `writeback_ok=true` | Commitments, drafts, tasks, CRM, or PA receipt |
| Event emitted | `src/daemon/meeting-event-emit.ts:110-191` | Bus message `crm.meeting.completed` sent | Consumers succeeded |
| Consumer "dispatched" | `src/daemon/meeting-consumer-dispatch.ts:158-293` | `spawn()` call did not synchronously throw | Child exit, stdout, stderr, side effect, or retryability |
| Coordinator spawned | same file, lines 191-216 | LLM PTY started | It completed or surfaced its result |
| User outcome | no owning component | Nothing | This boundary is absent |

Critical code facts:

- `createBridgeServer` returns HTTP 200 immediately after daemon spawn acceptance.
- `firefliesWritebackTemplate` asks an LLM to read a skill and execute bash blocks. The event-to-script path is therefore not deterministic control flow even though the event itself is deterministic.
- `WorkerProcess.terminate('terminate')` can finalize a forced termination as completed and fire `onDone` with a default zero exit. Payload presence partially guards this for writeback, but not the complete meeting outcome.
- `maybeEmitMeetingEvent` defines success only as worker exit zero plus `writeback_ok=true`. Its own unit test explicitly treats a payload missing `meeting_type`, attendees, client, and commitment IDs as completed by substituting `other` and empty arrays (`tests/unit/daemon/meeting-event-emit.test.ts:167-181`). The two live payloads match that tolerated degraded shape.
- `defaultSpawnScript` uses `{detached:true, stdio:'ignore'}` (`meeting-consumer-dispatch.ts:95-98`).
- `runConsumer` writes the fire-once dedupe record before action and reports `dispatched` after the spawn call, not after child success (`meeting-consumer-dispatch.ts:263-293`).
- `meeting-crm-sync.py` logs and skips individual failed contact/interaction writes and normally exits zero. It can only update an already matching engagement; `find_matching_engagement` returning none yields `no_engagement_for_contact`. It cannot create/propose a new opportunity.
- `meeting-fanout.py` returns zero fanout when extraction yields no usable meeting/commitments. Its command wrapper turns subprocess failure into empty output, and its main returns zero with a zero-result summary.
- The coordinator prompt says fanout already created tasks/followup rows and explicitly forbids it from creating them. That assumption was false for both live meetings.

## Live reconstruction

### Meeting 01KZCGVH6HYN9XX4124033CTJV — MSIA / Wendy Vahanian

| Stage | Evidence | Result |
|---|---|---|
| Webhook/bridge | `pa-codex/inbound-messages.jsonl`, `2026-08-11T20:51:23.428Z` | PASS |
| Worker start | daemon log: `meeting-writeback-...` running in `agents/pa-codex` | PASS |
| Extract/writeback | worker log: extractor rc 0, writeback rc 0, one meeting filed | PASS only for note writeback |
| Meeting note | `orgs/clearworksai/knowledge/meetings/2026-08-11-msia-wendy-vahanian-and-josh-weiss.md`, mtime 13:53:17 PDT | CREATED |
| Event payload | `meeting_type=other`, `commitmentIds=[]`, client `MSIA`, `writeback_ok=true` | DEGRADED but accepted as complete |
| CRM event | inbox to crm at `2026-08-11T20:53:26Z` | EMITTED |
| CRM | interaction rows exist, including duplicate identity surfaces and an internal Josh row; no pipeline result | PARTIAL/INCORRECT |
| Coordinator | wrote `~/code/knowledge-sync/outputs/followups/msia-2026-08-11.md`; extracted 3 OUR and 1 THEIR commitments | USEFUL DOC CREATED |
| Tasks/reminders | no commitment task IDs or titles; run-control task `task_1786481513567_25767581` remains `in_progress` | FAIL |
| Followup rows | four rows were later created by the separate Fireflies ingest cron around 21:22, not the event fanout | EVENT CHAIN FAIL |
| Gmail draft | no real Gmail Draft object | FAIL |
| PA/Telegram receipt | none | FAIL |
| Coordinator lifecycle | printed `DONE`, then daemon reaped it at max lifetime | NOT CLEANLY COMPLETED |

### Meeting 01KZMNH3A753Z6Z9JAAJ1V19PC — Kadre / Nerin Kadribegovic

| Stage | Evidence | Result |
|---|---|---|
| Webhook/bridge | `pa-codex/inbound-messages.jsonl`, `2026-08-11T22:09:35.052Z` | PASS |
| Worker start | daemon log: `meeting-writeback-...` running in `agents/pa-codex` | PASS |
| Extract/writeback | extractor rc 0, writeback rc 0, one meeting filed | PASS only for note writeback |
| Meeting note | `orgs/clearworksai/knowledge/meetings/2026-08-11-kadre-nerin-kadribegovic-and-josh-weiss.md`, mtime 15:11:26 PDT | CREATED |
| Raw live extractor shape | `meeting_type` absent; next step uses `id`, with no `commitmentId` or `owner_identity`; deal state says verbal yes, deposit and kickoff | CONTRACT MISMATCH |
| Event payload | `meeting_type=other`, `commitmentIds=[]`, client `Kadre`, `writeback_ok=true` | DEGRADED but accepted as complete |
| CRM event | inbox to crm at `2026-08-11T22:11:37Z` | EMITTED |
| CRM | interaction rows contain explicit verbal-yes deal state; no pipeline/opportunity mutation | FAIL for deal handling |
| Coordinator | wrote `~/code/knowledge-sync/outputs/followups/kadre-2026-08-11.md`; extracted 3 OUR/4 THEIR commitments and identified verbal yes/deposit pending | USEFUL DOC CREATED |
| Tasks/reminders | no commitment/reminder tasks; only run-control task `task_1786486200640_85798938` marked completed with `written=1` | FAIL and false completion semantics |
| Deal debrief | skipped because `meeting_type=other` | FAIL |
| Gmail draft | no real Gmail Draft object | FAIL |
| PA/Telegram receipt | none | FAIL |
| Coordinator lifecycle | printed `DONE`, then daemon reaped it at max lifetime | NOT CLEANLY COMPLETED |

## Contract vs implementation vs live result

| Expected outcome | Frozen/original promise | Later meeting-chain contract | Implemented | Deployed/live result |
|---|---|---|---|---|
| Real Gmail recap draft | Yes. Frozen `MASTER-BUILD-PLAN.md:173-175` requires a same-hour recap draft in the queue. `DESIGN-C-meeting-integration.md:17` identifies the existing `meeting-recap-draft-worker` as `gws gmail +draft` only. Its OBF plan dated 2026-07-21 says Gmail DRAFT, never send, and the skill still implements it. | Dropped. The 2026-08-10 chain spec labels itself "backend only (no UI surface)" at line 5 and changes coordinator output to recap DOC + tracker at lines 35/84-87. P4 acceptance does not require a Gmail Draft. | A separate four-hour cron/worker exists, but the event chain does not invoke it. The coordinator writes Markdown containing copy, not Gmail. | No Gmail Draft for either meeting. |
| Josh-owned task/reminder | Yes. Frozen master lines 174, 229-233 require owners/dates to Multica/bus/approval. Track F `F-P2-JOBS-WIRING.md:30,49-59` requires same-day recap plus structured bus row and approval. | Partly preserved as FR-004 bus task/approval/BRIEFS/Telegram per commitment. | `meeting-fanout.py` exists. Coordinator is forbidden to compensate. | No commitment/reminder task for either ID. First run task stuck; second run task falsely completed at writeback boundary. |
| PA/Telegram concise completion | Approval/Multica surfaces were promised; the old commitment worker also promised Telegram. Frozen master rejected freeform narration, not actionable receipts. | FR-004 promises one batched Telegram only when commitments surface. No mandatory PA completion receipt exists. | Telegram is conditional on successful fanout with at least one commitment. No meeting-run receipt component exists. | Silent to Josh for both meetings. |
| CRM new opportunity | Not explicit. Frozen master promises a CRM delta from each external call (`MASTER-BUILD-PLAN.md:173`) and Design B asks to sync-check any deal named in the transcript (`DESIGN-B-crm.md:66`), but neither explicitly requires creating/proposing a missing opportunity. | Narrowed to contact+interaction for all meetings and stage update only for an already matching sales deal (`FR-007`). | `meeting-crm-sync.py` cannot create an engagement/opportunity; it only looks one up. | No opportunity or explicit "no opportunity" result. This was omitted, not merely broken. |
| Sales/deal debrief | Yes: frozen master Post-Call Debrief/Follow-Up Drafting; later FR-006 explicitly requires it for sales. | Preserved, but hard-gated by exact `meeting_type==sales`. | Daemon dispatch code exists. | Kadre's obvious verbal-yes meeting became `other`, so debrief was suppressed. |
| All meaningful commitments operationalized | Yes: frozen intent and Track F require owners, dates, structured row, recap, approval. | Preserved across FR-003/004/005, but split between fanout and coordinator with a brittle handoff assumption. | Separate extractor/fanout/coordinator implementations. | Coordinator found commitments but could not create tasks; fanout left no durable success/output. |

## Spec/goal lineage — where scope was lost

### 1. Frozen v9 intent (2026-07-31 through 2026-08-03)

The frozen master is outcome-oriented:

- `MASTER-BUILD-PLAN.md:151-155`: every job must produce an artifact **plus a structured row**; client-visible work goes through approval.
- `:173-175`: every external call produces CRM delta, assigned meeting items, same-day client recap, and same-hour follow-up draft in the queue.
- `:208-212`: real meeting spot-run must produce the artifact and structured row; Josh spot-reads it.
- `:229-233`: meeting tasks route to Multica/bus/human approvals and the next real meeting is the done condition.
- `:246`: the real meeting trace ends with an approval row and Josh approving the recap card.
- `DESIGN-C-meeting-integration.md:17`: the recap draft already existed as a real Gmail Draft lane.
- `meeting-recap-draft-worker/02-master-plan.md:5-10,58-74,110-125`: the exact feature was a Gmail DRAFT, ledgered only after successful draft creation.

The frozen master did **not** clearly promise automatic creation of a missing CRM opportunity or one mandatory PA completion receipt. Those were gaps in the original contract.

### 2. Track F wiring (commit `f161b580`, 2026-08-10 13:51 PDT)

Track F still required a same-day recap artifact plus a human bus task and approval (`F-P2-JOBS-WIRING.md:30,49-59`). It explicitly said ACK only after the skill exits zero. However, it described a "recap draft" ambiguously and no longer required an actual Gmail Draft object.

This is the first semantic weakening: a content draft in Markdown was allowed to stand in for a draft in the system Josh uses.

### 3. Meeting-chain spec/goal (commit `9228a0ed`, 2026-08-10 17:55 PDT)

The decisive scope loss is explicit:

- spec line 5: "backend only (no UI surface)"
- lines 27-36: the end-state pipeline includes doc, bus, CRM, coordinator, debrief, but no Gmail Draft or PA completion receipt
- lines 81-87: coordinator owns only recap DOC + tracker and must not create followups
- goal lines 12-29: live receipts require file, bus task, CRM interaction/stage, coordinator doc/tracker, and debrief; no Gmail Draft, recap approval card, PA receipt, or missing-opportunity result

The spec also elevated classification to "KEYSTONE" and used `other` as a control-flow suppressor. That optimized routing elegance over the actual invariant: important meeting work must not disappear because a classifier is uncertain or stale.

### 4. Implementation shards (August 10)

- FR-005 `2880eb1f`: dispatches detached scripts and an LLM coordinator.
- FR-007 `d49c14cc`: writes interactions and updates only existing matching engagements.
- FR-006 `3fa23ffb`: exact `sales` gate.
- The dispatcher prompt tells coordinator fanout is already complete, creating a split-brain contract with no reconciliation.

The P4 program tracker correctly remained pending before these meetings; the full program was not formally entitled to claim success. But inner completion surfaces were wrong: the second `Cron: meeting-writeback` task completed although no user outcome existed, while the first remained stuck. The broader `MASTER-BUILD-PLAN.md` header also calls P2/P3 DONE while its own human/live gates remain qualified later in the document. Completion vocabulary drifted from outcome to code/phase completion.

### 5. August 11 repair branches

- `352e6078`/`56f2157c`: switched the central skill toward canonical PA scripts and added a synthetic writeback→event test.
- `2fb8c535`: atomic attendee preflight.
- Neither repair commit is an ancestor of `main`/production `5389b713`; each exists only on fix branches.
- `dist/cli.js` and `dist/daemon.js` were built at 11:26 PDT; daemon and bridge started around 11:27-11:36 PDT. Repairs were committed around 13:51-13:55 PDT.
- The `352e6078` regression test injects a synthetic meeting already containing `meeting_type`, top-level `commitmentIds`, and client context. It invokes writeback directly. It never proves the real extractor shape, PTY skill resolution, actual downstream child exit, Gmail draft, task, opportunity handling, or user receipt.
- The atomic attendee repair targets a different failure class and was not deployed. It cannot repair classification, fanout, opportunity creation, or output delivery.

Answer to "wasn't this specced and goaled; did we drop them?": yes for real recap drafts and actionable task/approval surfaces—they were in the frozen plan, then the meeting-chain goal narrowed them. Sales debrief was retained but broken by classifier/runtime drift. New-opportunity creation and a mandatory PA completion receipt were never explicit enough to be protected; they were omissions in both the original and later contract.

## Ranked root causes with adversarial counterarguments

### 1. No end-to-end outcome owner or durable completion state — High confidence

Evidence: every component has a local definition of success; no record aggregates required outcomes. Webhook 200 means spawned. Event complete means note payload. Consumer dispatched means process started. Coordinator output is not delivered to PA. Dedupe keys are dispatch receipts, not completion receipts.

Counterargument: all expected artifacts can be found by inspecting multiple systems, so perhaps aggregation is unnecessary.

Why that does not disconfirm: Josh could not see the meeting outcome, tasks and Gmail drafts did not exist, and failures were not retryable. Discoverable partial artifacts are not operational completion.

### 2. Live runtime/version drift selected an incomplete extractor contract — High confidence

Evidence: both live workers ran in `pa-codex`; live `/tmp/ff-writeback.json` for Kadre lacks `meeting_type`, `commitmentId`, and `owner_identity`. Live payloads defaulted to `other`/empty. The canonical PA extractor contains those fields, but repair branches were not on main/running dist.

Counterargument: downstream fanout independently invokes the canonical PA extractor, so a stale initial extractor need not prevent tasks.

What would disprove/qualify: captured fanout stdout showing canonical extraction and parsed commitments. That evidence cannot be recovered because stdio was discarded. Therefore stale initial extraction conclusively explains the wrong event type/debrief suppression, but fanout's exact zero-output cause remains unobservable.

### 3. Detached downstream execution is structurally invisible and dedupes before success — High confidence

Evidence: `stdio:'ignore'`, detached/unref, no child exit callback, and `recordEvent` before `action`. Both IDs have `meeting-fanout`, `meeting-crmsync`, and `meeting-coord` fire-once keys but no per-consumer success record.

Counterargument: scripts are idempotent and were designed to be fire-and-forget for daemon responsiveness.

Why that does not disconfirm: idempotency without completion-aware retry converts transient or contract failures into permanent loss. Responsiveness does not require destroying stderr or recording success before completion.

### 4. Global `meeting_type` is an unsafe control-flow gate — High confidence

Evidence: Kadre contained verbal yes, deposit, kickoff, and a one-month build, yet `other` suppressed debrief and deal-stage handling. The spec explicitly makes classification the keystone. `other` is simultaneously "uncertain" and "do not run sales outcomes."

Counterargument: gating prevents bogus CRM changes and irrelevant sales debriefs.

Why that does not disconfirm: the safe alternative is not automatic mutation; it is always producing a reviewable candidate/draft and never silently suppressing. Classification may prioritize or label, but must not be the only permission for invariant work.

### 5. Scope regression converted user outcomes into backend artifacts — High confidence

Evidence: frozen master and existing recap worker require Gmail drafts/approval; later chain spec says backend-only and doc-only. No component owns PA delivery.

Counterargument: Markdown is intentionally safer and approval-friendly; the separate recap cron remained active.

Why that does not disconfirm: a four-hour poll is not same-hour event execution, Markdown is not a Gmail Draft, and an approval artifact never surfaced. Safety does not require hiding the draft from the intended work surface.

### 6. CRM contract cannot create/identify a missing opportunity — High confidence

Evidence: CRM sync only searches existing engagements. No requirement or code creates a proposed opportunity when none matches.

Counterargument: automatic opportunity creation risks polluting the pipeline.

Why that does not disconfirm: Josh asked for create/identify, not unconditional auto-write. A proposed opportunity/approval card with evidence is safe and still removes follow-up burden.

### 7. Tests assert the wrong boundaries — High confidence

Evidence: dispatch tests explicitly use fake spawn functions and no real subprocess/worker; event tests allow degraded payloads as completed; canonical runtime repair uses already-perfect synthetic input; bridge tests assert response/prompt text. None asserts Gmail/task/PA/outcome receipts.

Counterargument: unit tests are not supposed to be end-to-end.

Why that does not disconfirm: the program's own goal required staging and a real P4 receipt. Unit tests were then presented as confidence despite the live gate remaining open.

## Why representative staging would have caught this

A valid staging E2E would replay the two exact real extractor shapes:

- a client/expansion meeting with several OUR/THEIR commitments and an opportunity signal
- a pre-sales meeting with explicit verbal yes, deposit and kickoff language

It would assert final outcomes, not process boundaries. The Kadre replay would immediately show that `other` suppressed deal debrief and deal handling. Both would show that the coordinator can find commitments while fanout creates no tasks, and that Markdown is not a Gmail Draft or PA-visible receipt. It would also expose consumer failures because staging would wait for durable terminal states rather than accepting `dispatched`.

Current tests missed this because they manufacture ideal payload fields, fake process spawns, ignore actual CLI/PTY/runtime skill resolution, and do not inspect user-facing systems. The tracker itself shows the staging E2E remained unchecked and P4 was pending.

## Reconsidered architecture

### Non-negotiable invariants

For every meaningful external meeting:

1. One durable run record keyed by transcript ID.
2. One canonical, versioned executable and schema; no skill-search fallback in the critical path.
3. Meeting note and client writeback always attempted.
4. OUR commitments always become reviewable Josh-owned tasks/reminders with owners/dates or explicit NEEDS-OWNER/NEEDS-DATE.
5. THEIR commitments always enter a tracker.
6. A real Gmail Draft or explicit, visible `draft_failed` result is produced for an external meeting.
7. A CRM interaction is always recorded in the target test/runtime store.
8. Opportunity/deal evidence always yields an explicit outcome: matched existing deal, proposed new opportunity for approval, no evidence, or failed. Never silent no-op.
9. Deal debrief is always produced for an external commercial meeting or proposed for review; classifier uncertainty cannot erase it.
10. PA sends one concise terminal receipt listing artifact IDs/links and any failures.
11. Dedupe means exactly-once side effects after success, not at-most-once dispatch.
12. Every stage is replayable independently.

### Anti-goals

- No new external service; execution stays inside cortextOS.
- No LLM agent deciding whether to run the script.
- No global classifier as a hard permission gate for invariant outputs.
- No success derived from HTTP 200, process start, payload existence, or Markdown alone.
- No raw automatic CRM opportunity/stage mutation without evidence and an approval policy.
- No routine narration that crowds out executed outcomes.

### Option A — No classifier; one supervised deterministic meeting command (recommended)

Bridge persists a meeting job and returns accepted. A cortextOS runner invokes one versioned command, for example conceptually `meeting-pipeline --meeting-id <id>`, and supervises its stages. The command may use bounded model calls for structured extraction/draft text, but the control flow is code. Every external meeting runs the invariant stages. Evidence rules create a proposed opportunity/deal action, not a silent classifier branch. PA publishes the terminal receipt from the durable stage ledger.

Why it could still fail: a monolithic command can become hard to resume and may couple independent sinks. Mitigation direction: stage checkpoints and idempotent sink adapters inside the same run record.

### Option B — Durable per-stage queue inside cortextOS; classifier advisory only

Webhook creates a run row. Code enqueues `extract`, `writeback`, `tasks`, `draft`, `crm`, `receipt`. Each worker is a supervised non-agent process with captured output and retry policy. Classification is metadata used for prioritization/template choice only. Opportunity/debrief consumers use evidence fields and can output "review candidate" safely.

Why it could still fail: more state transitions mean more reconciliation logic. If enqueue and state update are not atomic, jobs can duplicate or disappear.

### Option C — Minimal repair of current daemon callbacks

Keep the current event shape but replace the writeback/coordinator LLM PTYs with direct scripts, await all child exits, capture stdout/stderr, write per-consumer terminal receipts, and emit PA completion only when the required outcome set is satisfied. Remove `meeting_type` as a suppressor or make unknown run the safe review path.

Why it could still fail: the architecture retains multiple implicit files and bus messages as the workflow state. It is the smallest change but keeps split ownership and is easiest to regress.

## Naive-fix traps

- Merging `352e6078` alone: fixes one runtime path but does not restore Gmail drafts, PA receipt, supervised downstream execution, or opportunity handling.
- Adding more skill paths: preserves nondeterministic skill discovery and stale-copy selection.
- Making the classifier prompt better: an improved probabilistic gate still silently drops work.
- Treating `other` as non-sales: uncertainty is not evidence of absence.
- Adding a retry cron: pre-dispatch dedupe keys will block replay unless completion semantics change.
- Logging detached stderr to a file: observability improves, but no owner consumes failure and dedupe still prevents recovery.
- Having coordinator create tasks too: duplicates ownership rather than repairing the fanout/coordinator contract.
- Calling Markdown a Gmail draft: preserves the exact scope regression Josh is objecting to.
- Auto-creating every CRM opportunity: replaces silent loss with pipeline pollution. Use proposed opportunity + approval/evidence.
- Counting all green unit tests: they prove isolated mechanics, not the user outcome.

## Acceptance gate using both real IDs, with zero live CRM mutation

The implementation must not be approved until a staging replay passes both captured meeting IDs.

### Isolation precondition

- Pin every command to `CTX_INSTANCE_ID=cortextos-staging`.
- Use a staging framework root and cloned CRM fixtures through explicit `CRM_CONTACTS_PATH`, `CRM_INTERACTIONS_PATH`, `CRM_PIPELINE_PATH`, `CRM_FOLLOWUPS_PATH`, draft/task/approval test adapters, and a staging bus root.
- Freeze the real Fireflies meeting payload/transcript input so the test does not depend on the live API or current LLM output.
- Before replay, record hashes, sizes and mtimes for production `contacts.json`, `interactions.jsonl`, `pipeline.json`, `followups.jsonl`, production task/approval stores, and production Gmail Draft count/IDs. After replay, require byte-identical live files and no new production objects.

### ID-specific assertions

For `01KZCGVH6HYN9XX4124033CTJV`:

- meeting note and MSIA client writeback
- three Josh-owned task/reminder candidates and one Wendy-side tracked commitment, or an explicit reviewed mapping explaining any difference
- real Gmail Draft in the staging draft adapter plus approval row
- CRM interaction without duplicate Wendy/Josh identities
- explicit expansion/new-opportunity result: `proposed`, `matched`, or `no-evidence` with transcript evidence
- one PA/Telegram terminal receipt containing artifact identifiers

For `01KZMNH3A753Z6Z9JAAJ1V19PC`:

- meeting note and Kadre client writeback
- all coordinator-observed OUR/THEIR commitments reconciled to tasks/tracker; no silent difference
- real Gmail Draft plus approval row
- CRM interaction
- deal outcome that recognizes verbal yes/deposit/kickoff: matched existing deal or proposed new opportunity/stage action; no direct silent mutation
- sales/commercial debrief even if classifier says `other` or is absent
- one PA/Telegram terminal receipt

### Failure/replay assertions

- Inject a failure after extraction and before one sink. Run becomes `partial_failed`, PA receives the failure receipt, and retry resumes only missing stages.
- Replay each meeting twice. Side-effect counts remain exactly one; terminal receipt states `already_completed` with links.
- No dedupe key is considered terminal until the corresponding stage's success receipt is durable.
- No stage may return success with required schema fields silently defaulted to `other`/empty.

## Product-priority diagnosis

PA currently spends its reliable attention on low-value notification narration while the high-value meeting outcome is silent. That is not just a bug; it is backwards prioritization. Routine email/CI/status narration should be suppressed or summarized. The primary PA contract should be executed outcomes: "I created these tasks, this Gmail Draft, this opportunity candidate, and this tracker; here are the two items needing your approval." If those artifacts are absent, PA should say the meeting run failed, not remain silent.

