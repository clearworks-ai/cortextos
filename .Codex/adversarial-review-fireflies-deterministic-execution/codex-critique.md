# Codex Adversarial Critique — Deterministic Fireflies Execution

Date: 2026-08-11  
Mode: review only; no production code, config, runtime, task, branch, or live-system changes

## Verdict

**NEEDS SPEC HARDENING — do not implement Fable's recommended direction as written.**

Fable correctly proves that the two webhooks reached cortextOS, that local dispatch was mistaken for completion, that downstream exits were made unobservable, and that the active goal was later narrowed and auto-cleared without satisfying its original live-receipt bar. It does **not** prove that a full outcome-owned state machine is the root cause, nor that deleting classification is intrinsically safer. The incident can be explained more directly by invalid stage contracts, multiple incompatible runtime copies, pre-success dedupe, swallowed sink failures, and a completion condition that was administratively weakened.

The safest design is simpler than either a new internal queue or the current callback fanout: one supervised cortextOS command, one versioned schema, an atomic per-meeting stage receipt, per-sink reconciliation/idempotency, advisory classification, and evidence-backed review candidates for commercial actions. It must never auto-create or move a CRM opportunity from an uncertain type or lexical rule.

The strongest concrete objection is that even the proposed "canonical runtime" still has an internal schema contradiction: `ff-extractor.py:1766-1772` emits `commitmentId` inside each `next_steps` entry, while `meeting_writeback.py:516-520` reads only top-level `commitmentIds`. The repair test at commit `352e6078`, lines 194-207, hand-builds that top-level field and therefore proves a shape that the real extractor does not produce. Merging that repair would still emit empty commitment IDs.

## Evidence That Is Strong, Weak, or Overstated

### Strong and decision-relevant

- `src/daemon/meeting-consumer-dispatch.ts:263-278` records the fire-once key before invoking the action and calls a synchronous spawn boundary `dispatched`. This is at-most-once launch, not exactly-once completion.
- `meeting-fanout.py:280-347` repeats the same defect one level lower: one commitment-level key is consumed before four independent sinks. A task can succeed, BRIEFS fail, and Telegram fail, yet the whole commitment becomes unreplayable.
- `meeting-fanout.py:355-360` converts command failure into an empty string; `:449-472` reports BRIEFS as attempted even after an HTTP exception; `:439-440` discards Telegram failure; and `main()` always returns zero. An outcome ledger layered over those contracts would persist false success unless the contracts change first.
- `meeting-crm-sync.py:328-370` can only update an existing engagement. `:448-458` exits nonzero only for a top-level `error`, so failed attendee upserts, interaction writes, and `deal_stage: error` still normally exit zero.
- The goal lineage is decisive: `transcript-lineage.md` documents activation at 18:48, re-arms at 19:03 and 19:19, then a 19:50 rewrite from real artifacts/retirement to "buildable scope"; `goal_status.met=true` auto-cleared at 19:51 while the real-chain/P4/P5 receipts remained pending.
- The formal meeting-chain spec itself says "ONE DETERMINISTIC CHAIN, single owner," yet implementation split ownership among writeback, detached fanout/CRM, coordinator, and debrief. The missing owner is an implementation violation of the spec, not a newly discovered product requirement.

### Weak, incomplete, or overstated

- The stale initial extractor conclusively explains the degraded event payload and debrief suppression. It does **not** explain fanout's zero tasks: fanout independently reruns the canonical extractor. Because stdout/stderr were discarded, the exact fanout failure is unknowable. A state machine cannot repair an unknown child contract by itself.
- Fire-once keys prove the consumers were offered for dispatch, not that their child process reached Python `main()`. The diagnosis is careful in its detailed text but occasionally speaks as though downstream execution were established.
- Absence of an end-to-end state machine is a reliability multiplier, not the singular root cause. A supervised sequential process would have succeeded without a general state machine; a state machine whose stages accept empty/defaulted schemas and swallowed errors would fail just as silently, only with better-looking state.
- Gmail Draft is a prior accepted feature and was omitted from the standalone meeting-chain goal. That is real scope loss. A mandatory separate PA terminal receipt and missing-opportunity creation were not explicit in the original goal; those are sensible recovery requirements, but they are new product decisions, not proven dropped scope.
- The formal spec explicitly approved a classifier and a sales-only debrief/stage gate. The live incident falsifies the safety of that **hard gate**, but it does not establish user approval to remove classification entirely.

## Fix 1: Recover the Outcome Contract

**Rating:** SOUND

**Objections:**

- Separate recovered requirements from new hardening. Gmail Draft, Josh-owned task surfaces, sales debrief, and BRIEFS have prior lineage. "Propose a missing opportunity" and "always emit a PA terminal receipt" need explicit acceptance now.
- "Every meaningful external meeting" is itself a gate. If the classifier is removed, the spec must define external and meaningful deterministically (attendee/domain plus suppression policy), or casual/internal meetings will produce junk.
- "Real Gmail Draft" must mean a draft addressed only to Josh/staging, never an attendee and never a send-capable path.

**Alternative interpretation:** The primary contract failure was not lost implementation knowledge; it was a goal-management failure. The original active condition was replaced with a condition that allowed gated work to count as complete.

**Risk if implemented as described:** New requirements may be smuggled in as restorations and automated before Josh chooses their safety policy.

## Fix 2: Canonical Runtime and Strict Schema

**Rating:** SOUND

**Objections:**

- A canonical path is insufficient without one canonical schema and runtime validation. Missing fields must fail the extraction stage; `meeting_type ?? 'other'` and missing arrays must not turn an incompatible payload into success.
- Legitimate zero commitments must be represented explicitly, for example a schema-valid `commitments: []` plus extraction status, not inferred from a missing field.
- The meeting note currently does not persist `commitmentId`, `owner_identity`, or source quote. The extractor re-derives IDs from normalized action text on each run, contrary to the formal requirement to reuse persisted IDs when wording drifts.
- The active recap/writeback copies are visibly divergent. Canonicalizing only the writeback skill leaves the recap skill/helper and ledgers split across `pa`, `pa-codex`, and prior `frank2` assumptions.

**Alternative interpretation:** "Deployment drift" is actually an artifact-promotion and contract-version problem. Pinning a path without pinning schema/version and deployment provenance simply chooses one stale copy deterministically.

**Risk if implemented as described:** The system emits a valid-looking empty event from an incompatible but canonical payload, exactly as the current repair test permits.

## Fix 3: Drop the Classifier

**Rating:** RISKY

**Objections:**

- No classifier avoids false negatives only by accepting more false positives: irrelevant deal debriefs, opportunity proposals, approvals, and task noise.
- "No classifier" does not eliminate classification; `meaningful`, `external`, `commercial evidence`, and `client-facing` still classify. It merely moves those decisions into less visible rules.
- Deterministic keyword rules are brittle around negation ("not approved"), hypotheticals, quoted language, stalled deals, and multilingual transcripts. They are safe only when they create review candidates with cited evidence, never direct CRM mutation.

**Alternative interpretation:** The defect is using a probabilistic label as a permission bit. Keep classification as metadata for templates/priority, but make safe invariant stages independent of it and make commercial actions depend on evidence plus approval.

**Risk if implemented as described:** Silent misses become systematic CRM/task pollution, which is harder to notice and clean up.

### Classifier option comparison

| Option | Miss risk | Pollution risk | Recommended role |
|---|---:|---:|---|
| No classifier | Low for universal outputs | High if debrief/opportunity/task creation is universal | Do not use as a blanket policy |
| Advisory classifier | Low when it cannot suppress invariants | Low/medium; uncertainty remains visible | **Recommended** for templates, priority, and review labels |
| Deterministic evidence rules | Medium; semantics can evade rules | Medium unless negation/evidence is handled | Use only to create cited candidates; never mutate CRM |

Safe decision table: always file/write back, draft to Josh, log a CRM interaction, reconcile commitments, and return a receipt for a schema-valid external meeting. Create Josh task candidates only from supported OUR commitments. Track THEIR commitments separately. Create an opportunity/stage candidate only from cited commercial evidence. Classification may rank or format these outputs but may not erase them.

## Fix 4: One Supervised Command with Checkpoints

**Rating:** SOUND

**Objections:**

- "One command" must not mean one all-or-nothing monolith. It needs durable per-stage receipts and independently retryable adapters.
- A new queue is not necessary to prove the intent. An atomic run manifest under cortextOS state, keyed by transcript ID and schema version, can record `pending/running/succeeded/failed` plus artifact IDs.
- Stage success must be derived from verified artifact IDs/counts, not exit zero or nonempty stdout.

**Alternative interpretation:** The minimum sufficient architecture is a supervised saga, not a generalized workflow engine: sequential control flow, explicit stage receipts, compensation/reconciliation for ambiguous external writes, and a safety sweep for nonterminal runs.

**Risk if implemented as described:** A "simple monolith" reruns completed external writes after any late failure and duplicates drafts/tasks.

## Fix 5: Durable Per-Stage Internal Queue

**Rating:** RISKY

**Objections:**

- It adds enqueue/claim/lease/reconciliation failure modes before the team has a correct sink contract.
- Queue atomicity does not solve Gmail ambiguity, unstable commitment IDs, contact identity duplication, or swallowed subprocess failures.
- The two-meeting volume does not establish a throughput need for a queue.

**Alternative interpretation:** Start with one durable run manifest and a single supervised runner. Promote to a queue only if concurrency, latency, or retry isolation is measured to require it.

**Risk if implemented as described:** More states create the appearance of rigor while false-success stage adapters remain unchanged.

## Fix 6: Minimal Repair of Current Callbacks

**Rating:** WRONG as the final fix; SOUND only as temporary containment

**Objections:**

- Awaiting child exits still leaves split ownership, implicit files, schema defaults, and one fire-once key spanning multiple sinks.
- Logging stderr without a durable consumer does not create retryability.
- Letting the coordinator compensate by creating tasks would introduce a second writer and duplicate risk.

**Alternative interpretation:** Use callback repair only to stop silent loss while replacing the path with the supervised command.

**Risk if implemented as described:** The next partial failure will be observable but still permanently deduped or inconsistently retried.

## Fix 7: Gmail Draft as an Invariant

**Rating:** RISKY until the adapter is hardened

**Objections:**

- The existing helper's local ledger records only meeting ID after CLI success, not the Gmail draft ID. "Draft created, response timed out" can duplicate on retry.
- Runtime copies differ. The current `pa` helper includes internal `client_context` in the body, while the older `pa-codex` copy explicitly removes it. Invoking "the existing worker" is not yet a safe canonical action.
- The safe boundary must be enforced structurally: `+draft` only, recipient Josh/staging only, no attendee recipients, no send-capable command, and persisted draft ID plus reconciliation marker.

**Alternative interpretation:** Draft creation is a review artifact, not external delivery. Treat it like an approval candidate and verify the exact recipient/body before calling Gmail.

**Risk if implemented as described:** duplicate drafts, internal-context leakage, or a future path accidentally addressing clients.

## Fix 8: CRM Missing-Opportunity Proposal

**Rating:** SOUND if proposal-only; WRONG if auto-create/auto-stage

**Objections:**

- Candidate identity must be stable and reconcile against existing deals by more than first contact match; the current first matching engagement can select the wrong deal when a contact has several.
- The proposal must include source quote/time, client/contact, proposed action, confidence/evidence rule, and an idempotency key. `no_evidence`, `matched_existing`, `proposed_new`, `ambiguous`, and `failed` must all be explicit terminal outcomes.
- Pipeline files must remain byte-identical in staging and until human approval.

**Alternative interpretation:** The recovered intent is "never silently lose a commercial signal," not "create an opportunity automatically."

**Risk if implemented as described:** false opportunities, wrong-deal stage changes, and contaminated forecasting.

## Fix 9: PA/Telegram Receipt

**Rating:** SOUND with transition-aware idempotency

**Objections:**

- "Exactly one receipt per meeting" conflicts with failure then successful resume. Define one notification per meaningful terminal transition, keyed by meeting/run-attempt/state, or update a single durable status surface.
- Replaying an already-complete meeting should return existing artifact links without sending another Telegram. Fable's proposed `already_completed` terminal receipt would itself violate exactly-once notification if sent on every replay.
- Receipt text must be generated from durable artifact IDs, never inferred from planned actions.

**Alternative interpretation:** The durable run record is the source of truth; Telegram is a lossy notification adapter.

**Risk if implemented as described:** duplicate noise or a confident receipt claiming artifacts that failed.

## What Naive Fixes Still Miss

- **Schema mismatch:** fixing field names without rejecting mixed schema versions, persisting commitment IDs, and testing the real extractor→writeback boundary.
- **Detached consumers:** awaiting processes without validating artifact receipts, timeouts, retry policy, or ambiguous external writes.
- **Dedupe:** moving one key "after success" while retaining a single key across task, approval, BRIEFS, followup, and Telegram. Each sink needs its own durable result/reconcile key.
- **Deployment drift:** merging commits without proving the running dist SHA, skill/script hashes, schema version, and agent directory actually used.
- **Gmail Draft:** calling the existing helper without canonicalizing divergent copies, sanitizing body, restricting recipient/send capability, and storing/reconciling the Gmail draft ID.
- **PA receipt:** sending a success message before verifying every required artifact; treating Telegram delivery as the durable state.
- **Tasks/reminders:** creating tasks for THEIR commitments, assigning tasks to attendee emails instead of Josh/human, inventing due dates, or letting uncertain extractions crowd the board. `resolveTaskOwner` passes explicit assignees through unchanged (`src/bus/task.ts:166-170`), so an attendee email is not magically a Josh-owned task.
- **Dry-run:** current fanout dry-run consumes dedupe at `meeting-fanout.py:282-288`; a prod dry-run can suppress the real run.
- **CRM idempotency:** `source_ref + contact_id` is not concurrency-safe when two processes check then append, and identity changes can create a second contact/interaction.

## Does Lineage Prove Scope Was Dropped?

**Yes, but precisely:**

1. It proves the active original `/goal` required real Fireflies/live-daemon receipts and duplicate-path retirement.
2. It proves the 19:50 replacement condition allowed those same outcomes to become Josh-gated remainder and the 19:51 evaluator auto-cleared on the narrower condition.
3. It proves no 1:1 real-transcript staging matrix ran; prior staging receipts explicitly covered direct/synthetic bus paths.
4. It proves Gmail Draft existed as a prior accepted worker feature but was omitted from the standalone meeting-chain FR/DONE set.

**It does not prove:** automatic new-opportunity creation or a separately named mandatory PA terminal receipt were previously accepted. Those should be approved as new safety/product requirements. It also does not prove classification itself was accidentally introduced; classification was explicit in the approved spec. The incident proves only that its hard-gate role was unsafe.

## Falsifiable Staging Gate — Two Real/Redacted Fixtures

### Isolation and fixture preconditions

- Freeze two redacted fixture bundles: webhook envelope, transcript, attendee identities/domains, human-adjudicated OUR/THEIR commitments, commercial evidence, and expected outcome enum. Fixture A is MSIA (`01KZCG...`, expected reconciliation of 3 OUR/1 THEIR subject to adjudication). Fixture B is Kadre (`01KZMNH...`, 3 OUR/4 THEIR and explicit verbal-yes/deposit/kickoff evidence).
- Pin `CTX_INSTANCE_ID=cortextos-staging`, a temporary framework/ctx root, explicit staging paths for contacts/interactions/pipeline/followups/tasks/approvals/run state, a BRIEFS stub, and PA/Telegram capture. Fail closed if any path resolves to production.
- Record production CRM/task/approval state hashes and Gmail Sent/Draft IDs before and after. CRM/task/approval production state must be byte/object identical. Gmail may change only at the explicitly allowed Josh-only draft boundary below.
- Run one hermetic pass with recorded model responses to prove deterministic control flow, then one pinned live-model contract pass per fixture to prove schema and the human-adjudicated minimum facts. Do not require byte-identical prose.

### Required first-run assertions

For **both** fixtures:

1. One schema-versioned run record reaches `completed`; every required stage has start/end timestamps, attempts, artifact IDs, and verified counts.
2. Meeting note and client writeback exist once and contain persisted commitment IDs, owner identity, due/NEEDS-DATE, direction, and source quote.
3. OUR commitments appear through the actual Josh-visible read surface as human task candidates/reminders; THEIR commitments appear only in the tracker. Counts match the adjudicated fixture, and unexplained deltas fail the gate.
4. Missing dates remain `NEEDS-DATE`; no fabricated reminder date is accepted.
5. BRIEFS receives exactly the adjudicated OUR commitment IDs with meeting/source references; no THEIR item is turned into Josh work.
6. A Gmail **Draft** is created in a staging mailbox, or if none exists, as a self-draft addressed only to Josh with `[STAGING:<meeting_id>]`; persist the draft ID, assert no send command/capability and no Sent object, and assert internal `client_context` is absent.
7. CRM interaction exists exactly once in the staging fixture. Production pipeline remains unchanged.
8. Opportunity outcome is explicit. Kadre must be `matched_existing`, `proposed_new`, or `ambiguous` with the verbal-yes/deposit/kickoff quote; it may not be silent and may not mutate pipeline. MSIA must equal its pre-adjudicated expansion/no-evidence outcome.
9. Kadre produces a commercial debrief even when classifier output is forced to `other` and when the field is absent. Its stage/opportunity action remains proposal-only. MSIA follows its adjudicated commercial-evidence outcome, not a global type label.
10. Coordinator recap/OUR-THEIR tracker and one final PA/Telegram capture contain the actual artifact IDs/links and failures=`none`.

### Replay and failure assertions

- Replay each fixture twice. Notes, tasks, reminders, approvals, BRIEFS rows, interactions, drafts, candidates, debriefs, and final completed notifications remain exactly one. The command returns the existing run/artifact IDs without another Telegram.
- Force classifier values `sales`, `other`, and absent. Universal artifacts and Kadre's evidence-backed candidate/debrief must not change.
- Inject failure at every sink boundary, including: after task creation before receipt; after Gmail draft creation before checkpoint; BRIEFS timeout; CRM write failure; and Telegram failure. The run becomes `partial_failed`, records the precise failed stage, and emits at most one failure notification for that attempt.
- Resume after each injection. Only missing/unverified sinks run. Gmail reconciles the already-created draft marker/ID rather than creating another; completed tasks/BRIEFS/interactions remain one. The resumed run emits one completed transition notification.
- Delete or corrupt a required schema field. The extraction stage must fail visibly; it may not default to `other`/empty and complete.
- Run two concurrent deliveries of the same fixture. One run owns execution or both reconcile to the same artifact IDs; counts remain one.
- Assert the plan/dry-run mode writes **no** dedupe or run-completion state.

Any failed assertion is a release blocker. Unit tests, process exit zero, `dispatched`, Markdown alone, or a manually inspected backing file do not satisfy this gate.

## Architect ↔ Codex Disagreements

1. **Root cause:** Fable calls the absent durable outcome owner the highest-confidence root cause. I call it a missing reliability mechanism caused by a deeper contract/governance failure; wrong schemas and false-success adapters would defeat the state machine too.
2. **Classifier:** Fable recommends no classifier. I recommend advisory classification plus deterministic evidence rules that can only create review candidates.
3. **Architecture:** Fable presents a per-stage queue as a serious option. I find it unjustified before a simpler supervised saga passes the two-fixture gate.
4. **Scope:** Fable sometimes groups missing-opportunity behavior and PA receipt with dropped requirements. Lineage proves they were omissions/new hardening, not both previously accepted deliverables.
5. **Replay receipt:** Fable proposes an `already_completed` receipt on replay. I reject sending it automatically because that violates exactly-once notification; return it synchronously to the caller without a new external message.

## Recommendation

Re-spec before implementation. Approve the exact invariant/candidate policy, define a versioned extraction and run-receipt schema, and choose the supervised single-command architecture with per-sink reconciliation. Keep classification advisory; prohibit direct opportunity creation/stage mutation; and make the two-fixture failure/replay matrix the merge gate.
