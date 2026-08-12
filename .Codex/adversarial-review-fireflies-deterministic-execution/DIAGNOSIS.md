# Adversarial Diagnosis — Deterministic Fireflies Execution

Status: diagnosis complete; implementation not approved

## Summary

Both real Fireflies events reached cortextOS and both writeback workers executed. The failure is after trigger acceptance and before user-visible completion: live workers used an incomplete `pa-codex` extraction path, emitted `meeting_type=other` and zero commitment IDs, and the daemon then confused dispatch with success. Downstream scripts were detached with output discarded and deduped before completion; the coordinator created useful Markdown but was forbidden to create the tasks it discovered. No Gmail Draft, commitment task/reminder, opportunity result, deal debrief, PA message, or Telegram receipt reached Josh.

The prior fix direction is insufficient. The system must recover its original intent: operationalize every meaningful meeting and return one concise receipt. A deterministic event should invoke supervised code directly inside cortextOS, not ask an LLM worker to find a skill and run shell blocks.

## Highest-confidence findings

| Finding | Confidence | Evidence |
|---|---|---|
| Triggering and initial script invocation worked | High | Both webhook timestamps, daemon worker starts, extractor/writeback rc 0, meeting notes and event payloads exist |
| "Completed" currently means writeback payload, not meeting outcome | High | `maybeEmitMeetingEvent` success predicate; second run task completed with only `written=1`; no final outcome aggregator |
| Downstream completion is structurally invisible | High | detached `stdio:'ignore'`; `runConsumer` dedupes before spawn and records only `dispatched` |
| Live extractor/runtime contract was stale | High | both live payloads `other`/empty; Kadre `/tmp/ff-writeback.json` lacks `meeting_type`, `commitmentId`, `owner_identity`; worker cwd was `pa-codex` |
| Classification wrongly suppressed commercial work | High | Kadre transcript/deal_state says verbal yes, deposit and kickoff; exact `sales` gate prevented debrief/stage handling |
| Actual Gmail Draft was dropped from the event goal | High | frozen v9 and existing recap worker require Gmail Draft; Aug 10 chain spec says backend-only and recap DOC only |
| New-opportunity creation was never explicitly implemented | High | CRM sync only updates an existing matching engagement; specs require stage update, not proposal/create when missing |
| Repair commits were not deployed | High | `352e6078` and `2fb8c535` are not ancestors of production `main` `5389b713`; running dist predates them |

## Contract lineage verdict

- Frozen v9 promised: same-hour recap draft in the queue, owner/date tasks through Multica/bus/approval, CRM delta, and a real-meeting approval receipt.
- Track F still promised a same-day recap artifact plus human task/approval, but made "draft" ambiguous.
- The Aug 10 meeting-chain spec explicitly narrowed scope to backend-only and defined the coordinator as Markdown doc/tracker only. Its live gate omitted Gmail Draft, recap approval, PA receipt, and explicit missing-opportunity result.
- Sales debrief and commitment task fanout remained in the goal, but their live execution failed.
- The formal P4 tracker had not yet cleared, so the whole program was not correctly marked live-complete. However, local run-control tasks and repair claims used false completion semantics: one real writeback task was marked complete while the meeting outcome failed, and the other remained stuck in progress.

## Live outcome matrix

| Outcome | MSIA `01KZCG...` | Kadre `01KZMNH...` |
|---|---|---|
| Webhook received | Yes | Yes |
| Writeback script ran | Yes | Yes |
| Meeting/client note | Yes | Yes |
| CRM completed event | Yes | Yes |
| CRM interaction | Yes, with identity problems | Yes, contains verbal-yes deal state |
| Commitment tasks/reminders | None | None |
| Followup Markdown | Yes | Yes |
| Real Gmail Draft | None | None |
| Opportunity/deal result | None | None |
| Deal debrief | Not applicable/unknown | Suppressed as `other` |
| PA/Telegram completion | None | None |
| Clean worker lifecycle | Coordinator reaped | Coordinator reaped |

## Root causes ranked

1. **No durable end-to-end outcome owner.** Each component marks its local intermediate boundary complete.
2. **Runtime and schema drift.** The event worker selected a stale active-agent extractor while canonical code lived elsewhere; repairs were on unmerged branches.
3. **Fire-and-forget consumer architecture.** Child outputs/exits are discarded and fire-once dedupe happens before success.
4. **Unsafe classifier gate.** `other` is treated as "suppress commercial outputs" instead of "uncertain; produce reviewable candidates."
5. **Scope regression.** Gmail Draft/approval and user receipt were removed from the meeting event contract.
6. **Missing CRM product behavior.** No code path creates or proposes a new opportunity when none matches.
7. **Tests at the wrong boundary.** Synthetic payloads and fake spawns never assert the final artifacts Josh expects.

## Adversarial counterarguments

- Better classifier accuracy is not enough: any probabilistic gate can still suppress important work.
- Merging the canonical-runtime fix is not enough: it does not supervise downstream exits or restore Gmail/PA/opportunity outcomes.
- The coordinator documents prove useful work occurred, but they also prove the split failed: the coordinator found commitments while being ordered not to create tasks.
- Fire-and-forget keeps the daemon responsive, but durable jobs can also be nonblocking. Responsiveness does not justify destroying failure evidence.
- Automatic CRM creation may be unsafe; the required safe behavior is a proposed opportunity/approval result, not silence.

## Recovered design constraints

Always run for meaningful external meetings:

- durable run record
- canonical structured extraction
- meeting/client writeback
- OUR task/reminder candidates and THEIR tracker
- real Gmail Draft plus approval, or visible failure
- CRM interaction
- explicit opportunity/deal outcome
- concise PA/Telegram terminal receipt

Classification must be advisory or absent. It may select templates or priority, but it must not suppress invariant outputs.

## Fix directions, not implementation

### 1. No-classifier supervised command inside cortextOS — Recommended

Persist a meeting job, run one versioned meeting-pipeline command under daemon supervision, checkpoint each sink, and publish a terminal PA receipt. Use evidence-based proposed opportunity/debrief outputs rather than a global type gate.

Risk: a monolith can become hard to resume; require stage checkpoints and idempotent adapters.

### 2. Durable per-stage internal queue; classifier advisory

Enqueue extract/writeback/tasks/draft/CRM/receipt stages and capture every result. Unknown classification still runs safe review outputs.

Risk: additional state transitions introduce atomicity/reconciliation complexity.

### 3. Minimal repair of current callbacks

Replace LLM critical workers with direct scripts, await/capture children, make dedupe completion-aware, and add Gmail/opportunity/PA receipt stages.

Risk: preserves split ownership and implicit-file workflow state, so regression risk stays high.

## Acceptance gate

Replay both real IDs in `cortextos-staging` from frozen inputs. Route every CRM/task/draft/approval path to isolated fixtures/adapters. Hash production CRM files and enumerate production tasks/approvals/drafts before and after; require byte-identical live state and zero new production objects.

For both meetings, require a meeting note, reconciled OUR/THEIR commitments, Josh-visible tasks/reminders, real Gmail Draft + approval, CRM interaction, explicit opportunity result, and one PA/Telegram receipt. Kadre must produce a commercial debrief and verbal-yes opportunity/stage candidate even if classification is absent or `other`. Replay twice with exactly-one side effects. Inject one sink failure and prove visible partial failure plus resume.

## Recommendation

Do not patch another skill path or classifier prompt. Feed this diagnosis into a fresh `/specify` that starts from the recovered user outcome, includes a no-classifier option, and writes acceptance criteria at the Gmail/task/CRM/PA surfaces. Only then `/goalify` the approved contract.

Detailed evidence: `research/fable-diagnosis.md`.
