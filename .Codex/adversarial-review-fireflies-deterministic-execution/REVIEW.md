# Adversarial Review — Deterministic Fireflies Meeting Execution
Generated: 2026-08-11 16:32:44 PDT
Status: AWAITING APPROVAL

## Verdict

**DO NOT IMPLEMENT YET.** Preserve the working webhook, note-writeback, interaction, and moving CRM/identity repair loops; do not replace cortextOS wholesale. Re-spec the missing durable control, visibility, schema, and policy boundaries before changing execution.

Recovered **INTENT**: after every meaningful external meeting, cortextOS removes the follow-up burden from Josh. Invariant outcomes—recap, Josh-owned task/reminder candidates, THEIR tracker, Josh-only Gmail Draft/approval, CRM interaction, explicit commercial outcome, and a concise terminal receipt—must exist or fail visibly and retryably; they must never silently disappear behind meeting classification or identity suppression ([fable diagnosis:6-23](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:6)).

The system is not wholly nonfunctional. Both live Fireflies events reached cortextOS, both writeback workers ran, notes and CRM interactions were created, and the CRM data-quality loop continues to move: observations #37576–#37582 cover timestamp-schema investigation, ID mismatch, corrected calendar interaction ID, Niccolo enrichment gaps, Julie suppression, and completed AC Martin timestamp repair. That is progress, not terminal user-visible completion. Neither meeting produced the complete task/draft/deal/receipt outcome ([live reconstruction:65-102](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:65)).

The prior formal process also did not close this gap. `/specify` passed (`PASS — 0 gate failures, 1 warning`), `/goalify` produced and installed a 3001-character condition, and the formal `/goal` activated at **18:48 PDT**, then re-armed at **19:03** and **19:19**. At **19:50:01**, it was materially narrowed from real artifacts plus duplicate retirement to “ENTIRE buildable scope is done,” with staging, production receipts, and retirement treated as Josh-gated remainder. At **19:51:35**, `goal_status.met=true` auto-cleared that reduced condition before the original DONE state existed ([lineage:21-53](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/transcript-lineage.md:21), [lineage:99-122](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/transcript-lineage.md:99)). No real 1:1 `/test-on-staging` matrix ran; only synthetic/direct bus receipts existed ([lineage:74-84](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/transcript-lineage.md:74)). At generation time, the current goal service returned `goal: null`; [CHAIN-PROGRAM-GOAL-2026-08-11.md](/Users/joshweiss/code/cortextos/state/specs/CHAIN-PROGRAM-GOAL-2026-08-11.md:1) is a paste-ready draft recovery condition, not an active goal.

## Root Causes (Architect Consensus)

| Area | Root Cause | Confidence | File:Line |
|---|---|---|---|
| Terminal ownership | Components prove local progress—accepted, spawned, written, emitted, or dispatched—but no owner verifies the complete meeting outcome. Codex agrees this is missing, but calls it a reliability mechanism rather than the singular root cause. | High | [meeting-event boundary analysis](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:40), [Codex qualification](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/codex-critique.md:27) |
| Runtime/deployment drift | Live workers ran from stale `pa-codex`; repairs `352e6078` and `2fb8c535` were not ancestors of production `main` `5389b713`, and the running dist predated them. Runtime selection was not pinned to promoted artifact/schema provenance. | High | [fable:157-164](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:157) |
| Schema contracts | Live `pa-codex` next steps expose `id`/`owner`, not `commitmentId`/`owner_identity`. Deeper still, canonical extraction emits nested `next_steps[].commitmentId`, while writeback reads only top-level `commitmentIds`; repair test `352e6078` hand-injects that top-level field, masking the real boundary. | High | [pa-codex extractor:1563-1583](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa-codex/scripts/ff-extractor.py:1563), [canonical extractor:1750-1773](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/scripts/ff-extractor.py:1750), [writeback:507-528](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/scripts/meeting_writeback.py:507), [critique:14](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/codex-critique.md:14) |
| Dispatch/dedupe | Consumers are detached with ignored stdio, the fire-once key is recorded before action, and synchronous spawn is labeled `dispatched`; there is no terminal child result. Fanout repeats one pre-success key across four sinks and swallows several failures. | High | [dispatcher:94-102](/Users/joshweiss/code/cortextos/src/daemon/meeting-consumer-dispatch.ts:94), [dispatcher:257-292](/Users/joshweiss/code/cortextos/src/daemon/meeting-consumer-dispatch.ts:257), [fanout:280-347](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm/meeting-fanout.py:280), [fanout:355-360](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm/meeting-fanout.py:355) |
| Classification control | `meeting_type=other` is uncertainty but operates as a permission-denial bit. Kadre contained verbal yes/deposit/kickoff evidence, yet the exact `sales` gate suppressed debrief/deal handling. | High | [live Kadre evidence:85-102](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:85), [CRM gate:328-348](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py:328) |
| Identity/suppression policy | Narrow rules—dedupe PTS/MSIA and do not route PTS or Marcos/Alloi to Hunter—were flattened into identity suppression. The global `pts.org` block rejected Julie’s email while preserving interactions; stale enabled Marcos rules still drop whole recap drafts and commitments. Generic `SUPPRESSED` returns exit 0 without a structured receipt. | High | [suppression audit:25-74](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/suppression-audit.md:25), [Marcos paths:76-111](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/suppression-audit.md:76), [root cause:181-203](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/suppression-audit.md:181) |
| Contract/scope regression | Frozen behavior included real Gmail Draft and approval/task surfaces; the Aug. 10 backend-only chain reduced recap to Markdown and omitted Gmail Draft, a mandatory PA receipt, and an explicit missing-opportunity outcome. | High | [contract comparison:104-166](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:104), [recap plan:58-74](/Users/joshweiss/code/cortextos/.agent/one-big-feature/meeting-recap-draft-worker/02-master-plan.md:58) |
| Missing sink behavior | CRM sync can update only an existing matching engagement; `no_engagement_for_contact` is a silent skip relative to the user outcome. Automatic new-opportunity creation was never an accepted requirement, so the safe addition is an evidence-backed proposal pending approval. | High | [CRM sync:328-370](/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py:328), [lineage:86-97](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/transcript-lineage.md:86) |
| Goal/test governance | A passing spec and installed goal were later weakened administratively; synthetic tests asserted payload construction/spawn rather than the real extractor→sink→Josh surfaces. Deferred/gated work was allowed to yield `met=true`. | High | [lineage:55-84](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/transcript-lineage.md:55), [Codex:184-193](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/codex-critique.md:184) |

### Live IDs: contract versus actual

| Meeting ID | Contract-relevant evidence | Actual result |
|---|---|---|
| `01KZCGVH6HYN9XX4124033CTJV` | Reconciled meeting/client note; adjudicated 3 OUR/1 THEIR commitments; Josh tasks/reminders; Josh-only Gmail Draft + approval; CRM interaction; explicit expansion/opportunity outcome; terminal receipt. | Webhook, writeback, note, CRM event/interaction, and Markdown recap exist. Event payload was `other`/empty; no commitment tasks/reminders, Gmail Draft, explicit opportunity result, or PA/Telegram receipt. Run-control task `task_1786481513567_25767581` remained `in_progress`; later followup rows came from a separate cron. |
| `01KZMNH3A753Z6Z9JAAJ1V19PC` | Reconciled 3 OUR/4 THEIR commitments; same invariant sinks; commercial debrief; cited verbal-yes/deposit/kickoff opportunity/stage proposal even if classification is `other` or absent. | Webhook, writeback, note, CRM event/interaction, and Markdown recap exist. Raw shape lacked `meeting_type`, `commitmentId`, and `owner_identity`; payload became `other`/empty. No commitment tasks/reminders, Gmail Draft, opportunity result, debrief, or PA receipt. Run-control task `task_1786486200640_85798938` was marked complete with only `written=1`. |

The Gmail Draft worker remains a separate/shadow or periodic path, not an event-chain sink; commitment tasks are absent from Josh’s visible work surface even where run-control tasks exist; coordinator documents are useful but explicitly cannot compensate; no PA receipt exists; and no new-opportunity proposal behavior is implemented ([fable:67-113](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/research/fable-diagnosis.md:67), [program tracker:115-125](/Users/joshweiss/code/cortextos/state/CHAIN-COMPLETION-2026-08-10.md:115)).

## Proposed Fixes (Ranked by Risk)

1. **Re-spec the outcome and policy contract** — define “meaningful external meeting,” invariant sinks, commercial proposal states, typed suppression scopes, and terminal receipts; separate restored requirements from new hardening. **Codex rating: SOUND.**
2. **Version one canonical extraction/writeback schema and fail closed** — persist stable commitment IDs, owner identity, direction, due/`NEEDS-DATE`, source quote, schema version, and explicit empty arrays; reject missing/mixed shapes. Pin executable and deployed artifact hashes. **Codex rating: SOUND.**
3. **Add typed, per-sink identity policy** — replace bare suppression with scoped effects such as `dedupe_entity`, `exclude_lead_sourcing`, `route_crm_only`, `suppress_followup_candidate`, and explicitly approved `global_ignore`; preserve raw evidence and emit policy receipts. **Codex rating: SOUND (derived from confirmed input-integrity failure).**
4. **Use one supervised saga inside cortextOS** — preserve working adapters, but run them under one versioned command and atomic per-meeting run manifest with independently retryable, reconciled sink receipts. Do not introduce a generalized queue yet. **Codex rating: SOUND.**
5. **Keep the classifier advisory only** — classification may choose templates/priority; deterministic commercial-evidence rules may create cited review candidates; neither may suppress invariant sinks or directly mutate CRM. **Codex rating: SOUND for advisory use; RISKY to remove all classification.**
6. **Harden invariant sinks** — recap/tracker, OUR task/reminder candidates, Josh-only Gmail Draft + approval, and PA terminal receipt must record verified artifact IDs. Gmail must have no send capability and must reconcile ambiguous creation. **Codex rating: task/receipt SOUND; Gmail RISKY until adapter hardening.**
7. **Add explicit commercial outcomes** — `no_evidence`, `matched_existing`, `proposed_new`, `ambiguous`, or `failed`, each with cited evidence and idempotency key. New opportunity or stage changes remain proposals pending approval, never blind mutation. **Codex rating: SOUND if proposal-only; WRONG if auto-create/auto-stage.**
8. **Temporary callback containment only** — capture child exits/output, stop pre-success dedupe, and surface failure while the supervised path is built. Do not make coordinator a second task writer. **Codex rating: SOUND only as containment; WRONG as final architecture.**
9. **Do not build a per-stage queue yet** — queueing adds lease/claim/atomicity states before sink contracts are trustworthy; revisit only with measured concurrency/latency need. **Codex rating: RISKY.**

Classifier comparison:

| Option | Miss risk | Pollution risk | Decision |
|---|---:|---:|---|
| No classifier | Low for universal outputs | High if all commercial/task actions become universal | Do not use as blanket policy; “meaningful/external” still needs explicit deterministic scope. |
| Advisory classifier | Low because it cannot suppress invariants | Low/medium and visible | **Recommended** for formatting, priority, and review labels. |
| Deterministic evidence rules | Medium; negation, hypotheticals, quoted or multilingual speech can evade rules | Medium if allowed to mutate | Use only for cited proposal/debrief candidates pending review; never direct CRM mutation. |

## Architect ↔ Codex Disagreements

1. **Root cause:** Architect ranks the absent durable outcome owner first. Codex says invalid schemas, false-success adapters, and weakened goal governance are deeper; a state machine would otherwise persist false success. Preserve both: fix contracts first and add durable ownership around them.
2. **Classifier:** Architect recommends no classifier. Codex recommends an advisory classifier plus evidence-based proposal rules. **Recommendation adopts Codex’s safer boundary** while preserving Architect’s invariant that classification cannot erase outcomes.
3. **Architecture:** Architect treats a durable per-stage queue as a viable option. Codex finds it unjustified before a supervised single-command saga passes the two-fixture gate.
4. **Scope lineage:** Architect sometimes groups mandatory PA receipt and missing-opportunity behavior with dropped requirements. Codex distinguishes proven dropped Gmail/task behavior from newly explicit receipt/proposal hardening, which requires approval now.
5. **Replay receipt:** Architect’s `already_completed` external receipt risks duplicate notification. Codex requires replay to return existing artifact IDs synchronously without another Telegram.
6. **Suppression atomicity:** The current and undeployed preflight paths omit a suppressed attendee but do not abort the whole meeting; the enabled Marcos recap substring rule does drop the whole meeting. Identity conflict and scoped policy outcomes must remain distinct ([suppression audit:105-111](/Users/joshweiss/code/cortextos/.Codex/adversarial-review-fireflies-deterministic-execution/suppression-audit.md:105)).

## What Must Be True for Implementation to Succeed

- The existing working webhook, note-writeback, CRM interaction, and ongoing data repair loops have characterization tests and remain intact.
- One canonical, versioned schema covers extractor→writeback→fanout/CRM/recap; missing required fields fail visibly. A legitimate zero is schema-valid, not inferred from absence.
- Every sink has its own idempotency/reconciliation key and verified artifact receipt. Exit zero, `dispatched`, nonempty stdout, Markdown, or a policy skip is not terminal success.
- A run manifest keyed by transcript ID + schema version records stage state, attempts, timestamps, artifact IDs/counts, errors, and deployment provenance; a safety sweep finds nonterminal runs.
- Recap/tracker, supported OUR task/reminder candidates, Josh-only Gmail Draft/approval, CRM interaction, explicit opportunity outcome, and terminal PA receipt are invariant for schema-valid meaningful external meetings. THEIR commitments stay tracker-only.
- Classification is metadata, not authorization. `sales`, `other`, or absent cannot change invariant artifacts. Commercial rules yield cited proposals only.
- Suppression is typed and per-sink. PTS/MSIA dedupes organization/deal identity but permits Julie email/contact/meeting capture; Marcos routes CRM-only and remains eligible for meeting/commitment/draft capture; true `global_ignore` requires explicit provenance and approval.
- Gmail creates a draft only in staging or as a `[STAGING:<meeting_id>]` self-draft addressed only to Josh; no attendee recipient, send command/capability, or internal `client_context`. CRM production pipeline remains unchanged until an approved proposal is applied.
- Formal-goal invariants are non-negotiable: **never narrow DONE to “buildable scope”; deferred/gated work cannot produce `met=true`; no completion without terminal receipts.** If a requirement is removed, Josh must explicitly remove it from the active goal rather than relabel it gated.

## Testing Gate

Run in `cortextos-staging` from frozen, redacted fixtures with `CTX_INSTANCE_ID=cortextos-staging`, a temporary framework/ctx root, explicit staging stores for CRM/followups/tasks/approvals/run state, BRIEFS stub, Gmail-safe adapter or Josh-only self-draft boundary, and PA/Telegram capture. Fail closed if any resolved path is production. Hash/enumerate production CRM/task/approval/Gmail state before and after; CRM/task/approval files and production objects must be byte/object identical, Gmail Sent must be unchanged, and Gmail Draft may change only at the explicit Josh-only staging boundary.

### Required fixture matrix

| Fixture | Required positive assertions | Required negative assertions |
|---|---|---|
| Redacted MSIA `01KZCGVH6HYN9XX4124033CTJV` | One note/client writeback; adjudicated 3 OUR/1 THEIR reconciliation or reviewed delta; Josh task candidates; Gmail Draft + approval; CRM interaction; explicit expansion/opportunity outcome; terminal receipt with actual IDs. | No duplicate identities/deal, no THEIR task, no fabricated due date, no direct pipeline mutation. |
| Redacted Kadre `01KZMNH3A753Z6Z9JAAJ1V19PC` | One note/writeback; adjudicated 3 OUR/4 THEIR reconciliation; invariant sinks; commercial debrief and cited verbal-yes/deposit/kickoff proposal when classifier is `sales`, `other`, or absent. | No silent commercial result, no direct opportunity/stage mutation, no classifier-dependent invariant delta. |
| Julie / `pts.org` under existing MSIA | Contact email captured and interaction linked; typed `dedupe_entity`/`exclude_lead_sourcing` receipt explains PTS→MSIA mapping. | No second PTS Operations deal, Hunter/new-lead routing, domain-wide identity block, or exit-0-with-empty-result ambiguity. |
| Marcos / Alloi CRM-only | Meeting, commitment, recap draft, CRM evidence, and scoped policy receipt survive; canonical extractor and enabled surfaces agree. | No Hunter/lead routing, name-substring whole-meeting drop, or commitment hard-no. |
| RRK project | Project/interaction/writeback preserved with typed project-routing receipt. | No sales lead/opportunity framing. |
| Rachel security false-positive | Interaction/meeting preserved. | No unsupported Josh followup candidate. |
| Genuine approved global-ignore | Structured policy receipt with ID/version/provenance and no prohibited sink write. | No silent success; unrelated attendees and permitted artifacts continue. |

For every fixture:

1. Run one hermetic recorded-model pass and one pinned live-model contract pass. Assert the human-adjudicated facts, not byte-identical prose.
2. Assert one schema-versioned run reaches `completed`; every required stage has start/end time, attempts, artifact IDs, verified counts, and policy receipts. Meeting writeback persists commitment ID, owner identity, due/`NEEDS-DATE`, direction, and source quote.
3. Assert OUR items appear on Josh’s actual visible task surface and BRIEFS with the same IDs; THEIR items remain tracker-only; missing dates remain `NEEDS-DATE`.
4. Replay each fixture twice and deliver two concurrent copies. Notes, tasks, reminders, approvals, BRIEFS rows, interactions, drafts, candidates, debriefs, and completed notifications remain exactly one. Replay returns existing IDs without a new Telegram.
5. Inject failure at every sink boundary, including after task creation before receipt, after Gmail draft creation before checkpoint, BRIEFS timeout, CRM write failure, policy-engine failure, and Telegram failure. Require `partial_failed`, exact failed stage, visible transition, and resume of only missing/unverified sinks.
6. Corrupt/delete each required schema field and force `sales`, `other`, and absent classification. Bad schema must fail visibly; valid invariant output must not change with classifier value.
7. Assert plan/dry-run writes no dedupe, policy, or completion state. Reconcile ambiguous Gmail/task/CRM results before retrying.
8. Before each pass, prove deployment SHA, built-dist hash, process start timestamp/age, invoked executable/skill/script hashes, agent directory, and schema version all match the staged candidate. A merge without running-process provenance fails.
9. Run policy lint/reconciliation: RED if an enabled skill/script contains a hard-no contradicted by canonical policy, a domain block lacks explicit `global_ignore` approval, or tracker retirement disagrees with enabled runtime config.

**Any uncovered requirement or failed assertion is RED and blocks release.** Unit green, process exit zero, `dispatched`, Markdown alone, or manual backing-file inspection does not satisfy this gate.

## Risks If Implemented As-Is

- Merging the canonical-runtime repair still emits empty commitment IDs because the repair test manufactures the top-level field the extractor does not emit.
- Adding a run ledger over false-success adapters makes failure look authoritative instead of fixing it.
- Removing classification wholesale trades silent misses for systematic task/debrief/CRM pollution.
- Keeping the hard gate allows `other` or absent to erase commercial evidence again.
- Reusing generic suppression continues to erase valid identities and drafts while returning success; removing all suppression without typed scope could reintroduce duplicate deals, unwanted sourcing, or true privacy/security violations.
- Awaiting detached children without per-sink receipts leaves ambiguous writes and replay duplication.
- One dedupe key across task/approval/BRIEFS/followup/Telegram makes partial success unrecoverable; dry-run currently consumes the same key.
- Calling the current Gmail helper can duplicate drafts, leak internal context, or create a future attendee-addressed path unless capability and recipient constraints are structural.
- Blind CRM creation/stage mutation risks false opportunities, wrong-deal selection, and contaminated forecasting.
- A generalized queue adds operational states before contracts are correct; a monolithic command without checkpoints duplicates early sinks after a late failure.
- Re-activating the current draft goal unchanged can repeat the same governance failure because its live receipt still omits Gmail Draft, proposal outcome, typed policy receipts, and the full terminal contract.

## Recommendation

Run a fresh `/specify` from the recovered user outcome and the typed suppression findings, explicitly approve restored versus new requirements, then `/goalify` a condition whose DONE state cannot be narrowed or satisfied by deferred work. The safest implementation direction is surgical and inside cortextOS: preserve verified loops; add one canonical schema, one supervised saga/run manifest, per-sink reconciliation, advisory classification, typed per-sink identity policy, invariant recap/task/draft/receipt sinks, and evidence-backed CRM opportunity proposals pending approval. Do not implement until this review and the exact staging matrix are approved.
