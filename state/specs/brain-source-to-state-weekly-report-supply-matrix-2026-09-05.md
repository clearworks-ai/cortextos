# CalAsia weekly report → Brain supply matrix

Sources: `auditmaster-exemplar-digest.md`; session `01a05a4f-9bc0-7030-82ca-44d7e421ced4.jsonl` (email drafts extracted directly from the `cortextos slack send` / curl tool-call arguments — the `message`/`agent_message` response items are empty, the real text lives in `custom_tool_call.input`); `outputs/calasia/2026-09-05-weekly-progress-report.md`; `outputs/calasia/2026-09-04-deduplicated-survey-interview-roster.md`; `~/.claude/skills/delivery-status-reporter/SKILL.md`; `brain-source-to-state-2026-09-04-spec.md` §4a/FR-005/FR-011; `extraction.schema.json`; `orgs/_template.md`, `projects/_template.md`; real envelope `raw/media/transcripts/fireflies/01M1MW2GAZ1DQ0C6PG3KJ557JA/{extraction,resolution,writeback-payload}.json`.

---

## A. Final email, annotated

Sent successfully 2026-09-05T22:30 (`{"ok":true,"channel":"C0AHQ1JN21K","ts":"1788647423.061819"}`), sixth and last revision, replacing "Hi John and team" with "Hi John and Abbey":

> **Subject: CalAsia Audit — Weekly Update**
>
> Hi John and Abbey, `[recipient names: engagement contacts]`
>
> I hope you had a great weekend. There is a lot of information below, so please let us know when we can hop on a quick call to review it together. `[relationship tone / meeting-offer boilerplate — no data]`
>
> Thank you for your continued collaboration on this project. We made strong progress last week, including four employee interviews and our second onsite working session with John. `[count of interviews this period: extraction.json per meeting × 4; "second onsite" = ordinal count of a specific meeting type with John over engagement history]`
>
> **Completed last week**
> - Interviews with Richard, Cynthia, Jack, and Todd `[interview completed: participant name (theirs), meeting occurred_at date, Fireflies transcript id — one row per person]`
> - Review of all four transcripts and updates to our audit materials `[internal-process line — no discrete data element, references the 4 extraction.json objects as a set]`
> - An additional survey submitted by Arnel Page, bringing the confirmed interview group to 10 of 12 completed surveys `[delta-only survey completion: person, submission event, timestamp — PLUS a fixed roster denominator (12) and prior-period numerator to compute "additional" and the new total]`
>
> **What we learned**
> "The conversations are giving us a much clearer picture of how the work actually gets done—from estimating and project handoff through plan updates, accounting records, and closeout. We are also learning which tools and practices are working well and where employees spend extra time keeping information current across plans, email, spreadsheets, folders, and paper records." `[cross-meeting synthesis: aggregated summary.bullets + decisions[].text across the 4 interview extractions, abstracted to a theme — not any single meeting's summary]`
> "During our second onsite, John walked us through CalAsia's priorities, policies, templates, dashboards, and project files in greater detail... We will use the remaining interviews and project review to understand how those systems are used across different roles and jobs." `[single-meeting summary: the onsite's extraction.json summary.overview + decisions, plus forward-looking plan tied to open roster items]`
>
> **Next interviews**
> - John Gates — booked for September 9 `[booked interview: person, date — calendar event, cross-referenced against Fireflies for "not yet completed"]`
> - Rick Crame — booked for September 10 `[same]`
> - Still to schedule: Chris Ocampo, Mario Rodriquez, Joann Gates, Arnel Page, Ozzy Sotelo, and Vanessa Cejudo (reschedule) `[not-yet-booked roster remainder: roster minus {completed} minus {booked}; "(reschedule)" = a distinct sub-status — no-show + no replacement booking found on either calendar]`
>
> **Surveys still needed**
> *(within confirmed interview group: Joann Gates, Ozzy Sotelo)* `[roster member with CXPortal survey status = not-opened/opened-no-answers]`
> *(other invited non-interviewees, 14 names, several marked "started")* `[CXPortal survey rows for a distinct, non-roster distribution list; per-person status incl. partial-completion; deduplicated across duplicate sends]`
>
> **Project folders**
> "As we mentioned by email a few days ago, we think we could learn a lot from a copy of three actual project folders: one active project running relatively well, one active project with some complications, and one recently completed project that includes closeout. There is no need to clean anything up... We only need temporary read-only access or copies for the audit, and we will delete them when our review is complete. If it would be easier, let us know and we can hop on a quick call to help with the transfer." `[open ask to the client: a commitment/open-item owned by CalAsia (THEIRS), softened for tone; "as we mentioned... a few days ago" = reference to a prior sent artifact/email, i.e. history of a previous ask]`
>
> Thank you again to everyone who has shared their time and experience. It is giving us the practical context we need to make useful recommendations for CalAsia. `[closing boilerplate]`
>
> Best, Josh

---

## B. Revision rules

| Version (ts) | Prompt from Josh | Change rule applied | Generalizable client-rendering rule (candidate FR-011 rule) |
|---|---|---|---|
| V1 (22:04) | "give me a really concise and friendly construction employee friendly executive email summary I can send" | Condense the long internal report into a short outcomes-only email; strip transcript IDs / department-priority framing / tool language; add a friendly, plain-audience tone | **R1 — Condense-to-outcomes:** the client render drops all internal evidence identifiers (transcript IDs, CXPortal/tool names) and keeps only named outcomes; register vocabulary is set for the client's industry, not the internal audit register |
| V2 (22:08) | "we need a bit more which surveys are needed still, which interviews need to be booked, also mention... the second onsite with john... major takeaways" | Restore omitted status categories the first condensation had dropped (surveys-outstanding, interviews-to-book) and fold in the most recent meeting not yet reflected | **R2 — Completeness-over-brevity:** every open-item category present in the internal report (survey gap, interview-to-book, interview-to-reschedule) must appear in the client render even when shortened; a newly-ingested meeting since the last render must be reflected before send |
| V3 (22:13) | "anything we can learn from delivery status reporter? ... my nicer update ... a bit more next steps" | Adopted the Delivery Status Reporter skill's explicit rule set verbatim ("lead with outcomes, separate completed work from next steps, state exactly what is needed from the client, avoid internal process detail") and re-sectioned the draft under those four headers | **R3 — Canonical section template:** client render always uses (opening line → Completed → What we're learning → Next steps → Needed from you) in that order, sourced from an external, named rule set rather than ad hoc prose |
| V4 (22:19) | 'add "thanks for your continued collaboration" intro; soften "consultant speak" so it doesn't read defensive; add the full non-interview deduplicated survey list; restore the softer project-folder ask from a prior email' | De-risk findings language (no wording that reads as blame/deficiency); switch a curated/representative list to the exhaustive deduplicated list; reuse a previously-sent softened ask verbatim rather than regenerating it | **R4 — Tone de-risk + exhaustive lists + ask reuse:** findings must be phrased as observations, never deficiencies; any "still outstanding" list must be the full deduplicated set, not a sample; a recurring ask (e.g. folder access) is pulled from its prior sent version, not freshly drafted, so wording stays consistent across sends |
| V5 (22:23, same text as V4) | *(none — Slack send failed, retried via direct `curl` to the Slack API)* | No content change; this is a delivery-transport retry, not a rendering rule | **N/A** — operational reliability gap (see gap list), not a client-rendering rule |
| V6 (22:29, FINAL, sent) | "Make it John and Abbey not john and team... say I hope you had a great weekend... please let us know when we can hop on a quick call... say we made strong progress last week... in 'completed last week' only ADDITIONAL surveys submitted (new total 10 of 12)... add vanessa to the schedule line, '(reschedule)' in parens" | Correct named recipients (exact people, not a group label); add relationship-warmth opener + explicit call invite; switch "Completed" section from cumulative to delta-since-last-send with a running total; merge a reschedule case into the scheduling line instead of a separate section | **R5 — Delta reporting + exact recipients + status-merge:** (a) recipients render as the named individual contacts on the engagement, never a generic salutation; (b) "Completed this period" reports only what changed since the last render, with a running total computed against the roster denominator; (c) a status like "needs reschedule" may be inlined as a parenthetical tag on the person's line rather than a separate section, as long as the underlying status value is preserved |

---

## C. Skill requirements — `delivery-status-reporter/SKILL.md`

**Inputs it declares:** `cortextos bus kb-query` first, then org knowledge file (company name, team); `knowledge/voice.md` (writing voice); `knowledge/clients/[client].md` (scope, contacts, milestones, current state, date of last update); portal sync log / recent outputs if present. Falls back to 2-3 questions if files are absent; never blocks.

**Classification gate (before drafting):** GOOD/NEUTRAL (shipped, on-track, asks) vs. BAD (delay/blocker/scope problem/apology) — mixed news counts as BAD and routes to a private human brief instead of a client draft.

**Sections it emits (good-news path):** opening line leading with the strongest item (never "just checking in") → **Done since last update** (2-4 outcome bullets) → **In progress** (1-2 bullets with dates) → **Needed from you** (only if real, named, dated — omit if empty) → one closing line naming the next milestone and next contact date.

**Bad-news path:** private brief only (impact, options, recommendation), never auto-sent, labeled `BAD NEWS · HUMAN REVIEW REQUIRED`.

**Output artifact template:** `# Status Update: [Client] · [date]` with `Type`, `Classification`, `Status`, `## The Update`, `## Cadence` (last/this/next-due), `## Flags`. Filed to `raw/areas/clearworks/clients/[client]/status-update-[YYYY-MM-DD].md` (good/neutral) or `status-brief-[YYYY-MM-DD].md` (bad/mixed) in knowledge-sync, plus one line logged back into the client knowledge file. Cadence check (default 7 days) runs on every invocation across all active clients.

**Rules:** proactive only (never client-asked-first); one ask maximum, named + dated; outcomes not tasks; never inflate; lead with the strongest item.

This is a single-document, single-audience model (one client draft + one optional private brief). The CalAsia session instead needed **two simultaneously-required documents from one state** (dense internal ledger + softened client email), produced through 6 human-tone-review rounds — a materially heavier loop than the skill's "draft once, one approval, send" design.

---

## D. Supply matrix

Counts: **6 supplied · 6 derivable · 9 missing** (21 rows).

| # | Data element | CalAsia example | Brain field | Status | Notes |
|---|---|---|---|---|---|
| 1 | Meeting occurred + who was in it | Richard Martinez interview, 2026-09-01 | `source.json.occurred_at`, `.participants[]` | **supplied** | FR-001 fetch + envelope |
| 2 | Meeting outcome summary / decisions with quotes | Estimating/handoff workflow observations | `extraction.json.summary`, `.decisions[].text/.quote` | **supplied** | FR-002/FR-003; quote-gated (D-08) |
| 3 | Fireflies transcript ID as first-class evidence citation | `01M12KPER33TV2XF998HYE7BVC` | `source.json.source.id`; carried into meeting-note frontmatter `source: fireflies:<id>` and the History line `[source: kind:id]` (FR-005) | **supplied** | Confirmed live in the real envelope (`resolution.json`, meeting note pattern) |
| 4 | "Interview completed" as a person-level status, not just "a meeting happened" | *"An interview is complete only when a substantive Fireflies transcript identifies the interviewee and Mrin"* | no equivalent field | **missing** | `extraction.json` has no `interview_type`/`participant_role` or completion flag; a meeting note existing ≠ a roster member's interview-status; needs a roster + per-meeting role tag |
| 5 | Cross-meeting synthesis ("what we learned" across 4 interviews) | *"clearer picture of how work actually gets done—from estimating... through... closeout"* | none | **missing** | FR-011's `status_plan.ts` only merges `## History`/`## Open Items` text blocks for the existing generic engine; nothing composes a new synthesized paragraph across N extractions |
| 6 | Open ask to client (project folders) | 3 representative project folders, read-only | `extraction.json.commitments[]` with `owner_name` = a THEIRS participant → FR-005 Open Items row (`owner`, `commitment:<id>`) | **derivable** | Structurally present (commitments/Open Items carry owner+text+quote), but the *aggregated, cross-meeting, softened* ask in the email is not one commitment — it is several meetings' asks merged and re-worded; the raw Open Items row would read as unsoftened evidence text |
| 7 | Survey sent / started / complete per person | Arnel Page survey submitted; Abbey Ocampo "partially complete" | none (CXPortal, a separate Postgres product) | **missing** | No source type for CXPortal exists in `source.json.source.kind`; brain v1 is Fireflies-only (spec line 32, "source-agnostic... gains `--source-ref` when the second source lands") |
| 8 | Interview booked / needs-reschedule (calendar) | John Gates booked Sept 9; Vanessa Cejudo needs reschedule | none (Google Calendar, two people's calendars) | **missing** | No calendar adapter/source kind exists; digest confirms "Google Calendar... is a required input the brain spec doesn't currently name as a source" |
| 9 | Deduplicated non-interviewee survey-invite list | 14 names, several "started" | none | **missing** | Same CXPortal gap (#7) plus a distinct, non-roster distribution list the brain has no concept of at all |
| 10 | Dedup reconciliation rules (submitted overrides empty duplicate; shared calendar event counted once by ID) | roster header rules | none | **missing** | Human-defined per-client rule set; not a generic entity-merge the brain's resolver performs (resolver dedups meeting/home-page identity, not survey/calendar rows) |
| 11 | Roster of expected interviewees (12 confirmed names) as a denominator | "10 of 12 surveys complete" | none | **missing** | Nothing in `source.json`/`extraction.json`/templates defines a target roster independent of meetings that already happened; needed for any "N of M" framing |
| 12 | Department / priority ranking of an outstanding item | Chris Ocampo (Accounting) = highest priority, "largest uncovered risk area" | none | **missing** | No `department` or `priority` field anywhere in extraction schema or templates; this is an analyst judgment layered on top of roster + coverage gaps |
| 13 | Delta-since-last-send framing + running total | "An additional survey submitted by Arnel Page... 10 of 12" | derivable from `## History` (dated, newest-first) diffed against `last_update:` in `## Reporting` | **derivable** | The generic engine (`delivery-status.ts`) already filters History strictly after `last_update` (G-53) — the mechanism for "since last time" exists; the survey-specific total still needs #7/#11 |
| 14 | Client contact names for salutation (John, Abbey) | "Hi John and Abbey" | `## Reporting: contact:` field in `projects/<id>.md` (per template) | **derivable** | Template has one `contact:` line, singular; needs to support a list of named contacts, not currently multi-valued |
| 15 | Org/engagement identity, relationship = client | CalAsia | `extraction.json.classification.org_name/.relationship`; `resolution.json.node/home_path` | **supplied** | Verified live in the real Alloi envelope |
| 16 | Delivery-state / project status ladder | (CalAsia has no `proposed_delivery_state` example in digest, but the mechanism is general) | `extraction.json.proposed_delivery_state`, node's `delivery_state:` | **supplied** | Forward-only promotion (D-08); works for any client incl. CalAsia once meetings are ingested |
| 17 | Cadence / last-update / next-due for the drumbeat | (not shown in CalAsia email, but skill requires it) | FR-011 composes from the existing `buildStatusReportPlan`, which the Delivery Status Reporter skill itself already targets (`src/bus/delivery-status.ts:533`) | **supplied** | Engine-level, unchanged by FR-011 |
| 18 | Two audience-specific renders from one state (internal ledger + client email) | internal `2026-09-05-weekly-progress-report.md` vs. the Slack email | none | **missing** | `status_plan.ts` (FR-011) produces one markdown for the unchanged generic engine; nothing specs a second, tone-softened, audience-specific pass, nor two separate output files |
| 19 | Pre-send compliance/audit gate (humanizer hash-and-log) | every `cortextos slack send` call preceded by `lib_normalize.py` + `state/humanizer-ledger.jsonl` append | none | **missing** | Not referenced anywhere in the brain FR list; this session made it a hard gate before every external send |
| 20 | "As we mentioned by email a few days ago" — reuse of a prior sent artifact's wording | project-folder ask reused verbatim from `2026-09-02-three-project-folder-request-email.txt` | none as a queryable object; the *text* would live in a future client-render output file if #18 existed | **derivable** | Once client-facing renders are persisted (fix for #18), a simple "most recent prior render for this node" lookup supplies this; today it's a manual `sed`/grep-and-recall step in the transcript |
| 21 | Meeting-type distinction (interview vs. onsite/working-session vs. internal) | "our second onsite working session with John" vs. four "interviews" | `extraction.json.meeting_type ∈ {sales, delivery, internal, other}` | **derivable** | The enum exists but has no `interview` vs. `onsite` granularity — both would land as `delivery`; ordinal count ("second onsite") needs a filter on a sub-type the schema doesn't carry today |

---

## E. Gap list, ranked

Ranked by how many report/email sections break without the fix (highest first). "Josh already decided" markers per current framing: **open_questions: add**, **onboarding flow: add**, **external adapters (CXPortal / calendar / PDF): WAIT**.

1. **No CXPortal (survey) source adapter** — breaks: Surveys-complete, Surveys-still-needed (both roster and non-roster lists), the "N of 12" running total, dedup rules, "additional survey submitted" delta. **Smallest fix:** new `source.json.source.kind: "cxportal"` fetch script emitting the same envelope shape (survey Q&A as `text_units`, respondent as the sole `theirs` participant) so extraction/resolution/writeback stay unchanged — a new FR (e.g. FR-015) at the FR-001 layer only. **Status: WAIT** (Josh-decided; external adapter).
2. **No Google Calendar source/cross-reference** — breaks: Interviews-booked, Needs-reschedule, Highest-priority-still-to-schedule. **Smallest fix:** a calendar fetch producing a lightweight envelope (or a resolution-only side input) keyed by attendee + event ID, joined against Fireflies presence per FR-005's existing person-slug resolution. **Status: WAIT** (Josh-decided; external adapter).
3. **No roster/target-list concept** — breaks: every "N of 12", every "still to schedule/still needs survey" list, priority ranking, delta framing. **Smallest fix:** one new field on the engagement template (`projects/<id>.md`) — `## Roster` (or a `roster.json` sidecar) listing expected names + role/department; FR-011's `status_plan.ts` reads it alongside History/Open Items. This is the cheapest, highest-leverage fix on the list and does not require an external adapter.
4. **No cross-meeting synthesis pass** — breaks: "What we learned"/"What we are learning" in every email version. **Smallest fix:** extend FR-011 (or a new FR-011b) to run one additional bounded `claude -p` pass over the merged History block (same pattern as FR-002) producing a `synthesis` field, gated the same way as extraction (quote-checked against the source History lines).
5. **No two-audience render (internal ledger vs. client-safe email)** — breaks: the entire premise that one `status_plan` run produces both artifacts Josh actually needs. **Smallest fix:** FR-011 emits the existing engine's `## The Update` as the internal record, and adds a `--client-render` mode applying rules R1-R5 from table B as a second deterministic-then-LLM pass, writing a second file (e.g. `status-update-client-[date].md` alongside the internal one) — this is the FR gap the digest and this session both call out explicitly.
6. **No pre-send compliance/audit gate** — breaks: nothing in the report *content*, but every external send in this session was gated on it and nothing in the FR list accounts for it. **Smallest fix:** add a mandatory step to FR-011/FR-013's pipeline (hash + ledger append) mirroring `lib_normalize.py` + `state/humanizer-ledger.jsonl`, run immediately before FR-008/FR-013 file/send steps.
7. **No department/priority field** — breaks: "highest-priority interviews still to schedule" ranking only. **Smallest fix:** add optional `department`/`priority` to the roster sidecar from #3, not to `extraction.json` (it's a roster attribute, not a per-meeting one).
8. **No interview-vs-onsite meeting sub-type** — breaks: the "second onsite" ordinal count only. **Smallest fix:** add a controlled sub-tag to `meeting_type` or a free-text `meeting_subtype` string on `extraction.json`, populated by the same extraction prompt.
9. **No multi-contact template field** — breaks: correct salutation only ("Hi John and Abbey" vs. one `contact:`). **Smallest fix:** change `## Reporting: contact:` to accept a comma-separated list or `contacts:` array in `projects/_template.md`.

**Open_questions / onboarding-flow additions** (Josh-decided to add, not evaluated for engineering cost here): both are process/config additions layered on top of the roster fix (#3) and the two-audience render fix (#5) — an "open_questions" ledger would most naturally live as another section on the roster sidecar or the engagement's `## Open Items`, and an onboarding flow would populate the roster (#3) and contacts (#9) for a new engagement before any meetings exist.

---

## F. Verdict

As specced through R3 (FR-001–FR-014), the brain can reliably supply a **meetings-only** client's weekly projection today: meeting occurrence, participants, quoted decisions/commitments, Fireflies-ID-level evidence, delivery-state promotion, and the generic engine's cadence/History/Open-Items substrate are all real and, per the live Alloi envelope inspected here, already working end to end — that covers roughly a third of what the CalAsia email actually needed (rows 1-3, 15-17, 21 in table D). It cannot yet supply an **audit client with surveys and calendars** like CalAsia: nine of the twenty-one required elements are missing outright, and every one of the missing items is either an external-source gap Josh has already chosen to defer (CXPortal, calendar) or a data-model gap the source-to-state spec never had to solve because its acceptance meeting (Alloi Tacticals) never needed a roster, a priority ranking, or a second audience-specific render. The minimum R3 addition that would make the *existing* Fireflies-only scope usable for a construction-audit-style weekly report — without waiting on CXPortal/calendar — is: (a) a roster/target-list sidecar on the engagement template (gap #3), (b) a bounded cross-meeting synthesis pass reusing the FR-002 `claude -p` pattern (gap #4), and (c) a client-render mode on FR-011 that applies the R1-R5 tone/structure rules and writes a second, audience-specific file next to the internal one (gap #5) — plus folding the humanizer pre-send gate into the same pipeline (gap #6) since every external send in the real session was already hard-gated on it. Those four are pure brain/spec-layer work, require no new external adapter, and would let a meetings-only engagement (Alloi-style) get the full two-document weekly drumbeat; CXPortal and calendar remain correctly WAIT-ed as the two adapters that gate a *survey-and-calendar* engagement like CalAsia specifically.
