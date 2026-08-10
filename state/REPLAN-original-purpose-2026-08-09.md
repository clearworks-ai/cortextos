# Original Purpose Reconstruction — for Replan (2026-08-09)

> Goal of this doc: strip away the accreted complexity a later coding agent added, and
> restate what these jobs were **originally** meant to do, so they can be cleanly replanned.
> Everything below is grounded in git commits + the frozen plan artifacts, not memory.

## TL;DR — there is only ONE plan

All the threads you named (P1–P6, waves/loops, Altari skills, fireflies, google, "fleet
maintenance") are slices of a **single frozen plan**: the **Clearworks System Master Plan v9**,
frozen 2026-07-31 after 8 revision rounds, 5 decisions DECIDED by Josh.

- Canonical: `knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md` (+html)
- Decisions: `DECISIONS-FOR-JOSH.md` (D1–D5, binding)
- Memory: `project_system_plan_v9_decided_2026-07-31.md`

The plan was `goalify`'d into a `/goal` build loop, then executed as **phases P1→P6**. The three
"jobs" are not separate projects — they are **execution lanes inside v9**. Most of what you
noticed "should have happened but got dropped" was in-scope in v9 and fell out during execution.

---

## Job 1 — FLEET MAINTENANCE = the D3 Cron Ledger (deterministic + proactive + retire old)

**This is the one I got wrong first. Correct version:**

Original purpose (v9 Decision **D3**): rationalize the whole fleet's cron surface — **96 crons →
15 KILL / 11 EVENT-replace / 19 KEEP+rewire / 51 keep-as-is**. Two techniques:

1. **Deterministic core + thin LLM verify** (token saver, Josh 2026-07-31). LLM-per-run burns
   tokens on the 99% trivially-matchable inputs. Pattern: deterministic string/regex/rule match
   does the bulk pass (zero tokens); a small LLM fires ONLY on a candidate to confirm + act.
   Ref: `feedback_deterministic_cron_core_llm_verify_layer.md`.
2. **Event-replace poll crons** (P4.1 lanes — see Jobs 2 & 3). Poll crons get deleted when an
   event lane covers them.

**Hard rule baked into every cron spec's done-condition** (`feedback_cron_replacement_must_remove_old_cron.md`):
converting/replacing a cron MUST remove or `enabled:false` the superseded old one, and
machine-assert only ONE version fires after. Add-new-without-removing-old = double-fire dead noise.

**Proactive crons to ADD** (the Altari P1 wiring, all drafts-only / approval-gated):
- delivery-status reporter — weekly per-client draft (#306)
- proactive event-based exec-assistant — inbox+calendar+booking (#304)
- CRM keyless enrichment + records-admin triggers + weekly sweep (#305)
- KB proactive content-health maintenance loop, 3-tier (#279)

**The concrete FIRST target Josh named — and it got DROPPED:** a **completion-capture lane** for
meeting-commitments. Watch the FULL inbound mail feed (incl. automated mail — comms-check
suppresses automated mail, so this needs its OWN scan) for deterministic completion signals
matching open commitments (e.g. sender=intuit/quickbooks + body names the invitee), LLM-verify,
mark the task done, suppress the re-nag. This is the "invite Michelle to QuickBooks" zombie-nag
fix. **Not built.**

**What shipped:** P5-A cron hygiene stripped stale killed entries (#267); frank2 crons rewired off
freeform Telegram onto bus surfaces (#233); legacy auditos/nonprofit/cxportal dropped from
monitoring crons (#307). **What's open/dropped:** the full deterministic-convert batch, the
KILL-15 / EVENT-11 / rewire-19 ledger as a tracked unit, and the completion-capture lane.

---

## Job 2 — GOOGLE / GMAIL = P4.1 event lanes `mail.human` + calendar (replace polling)

Original purpose: replace PA's **45-minute `comms-check` poll** (fired 2562×) and calendar
polling with **event-driven Gmail/Calendar push**, reusing the EXISTING fireflies/webhook-bridge
infra — Josh 2026-08-07 verbatim: *"for gmail and gcal use the same infra as fireflies and ops
inbound, dont build new external infra."*
Ref: `event-cron-modernization/00-discovery.md`.

Intended flow: Gmail Pub/Sub push → bridge validates Google OIDC JWT → extract historyId → wake
`pa.comms-check-worker`. Calendar watch → bridge validates channel token → wake booking delta.
Then **retire the 45m poll cron** (per the D3 single-fire rule).

**What drifted:** the codex sessions shipped it only in **"shadow ingress" mode** — observe,
authenticate, record receipts, and *propose* a worker spawn, but **never actually wake the worker
and never retire the poll cron** (#324, provider leases 753173cc, OIDC runtime). "Active-mode"
delivery was deferred post-merge. So today the event layer runs side-by-side with the poll it was
meant to kill — the exact double-fire the D3 rule forbids. **The job is ~70% built but stuck one
step short of its actual purpose.** (Note: an earlier attempt, #157 `5352f50b`, already did
"gmail push listener replaces 45m comms-check" — so this lane has been re-implemented more than once.)

Open branches (all currently 0-ahead of main = merged shadow work): `codex/google-*-178608`,
`codexer/google-pubsub-178614`, `larry/fleet-provider-ingress-178607`. Open remainder: activate
delivery + delete the poll cron.

---

## Job 3 — FIREFLIES = P4.1 event lane `meeting.completed` (webhook → PA)

Original purpose: when Fireflies finishes a transcription, fire an HMAC-verified webhook to the
bridge, which wakes PA's `meeting-commitments-worker` for that specific meeting id — ≤2 min
extraction instead of the 2-hour poll. Ref:
`meeting-intelligence-full/03-specs/08-fireflies-webhook-trigger-wiring.md`.

Flow: Fireflies dashboard POSTs `{meetingId,eventType}` + `x-hub-signature` → bridge verifies
HMAC-SHA256 (#232 `18574ae0`) → normalizes camelCase `meetingId→meeting_id` (#239 `ce6c7f85`) →
emits bus msg to **pa** (owner corrected off stale frank2 ref) → PA spawns extractor. 2h poll
survives as safety-net fallback.

**Ownership rule from v9:** PA owns meetings + comms pipelines. "Script location ≠ ownership" —
ff-extractor living under frank2/scripts is a legacy accident.

**Status:** cleanest of the three. Core landed. Open branches `fix/fireflies-hmac-webhook` (2),
`fireflies-native-payload-normalize` (1) may be already-merged variants. **The one real gap
Josh must close:** register the webhook URL in the Fireflies dashboard — 0 deliveries have ever
fired (P4.1⑤). Until then the lane is dormant and the poll is doing all the work.

---

## Context threads (not "jobs" — the scaffolding v9 ran on)

- **P1–P6**: the phase execution of v9. (P1 KB-graph layer, P4.x event/multica lanes, P5 cron
  purge, P6 weekly-review deterministic core, etc.) Josh mandate: strict P1→P6 order, completion
  earned only by true-verify, no `--mark-phase-complete` bypass.
- **RW-1..RW-10 / M1..M7 / WAVE0/A/B / LOOP1**: a *separate* reliability program (2026-08-02→04)
  to converge the fork back to upstream and kill daemon restart-loop churn. Code merged; live
  deployment gated on a Josh daemon restart. This is infrastructure under v9, not part of the 3 jobs.
- **Altari skilltree**: the source library of 137 job playbooks; its Phase-1 wiring = the proactive
  crons listed under Job 1. QA/reliability workstream (G) was correctly evaluated as REDUNDANT.

---

## The accreted complexity to CUT (the rabbit hole, 2026-08-05→09)

A later Codex/opencode session, triggered by the SEIU-521 durable-run incident, spawned a chain of
increasingly-tangled plans that are **not part of v9's three jobs** and should be quarantined:

1. `goal-run-control-plane/` — tight, fine as its own thing.
2. `autonomous-fanout-ledger/` — blended fan-out (WS1/WS2/WS3) INTO the goal runner's scope.
3. `obf-ledger-specs-supersession/` — a ledger "select latest verified row" fix triggered by the
   521 staging-proof failure.
4. `goalify-durable-loop-redesign/` — **three consecutive re-consolidations (v1→v2→v3 in 24h)** =
   clear thrash signal.

Three parallel implementations of the durable runner exist:
- **Lineage A** (`src/goals/`, PR #323 `a438da6d`) — reviewed, canonical, clean. **Then reverted
  (`085235ac`) after a 26h silent-deploy failure.**
- **Lineage B** (`src/daemon/goal-*.ts`, branch `larry/goal-durable-runner` — the branch we are on
  now) — a pre-#323 fork that silently became live via shared-checkout build. **Do not merge.**
- **Lineage C** (`src/daemon/pipeline-run-store.ts`, `pipeline-supervisor.ts`) — dead orphan wired
  into `agent-process.ts` by today's confused session, **no production callers. Delete.**

Root disease (both v1 and v3 plans name it): **no live-runtime receipt in the acceptance path** —
nothing forces "a real `/goal` on the live daemon produced an inspectable run file" before "done"
is claimed, so a checkout that never ships can pass every gate. Fix that ONE thing before adding
any feature.

**Recommendation:** branch `goal-durable-v2` from `origin/main` (has clean lineage A), delete
lineage C, live-prove before new code. Archive fanout-ledger + obf-ledger-supersession as
SEPARATE follow-up goals, not prerequisites. Keep them out of the three v9 jobs entirely.

---

## Clean replan skeleton (what to actually track)

**One umbrella:** v9 cron/event modernization (D3). Three lanes + a hygiene sweep:

| Lane | Purpose | State | Next action |
|------|---------|-------|-------------|
| Fireflies `meeting.completed` | webhook→PA extractor, retire 2h poll to fallback | core merged | Josh registers Fireflies webhook URL (HUMAN gate) |
| Google `mail.human`+calendar | Gmail/Cal push→wake worker, **delete 45m poll** | shadow-only | activate delivery + remove poll cron |
| Cron ledger D3 | 15 KILL / 11 EVENT / 19 rewire; deterministic-core+LLM-verify convert batch | partial | rebuild the ledger as one tracked unit; enforce remove-old-cron done-condition |
| Completion-capture lane | deterministic inbox scan → LLM-verify → mark commitment done, kill re-nag | **dropped** | build it — this was Josh's named FIRST target |

**Proactive crons (Altari P1):** delivery-status / exec-assistant / enrichment+records / KB-maint —
merged as code, verify live after next daemon restart.

**Quarantine (separate goals, not v9):** durable goal-runner v2, autonomous-fanout-ledger,
obf-ledger-specs-supersession.
