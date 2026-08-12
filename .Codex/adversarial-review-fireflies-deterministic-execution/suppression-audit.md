# Suppression audit: meeting, CRM, email, lead, and writeback paths

Date: 2026-08-11 PDT  
Mode: read-only forensic audit; no suppression, CRM, config, or runtime state was changed.

## Executive diagnosis

The `pts.org` block and the historical Marcos block are the same failure class: a narrow routing/classification instruction was flattened into identity suppression.

- **PTS/MSIA intended rule:** do not create or resurface a second `PTS Operations` deal; PTS and MSIA are the same client, and PTS must not be routed to Hunter or framed as a new opportunity. The source memory says exactly that at `knowledge-sync/.../feedback_pts_is_msia.md:10-14`.
- **Actual PTS rule:** the active ingest file blocks the entire `pts.org` domain plus five IDs/four names. The generic upsert chokepoint applies it to all contact creation/update attempts. Julie Lurie is not named; `julie@pts.org` is collateral damage from the domain rule.
- **Marcos intended rule:** never route Marcos/Alloi to Hunter; route follow-up questions to CRM only. The source memory says exactly that at `feedback_marcos_alloi_crm_only.md:10-14`.
- **Historical/remaining actual Marcos rules:** a months-old request to stop a sales reminder became a name-substring hard-no across meeting extraction, whole-meeting recap drafting, and commitment surfacing. The canonical extractors were corrected on 2026-08-09, but the enabled recap-draft worker and enabled meeting-commitments skill still contain Marcos hard-nos.

The system already contains the explicit meta-correction: `feedback_dont_flatten_routing_rules_into_suppression.md:10-16` records Josh twice rejecting flat suppression of PTS/MSIA, Marcos/Alloi, RRK, and Dulce because they are active clients/prospects. The live policies do not consistently honor that correction.

## Symptom

1. Julie Lurie's email interactions exist, but her CRM contact has an empty email array.
2. Marcos meetings/commitments were historically dropped and parts of the active automation still suppress him.
3. CRM/Hunter/stale-sweep rules mix several different semantics—global ignore, CRM dedupe, lead-sourcing exclusion, relationship ownership, and no-contact—under generic “suppression” names/tags.

## Evidence and call paths

### 1. `pts.org` / Julie Lurie

The active runtime data file is ignored by git and therefore has no repository commit history:

- `orgs/clearworksai/agents/crm/crm/_ingest_suppression.json:2-18`
- `.gitignore:17` ignores `orgs/clearworksai/*`
- filesystem modification time: 2026-06-25 12:53:45 PDT

Its exact contents are:

- reason: `PTS = Peace Theological Seminary = MSIA (same entity). Josh-confirmed repeated deletion 2026-06-25. Never re-ingest.`
- domain: `pts.org`
- contact IDs: `hugo-alvarado`, `veronica-zarate`, `sherie-wylie`, `gabyg`, `gaby-grigorescu`
- normalized names: Hugo Alvarado, Veronica Zarate, Sherie Wylie, Gaby Grigorescu
- no explicit email addresses; no organization object; no aliases

The Python CRM chokepoint is active and global to callers of `upsert-contact.py`:

1. `upsert-contact.py:16-18` resolves `CRM_SUPPRESSION_PATH`, defaulting to `_ingest_suppression.json`.
2. `load_suppression()` at `:31-37` loads it and fails open if absent/unreadable.
3. `check_suppressed()` at `:40-55` tests exact contact ID, accent-insensitive exact name, then exact email domain.
4. `main()` at `:162-169` checks every upsert, prints `SUPPRESSED (...)`, returns success code 0, and does not write.

The Zoom/new-registration path independently mirrors the same policy:

1. `src/cli/webhook-bridge.ts:760` derives the sibling suppression path.
2. `processRegistrant()` at `src/cli/zoom-officehours-crm.ts:273-363` calls `checkSuppressed()` only for the `NEW` tier (`:323-331`).
3. `checkSuppressed()` at `:174-195` implements the same ID/name/domain precedence.
4. Existing EMAIL/NAME merges deliberately bypass suppression (`:310-320`). Thus this copy has different scope than Python `upsert-contact.py`, which checks both new and matched contacts.
5. `tests/unit/cli/zoom-officehours-webhook.test.ts:353-362` proves a blocked domain returns tier `SUPPRESSED` and is not written.

Persistent-memory observation **#37581** is direct runtime evidence:

- `upsert-contact.py` rejected `julie@pts.org` with `SUPPRESSED`.
- Julie's email remained absent from `contacts.json` while interactions continued to be logged.
- At least **one confirmed Julie email write** was blocked. The logs do not provide a trustworthy complete count of all historical skipped emails.

Observation **#37579 is not suppression evidence**. It records Niccolo Boldrin's missing company/context fields after an upsert and compares the incomplete contact to Julie; it does not attribute Niccolo's problem to `_ingest_suppression.json`. That issue belongs to the useful-but-incomplete moving CRM enrichment loop, not this policy root cause.

#### Provenance versus actual scope

The canonical memory says:

- `feedback_pts_is_msia.md:10`: PTS Operations is the same entity as MSIA and must not exist as a **separate CRM record**.
- `:12`: the harm was duplicate “dropped thread” alerts.
- `:14`: delete/correct the duplicate and never route PTS to Hunter or frame it as a new opportunity.

It does **not** say to erase PTS/MSIA people, block their email identity, stop recording meetings, or prevent email enrichment. `feedback_dont_flatten_routing_rules_into_suppression.md:12-14` explicitly clarifies that PTS is a real client and the rule means “don't surface as a NEW lead,” not “ignore this person.”

The current domain block therefore overreaches from **CRM duplicate-deal / Hunter routing** into **global contact identity ingest**.

### 2. Marcos Santa Ana / Alloi

The exact intended rule is `knowledge-sync/.../feedback_marcos_alloi_crm_only.md:10-14`:

- do not route Marcos/Alloi to Hunter;
- do not include him in Hunter priority lists, outreach checks, or intel escalations;
- route Marcos follow-up questions to CRM only.

The provenance correction is even more explicit at `feedback_dont_flatten_routing_rules_into_suppression.md:16`: the original ask was to stop months-old reminders; Josh said “marcos is not suppressed ... i just was sick of those reminders months ago.”

#### Corrected canonical extractor (active code, suppression dormant)

`orgs/clearworksai/agents/pa/scripts/ff-extractor.py:251-254` documents the root cause in code: the old reminder ask “had grown into a hard-no substring filter” that silently dropped a real client from all meeting writeback/extraction. `SUPPRESSED_NAMES = ()` now disables it.

- `is_suppressed()` remains at `:1383-1387` but cannot match.
- `is_suppressed_meeting()` remains at `:2031-2050` but cannot match.
- `run_recap()` still contains the whole-meeting `continue` at `:2204-2206`, dormant while the tuple is empty.
- The frank2-codex extractor has the same correction at `scripts/ff-extractor.py:170-173`.
- Claude-mem observations #35953-#35959 document the 2026-08-09 removal and the inverted regression tests. Tests now require Marcos items and meetings to survive.

#### Remaining active or enabled hard-nos

1. **Enabled recap-draft worker:** `orgs/clearworksai/agents/pa/scripts/meeting_recap_draft.py:21` still defines `SUPPRESSED_NAMES = ("marcos santa ana",)`. `is_suppressed_meeting()` at `:116-126` concatenates title, client context, organizer, and all attendee strings. `process_meetings()` at `:242-251` skips the entire meeting before tiering or drafting if any substring matches. The cron manifest marks `meeting-recap-draft` enabled every 4h (`orgs/clearworksai/agents/larry/state/cron-manifest.json:301-303`). Runtime worker logs show a recent recap run reporting “1 suppressed,” but the available log does not preserve a clean enough structured receipt to prove that item was Marcos.
2. **Enabled meeting-commitments worker:** `orgs/clearworksai/agents/frank2/config.json:111-114` and `frank2-codex/config.json:100-103` schedule the worker every 2h. The skill post-filter says “Anything mentioning Marcos Santa Ana (hard no — never surface)” at `orgs/clearworksai/skills/meeting-commitments-worker/SKILL.md:92-96` and the live frank2-codex plugin copy at `plugins/.../meeting-commitments-worker/SKILL.md:92-96`.
3. **Stale specs/reviews:** `.agent/one-big-feature/meeting-recap-draft-worker/*` describe three-layer Marcos suppression and old tests, but are design/history artifacts, not runtime on their own.
4. **Contradictory writeback evidence:** current CRM writeback fixtures and verified parser evidence treat Marcos as a valid attendee and commitment owner. `state/live-receipts/2026-08-10-prod-activation.md:127-133` shows the 2026-08-06 Marcos meeting reached extraction but was skipped by the unrelated “casual” classifier, not identity suppression. This is another unsafe gate but is distinct from suppression policy.

Marcos therefore shares the same root cause as Julie: a narrow routing/reminder rule became blanket identity suppression. Unlike Julie, canonical extraction has been corrected, but two enabled downstream surfaces retain the old hard-no.

### 3. Does atomic all-attendee preflight turn one suppressed identity into whole-meeting failure?

**Production/current main: no.** The production path is sequential. `upsert-contact.py` returns success with empty stdout for a suppressed attendee; `fireflies-ingest.py` skips an empty contact ID and continues. Suppression can silently omit that attendee/contact but does not itself abort the meeting.

**Repair commit `2fb8c535`: also no for suppression, yes for identity conflict.** The undeployed branch performs one locked batch preflight. In that commit's `upsert-contact.py:273-290`, a suppressed attendee becomes `{id:"", suppressed:..., created:false}` and other attendees continue. A later **identity conflict**, however, aborts and rolls back every attendee and all downstream writes; `test_late_attendee_identity_conflict_rolls_back_earlier_contact` proves that atomic behavior. `.Codex/.../research/fable-diagnosis.md:159-164` confirms `2fb8c535` is not an ancestor of production commit `5389b713` and was not deployed.

**Recap-draft name filter: yes.** This is a different atomicity bug: one attendee/title/context substring matching Marcos causes `process_meetings()` to `continue` the entire meeting at `meeting_recap_draft.py:249-251`.

## Current suppression inventory

### A. Global CRM contact-ingest denylist (active)

| Dimension | Current values | Semantics implemented |
|---|---|---|
| Domain | `pts.org` | Reject any supplied address on the domain |
| Contact IDs | `hugo-alvarado`, `veronica-zarate`, `sherie-wylie`, `gabyg`, `gaby-grigorescu` | Reject exact ID |
| Names | Hugo Alvarado, Veronica Zarate, Sherie Wylie, Gaby Grigorescu | Reject normalized exact name |
| Emails | none | No exact-address facility exists |
| Organizations | none as typed objects | Domain is acting as an organization-wide proxy |
| Aliases | none | Aliases are not checked |
| Patterns | exact domain after lowercase/`@` strip; exact accent-insensitive name; exact ID | No scope/type/expiry/provenance fields |

### B. Meeting extraction, recap, tasks/drafts, and writeback

| Rule | Active state | Actual behavior |
|---|---|---|
| Canonical `ff-extractor.py` `SUPPRESSED_NAMES` | Dormant (`()`) | Infrastructure remains, no identities match |
| PA `meeting_recap_draft.py` Marcos tuple | Enabled worker | Any matching title/context/attendee suppresses whole recap/draft |
| meeting-commitments skill Marcos post-filter | Enabled every 2h | Drops any commitment text mentioning Marcos |
| Rachel security deliverables/JSP | Enabled meeting-commitments + CRM ingest guidance | Record interaction; suppress Josh-facing false-positive followups only |
| Logic-TCG ecosystem / old-job | Active CRM followup/lead filters | Record interactions; no sales followups/outreach/lead framing |
| RRK / Russian Riverkeeper | Active narrow memory + lead-source tags | Project coordination, not a sales lead; factual logging allowed |
| Dedup ledgers | Active, event-scoped | Suppress repeat processing/notification for same source event; not identity suppression |
| `meeting_type == other/casual` gates | Active but separate defect | Can suppress downstream outcomes based on classification, not identity policy |

### C. Hunter / stale-relationship / lead-sourcing exclusions (active code; Hunter itself is permanently shut down)

`scan-stale-relationships.py:14-26,48-66` excludes:

- categories `client`, `internal`, `other`;
- exact tags `suppress-from-prospecting`, `deal-stage:lost`, `active-client`, `internal-staff`, `friend-relationship`, `hard-no`, `do-not-engage`;
- any tag containing `logic-tcg`;
- companies Logic Technology Consulting Group, Logic TCG, SEIU 521, Thread;
- client-org tags `client-org:41`, `client-org:66`;
- any `@clearworks.ai` email;
- recently active contacts when the optional signal file exists.

Current `contacts.json` counts:

- 9 contacts with `suppress-from-prospecting`: Yohan Ruparatne, Dulce Appiagyei, Francesca Belmonte, Mark Lurie, Mrinmayi Sawant, Josh Weiss (`josh-weiss`), Josh Weiss (`josh-weiss-484`), Clearworks AI, Philip Koncar.
- 41 contacts with a tag containing `logic-tcg`: Matt Linn; Mathew, Tyler, Jay Owens; Yohan Ruparatne; Melinda Prisco; Jordan Abrams; Kenneth Cooper; Dillon Daniel; Brian Nguyen; Violet Tudas; Shane Farkas; Eva Galanes-Rosenbaum; Nick and Phanada Bouakhasith; Ariel Majorana; Cedie Basilio; Jaime Neary; Eliana Honeycutt; Rob Schwenker; Severine Tatangelo; John Cantrell; Charles Nguyen; Francesca Belmonte; Natalie Deering; Rody Lopez; Rick Wang; Son Quach; Kyle Fortier; Jorge Miranda; Carol Shumate; Fadwa Rashid; Yvonne Borcherds; Tiffany Markarian; Ashlyn R.; Amelia Richardson; Dean Malley; Neesha Rose; Rebecca Vonloewenfeldt; Tyler Woodard; Mitch (Logic TCG).
- 1 `do-not-engage`: Philip Koncar.
- 1 `deal-stage:lost`: Dulce Appiagyei.
- 0 current `hard-no` tags.

This sweep is **lead-sourcing-only**, not a global contact block. Much of it is correctly scoped. The overreach risk is terminology and tag reuse: `suppress-from-prospecting` includes active client Mark Lurie and the Dulce rule is “Josh handles this thread,” not “ignore the person.”

### D. Email capture

No separate person/domain email-capture denylist was found. Email-to-contact enrichment inherits the global Python `upsert-contact.py` denylist, which is why `pts.org` blocks Julie. Interactions can still be logged, producing the inconsistent state seen in #37581: history exists, identity email is blank.

### E. Stale or non-runtime definitions

- `.agent/one-big-feature/meeting-recap-draft-worker/` three-layer Marcos specs/reviews: history only.
- CRM backup files under `backups/pts-purge-2026-06-25` and `contacts.json.bak*`: forensic history only.
- `ff-extractor.py` suppression functions with empty tuples: executable but operationally dormant.
- Atomic batch attendee preflight commit `2fb8c535`: repair branch only, not production.
- `state/specs/CHAIN-PROGRAM-GOAL-2026-08-11.md` says duplicate workers were retired, but agent configs and the cron manifest still mark meeting-commitments/recap enabled. Runtime config wins; the tracker is stale or the retirement is incomplete.

## Impact

- **Julie:** at least one directly observed `julie@pts.org` upsert was rejected; her CRM email remained empty while interactions were retained (#37581). Every future new/matched upsert through the Python helper with a `pts.org` address is likewise blocked.
- **PTS/MSIA identities:** every address at `pts.org`, not only the four historical PTS duplicate contacts, is affected. The full population cannot be quantified from existing logs because suppression returns exit 0 and there is no structured receipt ledger.
- **Marcos:** historical canonical extraction dropped all matching meetings/items until the 2026-08-09 correction. Enabled recap drafting still drops the whole meeting on a match; enabled commitment surfacing still drops matching items. A recent recap worker log reports one suppressed item, but does not provide a durable identity-specific receipt. The Aug 10 live replay's Marcos miss was classifier-caused, not suppression-caused.
- **Observability:** suppressed Python upserts look successful to orchestration (`return 0`) and only emit stderr; the event ledger does not record policy ID, scope, subject, caller, or decision. Accurate retrospective counts are therefore unavailable.

## Root cause

The data model has no policy types. It stores identities inside generic deny constructs and lets each consumer interpret “suppressed” independently. This collapses at least six different intentions:

1. duplicate CRM entity/deal deletion;
2. lead-sourcing/Hunter exclusion;
3. CRM-only ownership/routing;
4. temporary or relationship-specific no-contact;
5. followup false-positive suppression while preserving meetings/interactions;
6. true global ignore/security/privacy blocks.

Without typed scope and precedence, the most restrictive interpretation propagates. Comments/specs then become stale but executable copies remain in skills, cron prompts, and scripts.

## Diagnosis-only correction principles

1. **Typed policy records:** require `subject`, `subject_type`, `effect`, `scope`, `channel`, `reason`, `source`, `created_at`, `expires_at/review_at`, and `owner`. Effects should include `dedupe_entity`, `exclude_lead_sourcing`, `route_crm_only`, `no_contact`, `suppress_followup_candidate`, and `global_ignore`—never bare `suppressed`.
2. **Least restrictive precedence:** preserve raw evidence first. `global_ignore` may stop capture only when explicitly approved. `route_crm_only` must outrank Hunter routing but must not stop CRM/email/meeting capture. `dedupe_entity` must merge/map organization identity, not block people at its domain.
3. **Per-sink decisions:** meeting capture, contact enrichment, interaction logging, followup candidate creation, task/draft surfacing, Hunter sourcing, and outbound contact each evaluate only policies scoped to that sink.
4. **Auditable receipts:** every decision writes a structured receipt: policy ID/version, input identity, normalized match, caller, sink, decision, and whether processing continued. Suppression must not masquerade as exit-0 success without a machine-readable result.
5. **No identity substring hard-nos:** names in free text may generate review candidates, never whole-meeting drops. Exact canonical identity mapping should be used where identity is relevant.
6. **Atomicity with partial policy outcomes:** identity conflicts may fail closed and roll back a meeting; scoped suppression should return a typed per-attendee outcome while preserving unrelated attendees and downstream non-contact artifacts.
7. **Staging fixtures:** include Julie/PTS (same client, valid email capture, no duplicate deal), Marcos/Alloi (CRM-only, valid meeting/commitment/draft, no Hunter routing), RRK (record/project writeback, no lead), Rachel-security (interaction recorded, no Josh followup), and a genuine global-ignore fixture. Assert both positive and negative outcomes at every sink.
8. **Policy lint/reconciliation:** fail CI when an enabled skill/script contains a hard-no contradicted by canonical policy, when a domain block lacks `global_ignore` approval, or when tracker state says a cron is retired while runtime config keeps it enabled.

## Final evidence table

| Rule | Source / provenance | Intended scope | Actual scope | Affected identities/domains | Active? | Severity | Evidence |
|---|---|---|---|---|---|---|---|
| PTS is MSIA | `feedback_pts_is_msia.md:10-14`; repeated duplicate deletion, 2026-06-25 | CRM entity/deal dedupe; never Hunter/new opportunity | Global contact upsert block by domain/ID/name | all `@pts.org`; Hugo, Veronica, Sherie, Gaby IDs/names; Julie as collateral | Yes | Critical | `_ingest_suppression.json:2-18`; `upsert-contact.py:31-55,162-169`; #37581 |
| Julie `julie@pts.org` | No identity-specific rule; inherited PTS domain proxy | Capture email/interaction under existing MSIA client | Email identity rejected; interaction remains | Julie Lurie | Yes | Critical | #37581: explicit `SUPPRESSED`, empty emails, logged interactions |
| Marcos CRM-only | `feedback_marcos_alloi_crm_only.md:10-14` | Exclude Hunter; route CRM questions to CRM | Historically all extraction; still recap whole-meeting and commitment post-filter | Marcos Santa Ana / Alloi | Partly | Critical | `feedback_dont_flatten...:16`; `meeting_recap_draft.py:21,116-126,249-251`; commitment skill `:92-96` |
| Canonical extractor Marcos tuple | Code correction 2026-08-09 | No suppression | No current match (`()`) | none | Dormant | Informational | `pa/scripts/ff-extractor.py:251-254`; #35953-#35959 |
| Meeting recap Marcos name substring | Stale meeting-recap design | Originally stop a reminder | Any attendee/title/context match drops whole draft | whole meeting containing Marcos | Yes, enabled 4h | Critical | `meeting_recap_draft.py:21,116-126,242-251`; cron manifest `:301-303` |
| Commitment Marcos post-filter | Stale “belt-and-suspenders” skill text | Originally stop stale reminder noise | Any item mentioning Marcos never surfaces | all Marcos-related commitments | Yes, enabled 2h | High | skill `:92-96`; frank2 configs `:111-114` / codex `:100-103` |
| Rachel security deliverables | Repeated false-positive corrections | Record meeting/interaction; no Josh-owed followup | Correctly scoped followup suppression | Rachel Gross / JSP security thread | Yes | Low | `fireflies-ingest-method.md:65-79`; commitment skill `:95-96`; interaction receipt |
| Logic-TCG / old-job | CRM ingest guidance and contact tags | No lead/outreach framing; preserve history | Stale-relationship/Hunter exclusion across 41 tagged contacts | listed Logic-TCG ecosystem contacts | Yes | Medium | `scan-stale-relationships.py:14-26,48-66`; current `contacts.json` counts |
| RRK is project, not lead | `feedback_rrk_is_project_not_lead.md:10-14` | Project logging/writeback; no sales pipeline | Lead-source/relationship sweep exclusion | Ariel, Rob, Jaime, Carol, Ashlyn, Amelia / RRK | Yes | Low | memory plus `lead-source:logic-tcg` tags |
| Dulce direct handling | `feedback_dulce_josh_handles_directly.md:10-16` | Do not duplicate Josh's touch; check sent mail | `suppress-from-prospecting` + lost-deal exclusion | Dulce Appiagyei | Yes | Medium | memory; current contact tags |
| `suppress-from-prospecting` | Contact-level tag | Lead-sourcing only | Stale sweep only in audited code, but name invites reuse | 9 current contacts | Yes | Medium | `scan-stale-relationships.py:16,49-57`; current `contacts.json` |
| Atomic attendee preflight | commit `2fb8c535` | All identities resolved on one snapshot; conflicts roll back | Suppressed attendee remains per-attendee; conflict aborts meeting | any attendee batch | No, undeployed | Medium | commit/test; `fable-diagnosis.md:159-164` |
| Meeting classifier `casual/other` | Meeting-chain implementation | Template/routing advisory | Suppresses downstream outcomes | e.g. Marcos Aug 6 meeting | Yes, separate defect | High | `state/live-receipts/...:127-133`; deterministic execution diagnosis |
