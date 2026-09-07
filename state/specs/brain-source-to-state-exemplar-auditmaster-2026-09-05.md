# Auditmaster-codex exemplar digest — CalAsia weekly delivery-status work

## 1. Session identity

- **File:** `/Users/joshweiss/.codex/sessions/2026/08/31/rollout-2026-08-31T17-12-41-01a05a4f-9bc0-7030-82ca-44d7e421ced4.jsonl`
- **How found:** No rollout file under `2026/09/04` or `2026/09/05` has `session_meta.payload.cwd` equal to the auditmaster-codex agent dir (checked all 446 September session files; the 8 files that do match that cwd are all from 09-01/09-02/09-03). Instead, the live thread pointer at `/Users/joshweiss/.cortextos/cortextos1/state/auditmaster-codex/codex-app-server-thread.json` names `threadId: 01a05a4f-9bc0-7030-82ca-44d7e421ced4`, `updatedAt: 2026-09-05T06:47:43Z`. That thread ID resolves to this file, filed under the 08-31 date directory (Codex names the rollout file by session-start date, then appends to it across days) but with `mtime = 2026-09-05 15:23` — i.e. it is the one continuously-running thread that was still being written to today. Confirmed as the right agent by `session_meta.payload.cwd = /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/auditmaster-codex`.
- **cwd:** `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/auditmaster-codex`
- **Session start:** 2026-09-01T00:12:41Z (session_meta timestamp; this is a resumed/continued thread — the very first user turn is a compressed-history boot message referencing turns back to 2026-08-31).
- **Size / counts:** 9,213 lines, 21.2 MB. `response_item` 6,242 (message/user 247, message/assistant 295, reasoning 1,297, custom_tool_call 1,176, custom_tool_call_output 1,176, function_call 138, function_call_output 138, agent_message 26); `event_msg` 2,742 (user_message 239, agent_message 295, task_started/task_complete ~163 each, patch_apply_end 123, mcp_tool_call_end 74); plus turn_context 169, world_state 26, inter_agent_communication_metadata 26, compacted 7.
- Of the 239 `user_message` events, 31 are genuine Slack turns from two human users in channel `C0AHQ1JN21K` (`U0ASLEPANGJ` and `U0AHQ1H4L2H`); the rest are cron heartbeats, inter-agent bus traffic, and session-boot text — not human asks.

## 4. The report shape (load-bearing)

Two artifacts constitute the "report skeleton" for this engagement, and they are materially different documents for different audiences — this matters for the pipeline design.

**A. Internal working report** — `outputs/calasia/2026-09-05-weekly-progress-report.md` (H1 title, then flat H2 sections, no tables, all bullet lists):

```
# CalAsia Weekly Update — August 31–September 4
## Completed this week
## Surveys complete for confirmed interviewees
## Major workflow observations
## Interviews booked
## Interview that needs to be rescheduled
## Highest-priority interviews still to schedule
## Confirmed-interviewee surveys still incomplete
## Other survey recipients without a completed survey
## What we still need
```
Every section is a named-person or named-observation bullet list, cited to specific evidence (a Fireflies transcript ID, a survey completion state, a calendar booking date, or a named workflow gap drawn from an interview). Nothing is stated without a name, date, or transcript ID attached. Tone: plain, declarative, zero hedging, zero internal process narration (no mention of CXPortal, dedup logic, or tooling — that lives in the companion roster file, not the report).

**B. Client-facing executive email** — never saved as a file; composed live in the transcript and sent via `cortextos slack send C0AHQ1JN21K` (drafted, reviewed by Josh in-thread, revised four times before being accepted). Final accepted skeleton:

```
*Subject: CalAsia Audit — Weekly Update*
Hi John and team,
[1-line thanks/context]
*Completed this week*  — bullets, outcomes only, no task/tool language
*What we learned*  — 1-2 short paragraphs, synthesized findings, softened ("the clearest areas to examine sound like consultant speak... none of it should make him defensive" — Josh's explicit note)
*Next interviews* — booked (named + date) / still to schedule (named) / needs reschedule (named)
*Surveys still needed* — confirmed-group gaps, then full deduplicated non-interviewee list
*Project folders* — the ask, softened into collaborative/help-oriented language, explicitly non-demanding ("no need to clean anything up," "let us know if we can hop on a quick call")
Best, Josh
```
This structure was explicitly derived mid-session from the **Delivery Status Reporter** skill, which the assistant fetched and paraphrased into working rules: *"lead with outcomes, separate completed work from next steps, state exactly what is needed from the client, and avoid internal process detail."* Every subsequent revision cycle is Josh pushing the draft further toward that rule (cut consultant jargon, add full dedup list, soften asks, credit the second onsite) and the assistant applying it.

Representative verbatim passages (final accepted email, 2026-09-05T22:20-22:21Z):

> "Thank you for your continued collaboration on this project. We made good progress this week, including four employee interviews and our second onsite working session with John."

> "The conversations are giving us a much clearer picture of how the work actually gets done—from estimating and project handoff through plan updates, accounting records, and closeout. We are also learning which tools and practices are working well and where employees spend extra time keeping information current across plans, email, spreadsheets, folders, and paper records."

> "There is no need to clean anything up or select individual documents. We would like to see the folders substantially as they exist today. We only need temporary read-only access or copies..."

Every outbound client text (both report and email) is first run through `the-humanizer`'s `lib_normalize.py`, hashed, and appended to `state/humanizer-ledger.jsonl` (channel, timestamp, agent) **before** the `cortextos slack send` call — a mandatory pre-send compliance/audit step with no equivalent in the brain spec.

## 7. Contradicts / extends the brain spec model

- **The brain spec's per-engagement `projects/<id>.md` (History + Open Items) has no equivalent status taxonomy as rich as what this session actually used.** The assistant's own audit of Altari (2026-09-05T22:10Z) states plainly: *"Alloi distinguishes useful state levels such as activity, delivery, verification, acceptance, adoption, and outcome more carefully than the generic client-delivery system."* The CalAsia report in practice tracks at minimum: survey-sent / survey-started / survey-complete, interview-booked / interview-needs-reschedule / interview-completed (with transcript ID as proof) / interview-not-yet-booked, plus a priority ranking by department (Accounting flagged as highest priority because it's the largest uncovered risk area). FR-011's `status_plan` needs to support this multi-axis per-person/per-workstream state, not just a single "open item" line.
- **Two different documents must come out of one status_plan, not one.** The internal report (evidence-dense, names + transcript IDs + dates, no audience softening) and the client email (outcomes-only, jargon-stripped, explicitly de-risked language, no tool/process mentions, "so it doesn't make him defensive") are both required outputs of the same weekly cycle, and the second is *iteratively hand-tuned against the first* through 6+ revision rounds driven entirely by tone/wording feedback, not new facts. A pipeline that emits only one canonical weekly artifact will not satisfy this workflow — it needs an internal ledger view and a separate client-safe rendering pass (and the render pass needs an explicit "compliance-sensitive language" softening step, which is a genuinely new requirement not in the FR list).
- **Evidence identity is Fireflies-transcript-ID-level, not meeting-record-level.** Completion of an interview is defined operationally as: *"An interview is complete only when a substantive Fireflies transcript identifies the interviewee and Mrin; calendar presence alone is not completion."* The dedup roster cites exact Fireflies IDs (e.g. `01M12KPER33TV2XF998HYE7BVC`) per person per date. The brain spec's meeting → canonical-record pipeline needs to carry the Fireflies transcript ID as a first-class field so downstream "is this workstream item actually done" logic can check it, not just presence of a calendar event or a generic "meeting happened" flag.
- **Survey/interview state lives in CXPortal (a separate Postgres-backed product, accessed via a Railway `DATABASE_URL` and/or an MCP token), not in the vault or CRM.** The pipeline's "canonical client record" needs an explicit CXPortal ingestion/read step (see Section 6) as a named source alongside Fireflies/Gmail/Slack — it is not covered by the existing delivery-status engine, which per the assistant's own audit brief *"consumes already-prepared history, issues, tasks, and interactions; it does not collect Gmail, Slack, meetings, CXPortal, or GitHub itself."* That gap — no first-party collector for any of those sources — is the single biggest blocker to automating this exact workflow.
- **Dedup is a hard, human-defined reconciliation rule set, not a generic entity-merge.** The roster file states explicit rules ("One row per person, regardless of duplicate survey-response records," "Any submitted 100% response overrides duplicate empty sends," "Shared Google Calendar events appearing on both Josh's and Mrin's calendars are counted once by event ID"). These are domain rules that must be encoded per-client/per-source, not inferred by a generic dedupe pass.
- **Google Calendar (two people's calendars, cross-referenced) is a required input the brain spec doesn't currently name as a source** — booked/needs-reschedule state is derived by joining Fireflies + two calendars + CXPortal survey rows, not from meeting transcripts alone.
- **A compliance/audit ledger step (humanizer hash-and-log) gates every external send.** Nothing in the brain spec's FR list currently accounts for a mandatory pre-send normalization/audit step before a weekly report or email leaves the system.

---

Additional sections (2, 3, 5, 6) below for completeness.

## 2. What Josh asked for, in order (Slack channel C0AHQ1JN21K; near-verbatim, light cleanup of dictation typos)

1. (09-01) "Can you create the interview questions doc for both Cynthia and Richard."
2. (09-01) "Can you give me an updated list of who booked interviews, completed surveys, who hasn't booked yet... in a list format" / "Format the text... proper line spacing."
3. (09-01) "Can you access the Fireflies recording of my call with Richard and update it in the system?"
4. (09-02) "I just wrapped up my call with Cynthia, can you take the transcript and update it in the CXPortal?"
5. (09-03) Provided six specific interview questions to add to Jack's guide "and integrate them in a human way, keep the questions natural."
6. (09-04) "Can you create the questionnaires for my interview with Todd tomorrow." Then iterative feedback: shorten/simplify questions, add example-answer direction, bullet points not prose blocks.
7. (09-04) "Update the transcript for Todd in CXPortal."
8. (09-04) "Can you review both our calendars and my Fireflies and confirm who is yet to complete their surveys and who still needs to book the interview with me?"
9. (09-04) "Please do the deduplication of CX Portal because I sent two surveys to some of the people — we need one list of people who have gotten surveys and not filled them, without the duplication."
10. (09-05) Full weekly-report brief: "using email, Slack, ... the pdfs, surveys and interviews, what did we accomplish this week for CalAsia and what is left. These are construction folks, need this simple and to the point... mention the 3 projects we still need if they're open to sending, and the deduplicated list of non-interview surveys we've sent but not got back. A weekly report."
11. (09-05) "Now give me a really concise and friendly construction-employee-friendly executive email summary I can send" — then iterative tone edits: add which surveys/interviews are still outstanding, mention the second onsite with John and its takeaways, soften "consultant speak" so it doesn't read as defensive-triggering, add the full deduplicated non-interview survey list, restore friendlier project-folder ask language from an earlier email.
12. (09-05) "Also look at our Altari folder of jobs and skills — which pertain to this workflow? ... anything we can learn from delivery status reporter?"

## 3. What got produced

- `outputs/calasia/2026-09-05-weekly-progress-report.md` (CalAsia engagement) — internal weekly status report, flat H2 sections (Completed / Surveys complete / Workflow observations / Booked / Reschedule / Priority-to-schedule / Incomplete surveys / Non-interviewee survey gaps / What we still need); everything cited by name, transcript, date.
- `outputs/calasia/2026-09-04-deduplicated-survey-interview-roster.md` (CalAsia) — reconciliation-rules header, then per-status bullet sections; cites explicit Fireflies transcript IDs per completed interview and explicit dedup rules used.
- `outputs/calasia/todd-jeffries-interview-guide-2026-09-04.md` (CalAsia) — 14KB structured interview guide: header (interviewee/role/length/date), "How to use this guide," "Questions this interview must answer," Opening, 10 required + 6 optional numbered questions each with a scripted probe, Close, Facilitator capture checklist, Evidence boundary.
- `outputs/clearworks-client-reporting/2026-09-04-fable-brief-recover-clearworks-brain.md` — not a client deliverable; a meta-brief specifying an audit of the Clearworks "brain" system itself (Mission Control, delivery-status engine, Alloi tactical reports, knowledge-sync/wiki), directly relevant to Section 7 below.
- `outputs/clearworks-client-reporting/2026-09-04-cortextos-source-ledger-inspection.md` — companion inspection doc (not read in full; headings not extracted, lower priority to this digest).
- Client-facing executive email — composed and sent via Slack only, never persisted as a file (see Section 4).
- Several `tmp/ingest_<name>_fireflies_to_cxportal.py` one-off scripts (Richard, Mario, Todd) that pull a Fireflies transcript and insert it into CXPortal's Postgres.

## 5. Inputs Josh/the session pulled from

- **Fireflies transcripts**, retrieved either via a Fireflies API/GraphQL call or already staged in CXPortal's Postgres (`meetings` table, queried via `railway variables --service Postgres --environment production` to get `DATABASE_URL`, then `psycopg2`). Exact transcript IDs cited: `01M12KPER33TV2XF998HYE7BVC` (Richard, 9-01), `01M18VRF46KK53XQ9WMP70YWGS` (Cynthia, 9-02), `01M1M7E33B0QDTBHYPT0392R2M` (Jack, 9-03), `01M1HF8Y58J1R0JAZTQGZ0JY5K` (Todd, 9-04).
- **CXPortal survey responses** — read via an MCP tool call (`ALL_TOOLS` filtered for `cxportal|survey response`) and/or direct Postgres query using a token file at `orgs/clearworksai/agents/larry-codex/state/cxportal-mcp-token.txt`.
- **Two Google Calendars** (Josh's and "Mrin's" — a second interviewer), cross-referenced by event ID to determine booked/needs-reschedule state.
- **Slack channel `C0AHQ1JN21K`** — the live client-work channel; both the asks and the delivered report/email round-trip through it.
- **Prior interview guides** (Cynthia, Richard, Jack, Vanessa, Mario) as format precedent for the new Todd guide.
- **Altari skills folder** (`community` skilltree — Status Updates/Delivery Status Reporter, Context Maintenance/Node Zero Knowledge Base Builder, Meeting Intelligence Engineer, Follow-Up Coordinator, Document Extraction/Records Administrator, Client Onboarding Manager) — consulted live, mid-session, to borrow structure/rules for the report and email.
- knowledge-sync vault was touched only tangentially in this thread for an unrelated CalAsia-deck session-log entry (`cc/sessions/2026-09-01_cortextos_calasia-deck-refresh.md`), not for the weekly-report pipeline itself.

## 6. Manual steps the pipeline would have to automate

1. **Pull new Fireflies transcripts for the week** — reads: Fireflies API/GraphQL or CXPortal `meetings` table; writes: nothing yet, just staged IDs+text in memory.
2. **Ingest each transcript into CXPortal** — reads: raw Fireflies transcript; writes: CXPortal Postgres `meetings`/related tables (via a one-off `ingest_<name>_fireflies_to_cxportal.py` script each time — this should become one reusable ingester, not a bespoke script per person).
3. **Pull current survey-response state from CXPortal** — reads: CXPortal survey-responses table/API; writes: none (read-only snapshot).
4. **Pull both calendars (Josh + Mrin) for booked/rescheduled interview state** — reads: Google Calendar API; writes: none.
5. **Reconcile/dedup** survey + interview + calendar state into one row per person, applying the explicit rules (submitted overrides empty duplicate; shared calendar event counted once; interview complete only if a Fireflies transcript names both parties) — reads: outputs of steps 2-4; writes: `outputs/calasia/<date>-deduplicated-survey-interview-roster.md`.
6. **Generate/refresh interview guides** for newly-scheduled interviewees, grounded in that person's survey answers and any prior interview evidence deltas — reads: roster + survey responses + prior evidence-delta docs; writes: `outputs/calasia/<name>-interview-guide-<date>.md`.
7. **Compose the internal weekly report** — reads: roster (step 5) + this week's transcripts/evidence deltas + open "what we still need" items; writes: `outputs/calasia/<date>-weekly-progress-report.md`.
8. **Compose the client-facing executive email** — reads: the internal report (step 7) + the Delivery Status Reporter skill's rules; writes: nothing durable today (a real pipeline should persist this too, not just Slack-send it) — apply the "outcomes only / no tool-talk / soften findings / explicit ask" transform.
9. **Humanizer compliance pass** — reads: final report/email text; writes: `state/humanizer-ledger.jsonl` (hash + channel + timestamp + agent) — mandatory gate before any external send.
10. **Deliver** — writes: Slack message to the client channel via `cortextos slack send <channel> "<text>" --as auditmaster-codex`, with retry-on-failure logic (Slack send failed silently multiple times in this session and had to be retried by hand).
11. **Iterate on tone/content with the human reviewer** (Josh) before final send — this loop (6+ revision rounds) is currently manual chat back-and-forth; a pipeline should expect at least one human-approval round before external delivery, not zero.
