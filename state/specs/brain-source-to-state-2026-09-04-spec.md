---
title: Brain source-to-state loop (one meeting, end to end) — Spec
project: cortextos
area: ai
type: spec
status: converged
mode: standard
supersedes: brain-source-to-state-2026-09-04-brief.md
ambiguity_score: n/a — intake clear (settled brief + roast)
repo: /Users/joshweiss/code/cortextos
base-branch: feat/cortextos-backup-dr
mockup: N/A — backend only
claims: state/specs/brain-source-to-state-2026-09-04-claims.json
version: 1.6
date: 2026-09-04
keywords:
  - org-brain
  - fireflies
  - source envelope
  - meeting-writeback
  - claude -p
  - crm interactions
  - bus create-task
  - gmail draft
  - checkpoint protocol
---

# Brain source-to-state loop (one meeting, end to end) — Spec

## 1. Goal

One real Fireflies meeting becomes durable canonical state and the four outputs Josh runs the business on — a sourced History line on exactly one org-brain page, a Gmail recap draft, a CRM interaction row, and bus tasks for his own commitments — plus, once an engagement exists, whatever status artifact the existing engine returns from that state. Every step is a deterministic script except one bounded `claude -p` extraction validated in code. Manual first run, driven from a terminal, with the daemon stopped. The pipeline is source-agnostic from v1 at the envelope, extraction, resolution, and writeback layers; the CRM and recap projections are Fireflies-keyed in v1 (G-59) and gain a `--source-ref` flag when the second source lands. Asked by Josh 2026-09-04 after the Brain recovery audit found the live chain dead at extraction (OpenRouter 401) and never demonstrated end to end.
**Mode:** standard. **Ambiguity:** n/a.

**In scope:** FR-001–FR-014. Acceptance = `fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA` ("Alloi Tacticals Troubleshooting", 2026-09-04): one `--apply`, one repeat `--apply` (short-circuit), one `--apply --force` (zero new writes). Variants A (aliases stripped → rule 3) and B (unknown-domain attendee → `orgs/` creation) run **`--dry-run` only against a copied vault** (D-18). Build phases in §12 — FR-007, FR-011, FR-013 land in phase 3, after the core loop is green.
**Explicitly out of scope:** cron/scheduling; any daemon change; the 13 unpromoted `src/bus/meeting-*.ts`; Chroma/mmrag; wiki; Mission Control; Telegram sends; sending email (drafts only, by design); `create-approval`; CRM follow-up rows (`add-followup`, suppressed in v1); `pipeline.json` mutation; lifecycle projection beyond `bus create-task`; wiring the webhook to this loop (phase G of the plan); changes to `src/`.

**Brief / lineage:** `file:///Users/joshweiss/code/cortextos/state/specs/brain-source-to-state-2026-09-04-brief.md` · Source plan: `knowledge-sync/raw/areas/clearworks/brain-recovery-audit-2026-09-04/00-DELIVERABLES-A-G.md`

## 1b. Decisions (CONTEXT)

| ID | Area | Decision | Provenance | Settled by | Evidence | Locked by | Date |
|----|------|----------|------------|------------|----------|-----------|------|
| D-01 | Source of truth | Canonical Brain = org-brain markdown: `clients/`, new `projects/` (`kind: engagement\|project`, `parent:`), new `orgs/` (`kind: org\|person`, `relationship:`), `meetings/`; `STATE.md` is derived, never authoritative | settled | grill | n/a | Josh | 2026-09-04 |
| D-02 | Meeting home | Every meeting gets exactly one home decided by the system; unknown org → create `orgs/<domain-slug>.md`; `unknown` is illegal in any classification field; no question is ever sent to Josh | settled | grill | n/a | Josh | 2026-09-04 |
| D-03 | Hierarchy | Client → Engagement → Project; projects are not deal-born; Alloi seed = `alloi-01` (engagement, Managed Services), `alloi-02` (engagement, 10-Hour IT Block), `alloi-03` (project, Tactical Reports, `parent: alloi-01`, aliases `tacticals`, `tactical report`, `arch tactical`); coordinator writes the seed, Josh reviews the diff; legacy client History is frozen in place with a marker, not renamed | settled | grill | n/a | Josh | 2026-09-04 |
| D-04 | Code placement | New scripts live at repo level under `scripts/brain/`; never under `orgs/clearworksai/agents/*`; existing agent scripts get additive flags and surgical safety fixes only; `src/` is not changed | settled | grill | n/a | Josh | 2026-09-04 |
| D-05 | Transcript durability | The source envelope and its derived artifacts are committed to the vault at `raw/media/transcripts/<kind>/<id>/`; run state lives in `raw/media/transcripts/_state/<kind>-<id>/` which is gitignored | settled | grill | n/a | Josh | 2026-09-04 |
| D-06 | Extraction runtime | One headless `claude -p --setting-sources "" --disallowedTools "*" --model sonnet --output-format json --max-turns 1` call from `scripts/brain/extract_meeting.py`, run from an empty scratch cwd; no `spawn-worker`, no daemon dependency; output validated in code (`--bare` never reads keychain OAuth and requires ANTHROPIC_API_KEY, which G-29 says does not exist; `--setting-sources ""` skips hooks/plugins/CLAUDE.md while keeping keychain auth — patched 2026-09-05, Josh) | settled | roast | G-27, G-49 | Josh (RESHAPE accepted) | 2026-09-04 |
| D-07 | Scope | Gmail recap draft, CRM interaction row, commitments→bus tasks are IN scope as deterministic projections off the same validated JSON | settled | grill | n/a | Josh | 2026-09-04 |
| D-08 | Evidence rule | Every `decisions[]` item, every `commitments[]` item, and any proposed `delivery_state` change must carry a verbatim quote that is a normalized substring of the source text; otherwise it is dropped and counted, never written. `deal_state`, `meeting_type`, and `classification` are recorded in `resolution.json` and the meeting note only — never written to canonical History, `pipeline.json`, or a page's `relationship:` beyond the rule-5/6/7/8 creation value | settled | grill | n/a | Josh | 2026-09-04 |
| D-09 | Review gate | `--dry-run` prints a human diff (home + rule that chose it, History line, quotes kept/dropped, task list, draft subject) in the terminal and commits nothing; `--apply` writes. Mechanically: `--apply` requires `<envelope>/d09-signed.json` (`signed_by`, `signed_at`, `capture_sha256`) written by the orchestrator's `--sign` step after human review (v1.6). | settled | grill | n/a | Josh | 2026-09-04 |
| D-10 | Branch | Code built in worktree `brain-loop` → PR into `feat/cortextos-backup-dr`; data (vault, runtime tasks, CRM jsonl) is written where it lives today via `--repo-root` / `--vault` (defaults: shared checkout, `~/code/knowledge-sync`) | directive | n/a | n/a | coordinator | 2026-09-04 |
| D-11 | Acceptance case | `fireflies:01M1MW2GAZ1DQ0C6PG3KJ557JA` → client `alloi` → node `alloi-03` via alias (rule 2, corroborated by rule 3); variant A: aliases stripped → `clients/alloi.md`, `node: none`; variant B: `@alloi.us` participants replaced by `sam@newco-fixture.test` → `created: {kind: org, slug: newco-fixture}`; variants are `--dry-run` on a copied vault (D-18) | settled | grill | n/a | Josh | 2026-09-04 |
| D-12 | Task owners | Only Josh / fleet-agent owners become bus tasks (Josh's land on `pa-codex` with `owner: Josh`); client-side owners stay in the recap draft, the History line, and Open Items | settled | roast | n/a | Josh (RESHAPE accepted) | 2026-09-04 |
| D-13 | Free-mail | A free-mail attendee (gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, protonmail.com) is a person Josh wants tracked: never an `orgs/<domain>.md`; always a CRM contact upsert when an email exists, and a `kind: person` page — the meeting files on that person page only when no client/org resolves (rules 5/7) | settled | grill | n/a | Josh | 2026-09-04 |
| D-14 | Receipt | One receipt: the knowledge-sync commit SHA, recorded in `_state/<kind>-<id>/receipt.json` (gitignored) after the commit succeeds, composed from `progress.json` (FR-014). "Nothing to commit" on a repeat or `--force` run is success and keeps the existing `vault_sha`. Runtime task files and the CRM jsonl are not git-tracked in cortextos (G-40, G-41) and are recorded in the receipt, not committed | settled | roast | G-40, G-41 | coordinator | 2026-09-04 |
| D-15 | Writeback safety | `meeting_writeback.py` must never rebuild a page from a heading whitelist; it preserves every existing `##` section verbatim, only prepends History and appends Open Items, writes every file atomically (temp + `os.replace`), and — when driven by a `resolution` — is idempotent on `<kind>:<id>` for every write it makes | settled | roast | G-05, G-43 | Josh (RESHAPE accepted) | 2026-09-04 |
| D-16 | Source envelope | `source.json` is source-agnostic: `{source:{kind,id,url?}, title, occurred_at, duration_s?, participants[{name?,email?,handle?,side,spoke,notetaker}], text_units[{i,speaker,text,ts?}], native_summary?}`; extraction, resolution, and writeback read only the envelope; adding Gmail/Slack/GitHub/calendar = one fetch script each (CRM/recap need `--source-ref` then, G-59) | settled | grill | n/a | Josh | 2026-09-04 |
| D-17 | Commitment side | Each commitment binds to a participant index; OURS ⇔ that participant's `side == ours`; `theirs` and `unknown` are THEIRS. `side: ours` = email domain `clearworks.ai`, or name equal to Josh's roster names, or name equal to an **enabled** fleet agent in `~/.cortextos/cortextos1/config/enabled-agents.json`. The adapter maps side to each consumer's vocabulary (`inbound`/`outbound` for recap; `internal` for fanout) | settled | roast | G-42, G-46 | coordinator | 2026-09-04 |
| D-18 | Fixture isolation | Variants and any negative test run `--dry-run` against `--vault <copy>` prepared by `scripts/brain/make_variant.py` (copies the vault, deletes `_state/` and derived artifacts for the meeting, edits the envelope, recomputes `source.sha256`); nothing in phase 3 or the variants may write to production `contacts.json`, `interactions.jsonl`, the bus, or Gmail | settled | roast | n/a | coordinator | 2026-09-04 |
| D-19 | Force semantics | `--force` bypasses the receipt short-circuit only; it never re-extracts. `extract_meeting.py` never re-extracts an existing `extraction.json` whose `inputSha` matches without `--re-extract`; a `promptSha` mismatch is a warning; `--re-extract` is refused when a receipt exists | settled | roast | n/a | coordinator | 2026-09-04 |
| D-20 | Checkpoint protocol | Every projection step records its outcome in `_state/<kind>-<id>/progress.json` immediately on success; gates read `progress.json`; failed fanout ids go to `fanout-pending.json` and are retried automatically; the receipt is composed from `progress.json` at commit time (FR-014) | settled | roast | n/a | coordinator | 2026-09-04 |

## 1c. Roast verdict

**RESHAPE** · confidence high · 2026-09-04 · mode=code
Biggest risk: resolver closed-set is thin (`org-aliases.json` has 5 rows); the real key is attendee email → `contacts.json` (516 contacts, G-18) whose `company` is a display name (235), null (238), or a domain (43) — G-55.
Cheapest 48-hour test (probe): `meeting-crm-sync.py --event-file --full-file` with the extractor absent still appends a row for the Alloi attendees → ledger claim G-31
Cheapest 48-hour test (demo): the `--dry-run` human diff on the acceptance meeting is signable without edits → D-09 / FR-012
Scores: Constitution 6/10 · YAGNI 8/10 · Contrarian 4/10 · Code-Researcher 5/10 · Operator 7/10
Pivots taken: (1) no `spawn-worker` → D-06 / FR-002; (2) one adapter emitting per-consumer shapes with stable `commitmentId`s → FR-004; (3) whitelist rebuild replaced by section-preserving atomic idempotent writes → D-15 / FR-005; (4) quote rule for decisions + commitments + promotions, participant-bound side, free-mail rule → D-08 / D-17 / D-13 / FR-003 / FR-004; (5) receipt after commit, composed from per-step progress → D-14 / D-20 / FR-014; (6) fixture isolation → D-18.

## 2. Constitution check

| Invariant | How this spec satisfies it |
|---|---|
| No new DB / daemon / agent / queue (brief hard assumption 9) | Everything is files + scripts; the only process spawned is `claude -p` (D-06); run state is two JSON files in a gitignored dir (D-20) |
| No cron in the acceptance path | Orchestrator is invoked by hand; FR-012 asserts it passes with the daemon stopped |
| All bus ops through `src/bus/` | Tasks are created via `cortextos bus create-task` → `src/bus/task.ts` `createTask` (G-12); no direct task-file writes; no change to `src/` (D-04) |
| Atomic writes | TS side only reads (FR-011). Python writes go temp + `os.replace` (FR-001, FR-005, FR-007, FR-014); the client-file RMW keeps its `fcntl` lock (G-06); new CRM rows are a bare append in existing code (G-26 PARTIAL, A-07) |
| No `any`, no `console.log` in committed TS | FR-011's `tsx` entry uses typed imports from `delivery-status.ts` and prints via `process.stdout.write` |
| No new runtime deps beyond `package.json` (G-24) | Schema validation hand-rolled in Python stdlib (FR-003); no `zod`/`ajv`; extraction via the `claude` CLI, not an SDK (G-25, G-29) |
| Scripts never inside agent dirs (D-04) | New code under `scripts/brain/`; existing agent scripts get additive flags + the D-15 safety fix |
| No PII in logs/URLs | `_filed.log` carries title + slug only; transcripts go to the private vault repo (G-35); stdout prints quotes only inside the dry-run Josh asked for (D-09) |
| Every meeting has a home; never ask Josh (D-02) | FR-003 exits non-zero only on technical failure; every branch ends in a page |
| Staging-first for anything that mutates production data | Variants and negative tests are dry-run on a vault copy (D-18); the single production `--apply` is the acceptance meeting, reviewed via dry-run first (D-09) |
| No secrets in git | `orgs/clearworksai/secrets.env` is gitignored (G-56); the key copy is a local edit |

No waivers.

## 3. UI mockup

No UI surface; mockup gate N/A.

## 4. Requirements

### 4a. Data model (the JSON contracts every FR reads)

**`source.json` (envelope, D-16).** `{schema: "brain.source/1", source: {kind: "fireflies", id, url?}, title, occurred_at (ISO), duration_s, participants: [{name?, email?, handle?, side: "ours"|"theirs"|"unknown", spoke: bool, notetaker: bool}], text_units: [{i, speaker, text, ts?}], native_summary: {overview?, action_items?, keywords?, bullet_gist?, short_summary?}}`. `participants` = Fireflies `meeting_attendees` (API order) followed by any sentence speaker not already present (`email: null`, `spoke: true`). `notetaker` = name matches `{Fireflies, Fireflies.ai Notetaker, Otter, Read.ai, Fathom}` (case-insensitive) or email domain ∈ `{fireflies.ai, otter.ai, read.ai, fathom.video}`. `side` is `ours` when the email domain is `clearworks.ai`, or the name is in Josh's roster (`Josh`, `Josh Weiss`, `josh@clearworks.ai`), or the name equals an enabled fleet agent (D-17); `theirs` when a non-notetaker external email is present; `unknown` otherwise. **External participant** = not a notetaker, and (`side == theirs`, or `side == unknown` with `spoke == true`). **File bytes are the hash input:** `source.json` is written as exactly `json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()` and `source.sha256` is the hex sha256 of those bytes; every later reader recomputes the hash over the file bytes. `meta.json` holds `fetched_at` and the fetcher version, outside the hash.

**`extraction.json` (`scripts/brain/extraction.schema.json`).** Required: `schema: "brain.extraction/1"`, `inputSha`, `promptSha`, `model`, `cost_usd`, `extracted_at`, `classification: {org_name, domain (registrable label or null), relationship ∈ {client, prospect, vendor, partner, colleague, personal, internal}, confidence ∈ [0,1], evidence (quote)}`, `summary: {overview, bullets[]}`, `decisions: [{text, quote}]`, `commitments: [{text, owner_participant (int index into participants) | null, owner_name, deadline_iso (YYYY-MM-DD) | null, quote}]`, `proposed_delivery_state: {state, quote} | null`, `deal_state ∈ {none, prospect, proposal, won, lost} | null`, `meeting_type ∈ {sales, delivery, internal, other}`. Unknown keys are rejected. `unknown` is not a legal value for any enum. **Ladder** (`state`): `scoping, active, paused, delivered, accepted, adopted, closed, rolled_back, abandoned`; **open** = `{scoping, active, paused}`; **forward moves** (the only ones v1 applies) = `scoping→active→delivered→accepted→adopted→closed`.

**`validated.json`** (written by FR-003, read by FR-004): the `extraction.json` object with `decisions`, `commitments`, `proposed_delivery_state` replaced by their quote-checked survivors, plus `dropped` counts. FR-004 never reads `extraction.json` directly.

**`resolution.json`.** `{counterparty_slug, kind: client|org|person, relationship, home_path (org-brain-relative), node: <id>|none, created: {kind, slug, relationship}|null, confidence, rule (1–8), corroborated: bool, also_present: [slug], dropped: {decisions: n, commitments: n, promotion: bool, promotion_reason?}, deal_state, meeting_type}`.

**`_state/<kind>-<id>/progress.json`** (FR-014): `{writeback: {done, note, home_path, history_added, open_items_added, promotion_applied}, crm: {done, contacts: [ids], interactions: n}, tasks: {done, created: [{commitmentId, taskId}], pending: [commitmentId]}, draft: {done, subject, created, skipped_ledger}, rollup: {done}, status_update: {done, relPath|null, action}, filed: {done}, commit: {done, vault_sha}}` — each key written atomically the moment its step succeeds.

**`_state/<kind>-<id>/receipt.json`** (FR-014): `{meeting_id, source, extraction_sha, home_path, node, rule, tasks, interactions, contacts, draft, status_update, vault_sha, first_applied_at, last_run_at}` — composed from `progress.json` after the commit; `first_applied_at` is preserved across `--force`.

---

### FR-001 — Durable source envelope fetch (no LLM)

**Requirement:** System MUST fetch one Fireflies transcript by id and persist it as the source envelope in the vault before any extraction runs.

**Acceptance:**
- WHEN `scripts/brain/fetch_fireflies.py --meeting-id <id> [--vault <path>]` runs with `FIREFLIES_API_KEY` in the environment THE SYSTEM SHALL query `transcript(id:)` for `title, date, duration, organizer_email, participants, meeting_attendees{displayName,email}, sentences{index,speaker_name,text,start_time}, summary{…}` and write `<vault>/raw/media/transcripts/fireflies/<id>/source.json` (canonical bytes, §4a), `source.sha256`, `meta.json` via temp + `os.replace`, then exit 0 printing the sha.
- WHEN the response has fewer than 20 `sentences` or `duration` is null THE SYSTEM SHALL exit 2 with `not-ready: sentences=<n>` and write nothing, unless `--allow-short` is given.
- WHEN `source.json` already exists THE SYSTEM SHALL not overwrite it and SHALL exit 0 printing the existing sha; `--refetch` replaces it and prints both shas.
- WHEN the API returns `errors` or no transcript THE SYSTEM SHALL exit 2 with the first error message and write nothing.
- WHEN run THE SYSTEM SHALL make no LLM call and read no `OPENROUTER_API_KEY`.
- WHEN the orchestrator runs THE SYSTEM SHALL obtain `FIREFLIES_API_KEY` from `orgs/clearworksai/secrets.env` (gitignored, G-56) using a `KEY=VALUE` parser with the semantics of `src/utils/env.ts:249` (first `=`, strip quotes, skip comments — G-50); the build copies the key there from `pa-codex/.env` (G-30) and quotes line 45 in the same local edit.

**Bucket:** A — query and fields verified live (G-28, G-54); key location verified (G-30, G-56); no fetch-only path exists (G-08, G-09), so this is new code at repo level (D-04).

**Depends on claims:** G-08, G-09, G-28, G-30, G-50, G-54, G-56

---

### FR-002 — Bounded extraction via headless Claude

**Requirement:** System MUST produce `extraction.json` from the envelope with exactly one short-lived, tool-less `claude -p` call and no daemon involvement, and MUST never re-extract implicitly.

**Acceptance:**
- WHEN `scripts/brain/extract_meeting.py --source <dir>` runs and no `extraction.json` exists THE SYSTEM SHALL write a prompt file embedding `text_units`, `native_summary`, `participants` (with indices), and the schema, then run `claude -p --bare --disallowedTools "*" --model sonnet --output-format json --max-turns 1` (G-49) with `cwd` = a fresh empty temp directory, reading the prompt from stdin.
- WHEN the CLI returns `type: result, subtype: success` THE SYSTEM SHALL take `result`, strip a leading ```` ```json ```` / trailing ```` ``` ```` fence if present, `json.loads` it, add `inputSha` (= recomputed sha of `source.json` bytes), `promptSha` (sha256 of prompt template + schema), `model`, `cost_usd`, `extracted_at`, and write `<dir>/extraction.json` atomically.
- WHEN the CLI exits non-zero, `subtype != success`, or the result is not a JSON object THE SYSTEM SHALL exit 3 with the reason and write nothing.
- WHEN `extraction.json` exists and its `inputSha` equals the recomputed sha THE SYSTEM SHALL skip the call and exit 0, printing `warn: stale-prompt` if `promptSha` differs (D-19); WHEN `inputSha` differs THE SYSTEM SHALL exit 3 `stale-extraction` unless `--re-extract` is given; WHEN `--re-extract` is given and `_state/<kind>-<id>/receipt.json` exists THE SYSTEM SHALL refuse with exit 3.
- WHEN run with the cortextos daemon stopped THE SYSTEM SHALL still succeed.

**Bucket:** A — headless `claude -p` verified with `claude-sonnet-5` (G-27); `--setting-sources ""`/`--disallowedTools` exist (G-49); no API key file exists and none is needed (G-29); `spawn-worker` is daemon IPC and not used (G-20, G-21, G-25).

**Depends on claims:** G-20, G-21, G-25, G-27, G-29, G-49

---

### FR-003 — Validate in code and resolve the home

**Requirement:** System MUST validate `extraction.json` against the schema in code, write the quote-checked survivors to `validated.json`, and resolve exactly one canonical home plus an optional node, without any LLM and without asking a human.

**Acceptance:**
- WHEN `scripts/brain/resolve_meeting.py --source <dir>` runs THE SYSTEM SHALL recompute sha256 of `source.json` bytes and exit 4 if it differs from `source.sha256` or from `extraction.inputSha`, or if `extraction.json` is missing, unparseable, has unknown/missing keys, an illegal enum, or an `owner_participant` index out of range.
- WHEN checking quotes THE SYSTEM SHALL normalize both sides (casefold, collapse whitespace, map curly quotes/dashes to ASCII) and test the quote as a substring of `" ".join(text_units[].text)`; every `decisions[]` item, every `commitments[]` item, and any `proposed_delivery_state` whose quote fails SHALL be dropped and counted in `dropped`; the survivors SHALL be written to `validated.json` — never a non-zero exit for drops.
- WHEN a surviving `proposed_delivery_state` is not a forward move from the node's current `delivery_state` (§4a) THE SYSTEM SHALL drop it with `promotion_reason: non-forward`; WHEN `node` resolves to `none` THE SYSTEM SHALL drop it with `promotion_reason: no-node`.
- WHEN building closed sets THE SYSTEM SHALL skip any page whose stem starts with `_`; client slugs = stems of `clients/*.md`; org/person slugs = stems of `orgs/*.md`; node index from every `projects/*.md` `## Node` block; `domain → slug` from any line matching `^domains:` in any page, from `crm-codex/crm/org-aliases.json` keys containing a dot, and from every `contacts.json` `contacts[].emails[]` entry; `company → slug` from `contacts[].company`: if null → no candidate; if it contains a dot and no space → registrable label; else look the raw string up in the alias table first (keys are display names such as `All Safe IT`, G-32) and only then `slugify(company)` (G-55). **Registrable label** = the label before the public suffix, using an embedded two-part suffix list (`co.uk, org.uk, ac.uk, com.au, net.au, org.au, co.nz, com.br, co.jp, co.in, com.mx`) and otherwise the second-to-last label.
- WHEN resolving THE SYSTEM SHALL first collect **both** client and org candidates over all external participants (never per-participant first-hit), then apply these rules in order and stop at the first that yields a hit: (1) a node id `<slug>-<nn>` present in `title` → that node (and its client); (2) a node `aliases:` entry present in the whitespace-normalized `title` with word boundaries (multi-word aliases allowed), exactly one node hit, **and** that node's client is in the candidate set or the meeting has no external participants (`corroborated: true`); (3) any candidate client from a non-free-mail participant domain (`domain → slug`); (4) any candidate client from `contacts.json` `company` of a participant email; (5) a free-mail participant email found in `contacts.json` → `orgs/<contact id>.md` (`kind: person`), `created: null` if the page exists else `created: {kind: person, slug: <contact id>, relationship: personal}`; (6) a candidate org from rules 3/4 logic applied to `orgs/` → that page; else at least one external non-free-mail domain → `created: {kind: org, slug: <label> (or <label>-<tld> if orgs/<label>.md exists with a different domains: value), relationship: classification.relationship if in {prospect, vendor, partner, personal} else prospect}`; (7) only free-mail or email-less external participants → person page for the first external participant in participants order: slug = `slugify(full name)` when the name has ≥ 2 tokens, else `<name>-<yyyymm>`; `created: null` if the page exists else `created: {kind: person, slug, relationship: personal}`; (8) no external participants → home `orgs/clearworks-internal.md`, `created: {kind: org, slug: clearworks-internal, relationship: internal}` if absent.
- WHEN more than one candidate remains at rule 3/4/6 THE SYSTEM SHALL pick clients before orgs, then most participants, then an open engagement, then alphabetical, and list every other candidate (clients and orgs) in `also_present`.
- WHEN a client resolves THE SYSTEM SHALL set `node` to the rule-1/rule-2 node if any; else, **only if the client has exactly one open node in total**, that node; else `none` (home = client page).
- WHEN it succeeds THE SYSTEM SHALL write `resolution.json` and `validated.json` atomically (confidence 1.0 for rules 1–5 and 8, `classification.confidence` for 6–7) and print `home=<path> node=<id|none> rule=<n>`.
- WHEN run on the acceptance meeting with the D-03 seed THE SYSTEM SHALL print `home=projects/alloi-03.md node=alloi-03 rule=2`; on variant A `home=clients/alloi.md node=none rule=3`; on variant B `home=orgs/newco-fixture.md node=none rule=6` with `created.kind = org`.
- WHEN `participants` is empty AND `text_units` is empty THE SYSTEM SHALL exit 5 (`unresolved-technical`) — the only non-parse failure path.

**Bucket:** A — closed sets exist (G-18, G-32, G-55); `projects/` and `orgs/` are created by FR-006 (G-16, G-17); stdlib-only (G-24). The resolver never creates files (D-09); FR-005 creates.

**Depends on claims:** G-16, G-17, G-18, G-24, G-32, G-55

---

### FR-004 — One adapter, per-consumer shapes

**Requirement:** System MUST derive every downstream input from `validated.json` + `resolution.json` in one deterministic step so no consumer shells the legacy extractor and each consumer receives exactly the vocabulary it understands.

**Acceptance:**
- WHEN `scripts/brain/adapt_meeting.py --source <dir>` runs THE SYSTEM SHALL read `validated.json` (never `extraction.json`) and write atomically: `writeback-payload.json` (`{"meetings":[{id, source: {kind, id}, title, date, organizer, attendees: [<email or name strings>], client_context, summary{overview,bullets,action_items}, decisions[], next_steps[…], meeting_type, commitment_ids[], resolution: {home_path, node, rule, created, relationship, confidence}, promotion: {state, quote}|null, open_items: [{item, owner, deadline, source, status}]}]}`), `recap-payload.json` (same object; `next_steps[].direction` = `inbound` for THEIRS, `outbound` for OURS, G-42; `attendees` = flat strings, G-36), `event.json` (`{meeting_id, client, meeting_type: "delivery", attendees: [<email strings>] — emailed non-notetaker externals only, flat strings because crm-sync parses `attendees` as strings and would upsert a name-only contact for anything that is not an email (G-61), commitmentIds[], writeback_ok: false}` — `meeting_type` fixed so crm-sync never touches `pipeline.json`, G-31), and `fanout-meeting.json` (`{"mode":"full","meetings":[{…, next_steps: OURS only with `direction: "internal"`, `owner_identity`, `owner_label`, `deadline`}]}` so fanout's `client_facing` is false, G-46).
- `source` carries the envelope's `source.kind`/`source.id` so writeback derives its idempotency key `<kind>:<id>` without a per-source literal (D-16; v1.6)
- WHEN a commitment is emitted THE SYSTEM SHALL set `commitmentId = sha1(source.kind + ":" + source.id + "|" + normalize(text) + "|" + ordinal)[:16]` where `ordinal` is the 0-based index among commitments sharing the same normalized text.
- WHEN deciding OURS/THEIRS THE SYSTEM SHALL read `participants[owner_participant].side`: `ours` → OURS; `theirs` or `unknown` → THEIRS; `null` index → THEIRS unless `owner_name` equals a Josh roster name exactly (D-17).
- WHEN an OURS owner is Josh THE SYSTEM SHALL set `owner_identity: pa-codex`, `owner_label: "owner: Josh"`; WHEN the owner is an enabled fleet agent THE SYSTEM SHALL set `owner_identity` to that exact enabled name and `owner_label: "owner: <name>"`; WHEN the owner is any other `side: ours` participant THE SYSTEM SHALL set `owner_identity: pa-codex`, `owner_label: "owner: <name>"`; every `owner_identity` SHALL match `^[a-z0-9_-]+$` or the adapter exits 12.
- WHEN `deadline_iso` is null, unparseable, earlier than **tomorrow** (relative to the run date; date-only due dates become 23:59:59Z, G-44), or later than 364 days out THE SYSTEM SHALL emit `deadline: null` (fanout then omits `--due`) and note ` · due none` in the description it composes.
- WHEN `open_items` is built THE SYSTEM SHALL include one row per surviving commitment, OURS and THEIRS alike (`owner` = participant name, `source` = `commitment:<commitmentId>`, `status: open`), so `## Waiting on` in FR-007 is populated; tasks remain OURS-only.
- WHEN run twice on the same calendar day with unchanged inputs THE SYSTEM SHALL produce byte-identical outputs.

**Bucket:** A — consumer key sets verified (G-06, G-36, G-31, G-33, G-42, G-46, G-55); the shapes differ (`client` vs `client_context`, `meeting_id` vs `id`, `inbound` vs `outbound`, flat vs object attendees), which is why the adapter exists.

**Depends on claims:** G-06, G-07, G-26, G-31, G-33, G-36, G-42, G-44, G-46, G-55, G-61

---

### FR-005 — Canonical write: section-preserving, atomic, idempotent, resolution-driven

**Requirement:** System MUST write the meeting note and prepend one sourced History line to exactly one home page (creating it from a template when `created` is set), preserving every existing section, writing atomically, idempotent on `<kind>:<id>` for every write in resolution mode, and printing a human diff on dry-run.

**Acceptance:**
- WHEN `meeting_writeback.py --payload <writeback-payload.json> --dry-run` runs with `ORG_ROOT` and `LEDGER_FILE` set by the orchestrator (G-43) THE SYSTEM SHALL print, for every file it would create or change, a unified diff, plus one reason line `home=<path> node=<id|none> rule=<n> created=<kind:slug|none> promotion=<state|none>`, and SHALL write nothing (no meeting file, no ledger row, no event file).
- WHEN `--apply` runs with a `resolution` in the payload THE SYSTEM SHALL write `org-brain/meetings/<YYYY-MM-DD>-<slug>-<kind>-<id[:8]>.md` (id-based name) with frontmatter `meeting_id`, `source: <kind>:<id>`, `client`, `date`, `node`, `counterparty`, `rule`, `deal_state`, `meeting_type`, then, under the existing `fcntl` lock on the target page, prepend to `## History (dated, newest first)` one block `- <date> — <topic> (meeting: <rel>) [source: <kind>:<id>]` with `Outcomes:` (summary) and `Decisions:` (quoted items only) sub-lines, and append one row per `open_items` entry to `## Open Items` (`| <item> | <owner> | <deadline|—> | commitment:<id> | open |`); the ledger row is `<kind>:<id>`.
- WHEN the payload carries `resolution.home_path` THE SYSTEM SHALL write History/Open Items to that file only — `projects/<node>.md` when `node != none`, else the resolved `clients/` or `orgs/` page — and SHALL NOT modify `last_update:` anywhere; WHEN the payload carries no `resolution` THE SYSTEM SHALL behave exactly as today (legacy filenames, `meeting_rel` dedupe, bare-id ledger, `guess_client_file`; existing 8 tests stay green, G-22, G-43).
- WHEN the target page contains any `##` section other than the ones being updated THE SYSTEM SHALL preserve it byte-for-byte and in place (regression for the whitelist rebuild at `meeting_writeback.py:472-502`, G-05); a page with no `## History (dated, newest first)` gets the heading appended at the end.
- WHEN `resolution.created` is set THE SYSTEM SHALL exit 7 if the target page already exists, else create `org-brain/orgs/<slug>.md` from `orgs/_template.md` with `kind`, `relationship`, `created_from: <kind>:<id>`, `confidence`, `domains:` (org) or `emails:` (person), and file the History line there; it SHALL touch no file under `clients/` or `projects/`.
- WHEN `promotion` is non-null THE SYSTEM SHALL change the node's `delivery_state:` only together with the dated History line carrying the quote, and only if the History does not already contain `[source: <kind>:<id>]`.
- WHEN the History of the target page already contains `[source: <kind>:<id>]` THE SYSTEM SHALL skip the History prepend and the Open Items append; WHEN the meeting note already exists THE SYSTEM SHALL not rewrite it; WHEN the ledger already contains `<kind>:<id>` THE SYSTEM SHALL not append; the event file is written only when absent (fixes G-43 in resolution mode so a re-run is a no-op for this step).
- WHEN writing any file THE SYSTEM SHALL write to a temp file in the same directory and `os.replace` it (D-15).

**Bucket:** B — existing script and lock reused (G-06); replace the whitelist rebuild (`:472`, G-05) with parse-all-sections + targeted update; add `--dry-run`/`--apply` (both new; absent both → legacy apply, G-43), resolution-driven targeting, template creation, Open Items rows, id-keyed idempotency, atomic writes; existing tests CONTROL (G-22).

**Depends on claims:** G-05, G-06, G-14, G-15, G-22, G-43

---

### FR-006 — Seed templates and the Alloi nodes; freeze legacy History in place

**Requirement:** System MUST have `projects/_template.md`, `orgs/_template.md`, and the three Alloi node files before the acceptance run, without breaking any existing reader of `clients/alloi.md`.

**Acceptance:**
- WHEN the vault is inspected after seeding THE SYSTEM SHALL contain `projects/alloi-01.md` (`kind: engagement`, `title: Managed Services`, `## Reporting` with `cadence: weekly`, `channel: email`, `contact: marcos@alloi.us`, `last_update:` blank), `projects/alloi-02.md` (`kind: engagement`, `title: 10-Hour IT Block`), `projects/alloi-03.md` (`kind: project`, `parent: alloi-01`, `title: Tactical Reports`, `aliases: tacticals, tactical report, arch tactical`, `delivery_state: active`), each opening with `# Client: Alloi — <title>` then a `## Node` block (`id, kind, client, parent, title, aliases, domains, deal_id, delivery_state, opened, closed`) followed by `## Reporting`, `## Current state`, `## What we're delivering`, `## History (dated, newest first)`, `## Open Items`.
- WHEN `projects/_template.md` is inspected THE SYSTEM SHALL contain the same section skeleton with placeholder values (`id: <client>-<nn>`, `kind: engagement|project`, …); all loaders skip `_`-prefixed stems, so its placeholders are never parsed.
- WHEN `resolve_meeting.py` loads the closed sets THE SYSTEM SHALL parse every non-underscore `projects/*.md` `## Node` block without error.
- WHEN `clients/alloi.md` is inspected THE SYSTEM SHALL keep its `## History (dated, newest first)` heading unchanged with a first line `<!-- frozen: entries below this marker are the pre-2026-09 client roll-up; new entries go above -->` inserted directly under the heading, and a `domains: alloi.us` line under `## Contacts`.
- WHEN `orgs/_template.md` is inspected THE SYSTEM SHALL contain `# <Name>`, a header block (`kind, relationship, created_from, confidence, domains, emails`), `## Contacts`, `## Current state`, `## History (dated, newest first)`, `## Open Items`.

**Bucket:** C — new directories, templates, and a `## Node` metadata contract under the existing markdown convention, hand-seeded, no migration (G-14, G-16, G-17); reviewed by Josh via diff (D-03).

**Depends on claims:** G-14, G-15, G-16, G-17

---

### FR-007 — Deterministic derived views (phase 3)

**Requirement:** System MUST regenerate a client's engagement roll-up block and a generated region of `STATE.md` from canonical files with no LLM, idempotently, touching only clients that have nodes.

**Acceptance:**
- WHEN `scripts/brain/brain_rollup.py --client <slug>` runs THE SYSTEM SHALL rewrite only the region between `<!-- generated: engagements-rollup -->` and `<!-- /generated -->` in `clients/<slug>.md` (creating it directly under `## Current state` if absent) with a table engagement → projects → `delivery_state` → `last_update`; `--all` does this for every non-underscore client that has at least one node and nothing for the rest.
- WHEN it runs THE SYSTEM SHALL rewrite only the region between `<!-- generated: state -->` and `<!-- /generated -->` **at the end of** `STATE.md` (appended if absent; earlier sections untouched because the legacy `ff-extractor.py:570` reads them, G-47) with `generated-from: <sha256 of the concatenated canonical inputs>` and sections `## Active work` (open nodes, projects nested under their engagement, newest History line each), `## Waiting on` (Open Items with `status: open` whose owner is not Josh/fleet), `## Decisions made` (`Decisions:` sub-lines from History, trailing 30 days), `## Next priorities` (Open Items with `status: open` whose owner is Josh/fleet, by deadline, `OVERDUE` first).
- WHEN run twice with no canonical change THE SYSTEM SHALL produce zero diff on the second run.
- WHEN a `## Node` block is malformed THE SYSTEM SHALL exit 6 naming the file and change nothing.

**Bucket:** A — pure file transform; `STATE.md`'s legacy reader is unaffected by an appended region (G-47).

**Depends on claims:** G-15, G-16, G-47

---

### FR-008 — Gmail recap draft (existing script, adapter-fed, dry-run added)

**Requirement:** System MUST create one Gmail draft for the meeting from the adapter's recap payload using the existing recap script, and MUST be able to preview it without side effects.

**Acceptance:**
- WHEN `meeting_recap_draft.py --payload <recap-payload.json> --ledger <vault>/raw/media/transcripts/_recap-ledger.txt --dry-run` runs THE SYSTEM SHALL print the subject and body it would draft and SHALL call no `gws` and append no ledger row (new additive flag).
- WHEN run without `--dry-run` THE SYSTEM SHALL call `gws gmail +draft --to josh@clearworks.ai --subject <subject> --body <body>` once (routes to `gws-dwd` via `uv run`, G-39) and print a plan JSON with `drafts_created == 1`; the ledger key is `<kind>:<id>` (the script's existing bare-id key is used only in legacy mode).
- WHEN the ledger already lists `<kind>:<id>` THE SYSTEM SHALL create no draft and report `skipped_ledger == 1`.
- WHEN `gws` exits non-zero THE SYSTEM SHALL report `draft_failures[0]` with the stderr line; the orchestrator SHALL treat a non-empty `draft_failures` as failure of this step with exit 9 (the script itself exits 0, G-48).
- WHEN THEIRS commitments exist THE SYSTEM SHALL render them as `inbound` next steps (their owner named) and OURS as `outbound` (G-42); the draft is addressed to Josh by design (drafts are unsent; Josh forwards) — changing `--to` is a follow-up (§11).

**Bucket:** B — `+draft` shim, routing, and service-account key present (G-07, G-19, G-34, G-39); payload keys match G-36; one additive `--dry-run` flag and a `<kind>:<id>` ledger key when the payload carries `resolution`.

**Depends on claims:** G-07, G-19, G-34, G-36, G-39, G-42, G-48

---

### FR-009 — CRM interaction row (existing script, `--full-file` seam, progress-gated)

**Requirement:** System MUST upsert contacts and append one interaction per emailed external contact to `interactions.jsonl` from the adapter outputs without shelling the legacy extractor, and MUST not run again once recorded in `progress.json`.

**Acceptance:**
- WHEN `meeting-crm-sync.py --event-file <event.json> --full-file <fanout-meeting.json>` runs THE SYSTEM SHALL read the file in `load_full_meeting` instead of spawning `ff-extractor.py` (assert via `_run` argv capture in a new unit test); WHEN `--full-file` is omitted THE SYSTEM SHALL behave exactly as today (existing 11 tests stay green, G-31).
- WHEN an emailed external attendee is not yet in `contacts.json` THE SYSTEM SHALL upsert a contact (`upsert_contacts`, tagged `fireflies-attendee`, `--match-email`, G-37) — free-mail attendees included — and append the interaction to that contact; email-less participants are never upserted (they are absent from `event.json.attendees`, FR-004); a failed upsert is logged and skipped.
- WHEN it runs THE SYSTEM SHALL append rows with `source_ref: fireflies:<id>` (the script hardcodes the `fireflies:` prefix, G-59) to `orgs/clearworksai/agents/crm/crm/interactions.jsonl` (G-41).
- WHEN `progress.json` has `crm.done: true` THE SYSTEM (orchestrator) SHALL skip this step (a repeat run can rewrite an existing row and clear its `decisions`, G-51), on `--apply` and `--apply --force` alike.
- WHEN `event.json` lists no attendees THE SYSTEM SHALL write no contacts and no interactions and exit 0 (existing early return, G-31); the orchestrator records `interactions: 0`.
- WHEN `event.json` carries `meeting_type: delivery` THE SYSTEM SHALL not touch `pipeline.json` (G-31).

**Bucket:** B — `--full-file` is a new additive flag; the only seam today is `_run` (G-31); upsert + append already exist (G-37, G-26 PARTIAL: new rows are a bare append, A-07).

**Depends on claims:** G-01, G-26, G-31, G-37, G-41, G-51, G-59

---

### FR-010 — Commitments → bus tasks (existing fanout, `--full-file`, `--no-telegram`, `--no-followups`, `--retry-commitment`, strict)

**Requirement:** System MUST create one bus task per OURS commitment with owner and (when valid) due date, idempotently, without Telegram, approvals, CRM follow-up rows, or external POSTs, and MUST fail loudly — naming every failed commitment — when a task or a dedup check does not succeed.

**Acceptance:**
- WHEN `meeting-fanout.py --meeting-id <id> --event-file <event.json> --full-file <fanout-meeting.json> --no-telegram --no-followups --strict` runs THE SYSTEM SHALL build `Deps` with `load_full` reading the file, `send_telegram` and `add_followup` no-ops (G-57), and SHALL call `cortextos bus create-task <text[:117]…> --assignee <owner_identity> --desc "<owner_label> · From meeting <kind>:<id> · <full text> · due <deadline|none>" [--due <YYYY-MM-DD>]` once per surfaced commitment (fanout composes `desc` itself today, G-62; in `--full-file` mode it reads `owner_label` and the full `text` from the meeting object), and SHALL print `task_map: [{commitmentId, taskId}]` in its result JSON (today only a flat `tasks[]` exists, G-62) so the orchestrator can record per-commitment ids.
- WHEN `--strict` is set and `event-dedup` returns empty output (command failure, G-58) THE SYSTEM SHALL treat it as a failure of that commitment, not as "already surfaced".
- WHEN `--strict` is set and `create_task` returns an empty id, or the dedup check failed, THE SYSTEM SHALL continue with the remaining commitments, then exit 8 printing one line per failed id `pending: <commitmentId>`; the orchestrator writes them to `_state/<kind>-<id>/fanout-pending.json` (FR-014).
- WHEN `--retry-commitment <id>` is given (repeatable) THE SYSTEM SHALL skip `dedup_surface` for those ids only (G-52: no check-only CLI exists) and attempt the sinks.
- WHEN run a second time without pending ids THE SYSTEM SHALL create zero tasks (`bus event-dedup --fire-once`, G-04) because FR-004's ids are stable.
- WHEN the dry-run task list is needed THE SYSTEM (orchestrator) SHALL render it from `fanout-meeting.json` minus ids already in `progress.tasks.created`; fanout is not invoked in dry-run.
- WHEN a commitment has no owner THE SYSTEM SHALL assign `FANOUT_TRIAGE_OWNER`, which the orchestrator sets to `pa-codex` (G-03) — unreachable in practice, kept for safety.
- WHEN `BRIEFS_INGEST_URL` is unset THE SYSTEM SHALL skip the briefs POST (G-33); the orchestrator SHALL unset it explicitly.
- WHEN `fanout-meeting.json` carries only OURS commitments with `direction: internal` THE SYSTEM SHALL invoke no `create-approval` (G-46).
- WHEN Multica is configured for the org THE SYSTEM MAY trigger the existing best-effort outbound mirror on task creation (G-45; A-05).
- WHEN run with the daemon stopped THE SYSTEM SHALL still create task files under `~/.cortextos/cortextos1/orgs/clearworksai/tasks/` (G-12, G-40).

**Bucket:** B — additive `--full-file`, `--no-telegram`, `--no-followups`, `--retry-commitment`, `--strict` flags on `main()` (G-33); `Deps` seam exists (G-02); strict-failure change at `:280-305` and `:443-446`; `task_map` and `owner_label` are additive fields on `FanoutResult`/`Commitment` (G-62); no change to `src/` (G-52); all 20 fanout tests inject `Deps` and are CONTROL (J-03).

**Depends on claims:** G-02, G-03, G-04, G-12, G-13, G-33, G-38, G-40, G-44, G-45, G-46, G-52, G-57, G-58, G-62

---

### FR-011 — Status artifact from canonical state (phase 3)

**Requirement:** System MUST feed an engagement's node files to the existing status engine unchanged, persist whatever plan it returns, and record the send date.

**Acceptance:**
- WHEN `npx tsx scripts/brain/status_plan.ts --client <slug> --node <engagement-id> --today <date> [--write]` runs THE SYSTEM SHALL read `projects/<id>.md` and every `projects/*.md` with `parent: <id>`, compose a synthetic client markdown (`# Client: <client> — <title>`, the engagement's `## Reporting`, a merged `## History (dated, newest first)` of engagement + children newest-first, merged `## Open Items`), and call `buildStatusReportPlan` with `slug: <client slug>` (the engine uses `slug` in artifact paths, G-53) and that markdown — no engine change.
- WHEN the plan's `action` is `draft` or `brief` and `--write` is given THE SYSTEM SHALL persist `fileContent` to `<vault>/<relPath>` atomically, set `last_update: <today>` in the engagement's `## Reporting` (atomic rewrite of that line only), and print `wrote: <relPath>`; WHEN `action` is `skip` THE SYSTEM SHALL print `skip: <reason>` and exit 0.
- WHEN the orchestrator resolves the engagement THE SYSTEM SHALL use `node`'s parent when `node` is a project, `node` itself when it is an engagement, and skip FR-011 with `skip: no-engagement` otherwise.
- WHEN `progress.json` has `status_update.done: true` THE SYSTEM SHALL skip (so `--force` on a later day creates no dated duplicate).
- WHEN the node is not `kind: engagement` or has no `## Reporting` block THE SYSTEM SHALL print `skip: <reason>` and exit 0.

**Bucket:** A — engine exported and tested (G-10, G-11); its parsers accept the synthetic markdown and its date filter is `> last_update` (G-53); the removed CLI (G-23) is replaced by a repo-level `tsx` entry (D-04); zero changes to `delivery-status.ts`.

**Depends on claims:** G-10, G-11, G-23, G-53

---

### FR-012 — Orchestrator sequencing, dry-run gate, exit codes, restart proof

**Requirement:** System MUST run the loop from one command with a dry-run gate, sequence the steps through the checkpoint protocol (FR-014), and pass with the daemon stopped.

**Acceptance:**
- WHEN `scripts/brain/run_meeting.py --meeting-id <id> --dry-run [--repo-root <cortextos checkout>] [--vault <path>]` runs THE SYSTEM SHALL execute FR-001 (writes only under the envelope dir, uncommitted), FR-002, FR-003, FR-004 for real, then FR-005 `--dry-run` and FR-008 `--dry-run`, render the task list from `fanout-meeting.json` minus `progress.tasks.created`, and print: the resolution reason line, the page diff, quotes kept/dropped counts, the task list (title · owner · due), the draft subject, the recap draft recipient list (`to:` / `cc:` from the recap payload attendees), the CRM interaction row exactly as `--apply` would write it, and each bus task payload (title, owner_identity, owner_label, due, description) (v1.6 — Josh D-09 review 2026-09-05); it SHALL commit nothing and call no `gws`, `bus`, or crm script.
- WHEN `--apply` runs THE SYSTEM SHALL run the worker guard: `timeout 5 cortextos list-workers`; a listed `meeting-writeback-<id>` with status `running` → exit 13 `worker-active`; non-zero exit or timeout (daemon down, G-60) → print `workers: daemon down, skipped` and continue.
- WHEN `--apply` runs and `receipt.json` has `vault_sha` and `--force` is absent THE SYSTEM SHALL print `already applied: <vault_sha>` and exit 0.
- WHEN `--apply` proceeds THE SYSTEM SHALL re-run FR-001–FR-004 (idempotent; no LLM call when `extraction.json` exists), then FR-005 `--apply` → FR-009 → FR-010 → FR-008 → (phase 3) FR-007 → FR-011 → FR-013 → commit (FR-014), each step gated and recorded per FR-014.
- WHEN any step exits non-zero THE SYSTEM SHALL stop, print `FAILED at <step>: <reason>`, exit with that step's code — FR-001: 2, FR-002: 3, FR-003: 4/5, FR-005: 7, FR-010: 8, FR-008: 9, commit: 10, FR-009: 11, FR-004: 12, worker guard: 13, FR-011: 14, FR-007: 6, sign-check: 15 — and leave already-written files and `progress.json` in place; a re-run continues from the first step whose `progress` key is not `done`.
- WHEN `--apply` runs and `<envelope>/d09-signed.json` is absent or does not name `signed_by` and `signed_at` THE SYSTEM SHALL print `FAILED at sign-check: d09-signed.json missing` and exit 15 before any write; there is no flag that bypasses this check (D-09; v1.6).
- WHEN `--apply --force` runs after a successful apply THE SYSTEM SHALL create zero new tasks, drafts, rows, History lines, or `_filed.log` lines; `receipt.json` SHALL differ only in `last_run_at`; and `git -C <vault> status --porcelain -- <the FR-014 pathspec>` SHALL be empty.
- WHEN the cortextos daemon is not running THE SYSTEM SHALL complete `--apply` (no step uses IPC: G-20, G-12, G-60).
- WHEN `cortextos restart` follows an `--apply` THE SYSTEM SHALL still satisfy: recomputed sha256 of `source.json` equals `source.sha256`, the History line is present with its citation, `receipt.json` has `vault_sha`, and no new `interactions.jsonl` row or task appears for this meeting.
- WHEN the acceptance meeting is applied THE SYSTEM SHALL satisfy minimums: ≥ 1 quoted decision kept, ≥ 1 OURS task created, ≥ 5 CRM contacts in the receipt (6 emailed external attendees, G-54), 1 draft created.

**Bucket:** A — sequencing over FR-001..011 and FR-014; every gate is a file read (G-40, G-41, G-60).

**Depends on claims:** G-12, G-20, G-21, G-35, G-40, G-41, G-54, G-60

---

### FR-013 — Filed-meeting digest line (phase 3)

**Requirement:** System MUST record one human-readable line per first filing where the morning brief can read it, instead of asking Josh anything.

**Acceptance:**
- WHEN `--apply` files a meeting for the first time THE SYSTEM SHALL append `<date> filed "<title>" under <home-slug>[ → <node>] (rule <n>, conf <c>)[ NEW <relationship> <slug>] <kind>:<id>` to `org-brain/_filed.log`; WHEN the log already contains `<kind>:<id>` THE SYSTEM SHALL append nothing.
- WHEN a page was created THE SYSTEM SHALL include the `NEW <relationship> <slug>` suffix.
- WHEN run THE SYSTEM SHALL send no Telegram and create no question packet; the phase-G morning-brief change that reads `_filed.log` is out of scope here.

**Bucket:** A — append-only text file inside the receipt commit.

**Depends on claims:** G-15

---

### FR-014 — Checkpoint protocol: progress, pending retries, receipt after commit

**Requirement:** System MUST make every projection step resumable and every repeat run a no-op by recording per-step outcomes the moment they succeed, retrying failed fanout ids automatically, and composing one receipt only after the vault commit succeeds.

**Acceptance:**
- WHEN the orchestrator starts a meeting THE SYSTEM SHALL ensure `<vault>/raw/media/transcripts/_state/` is listed in the vault's `.gitignore` (added by the build) and create `_state/<kind>-<id>/` with an empty `progress.json` if absent.
- WHEN a step succeeds THE SYSTEM SHALL atomically merge its outcome into `progress.json` (§4a) before the next step starts: FR-005 → `writeback`, FR-009 → `crm`, FR-010 → `tasks.created` (from fanout's `task_map`, G-62) and `tasks.pending`, FR-008 → `draft`, FR-007 → `rollup`, FR-011 → `status_update`, FR-013 → `filed`.
- WHEN a step has `done: true` in `progress.json` THE SYSTEM SHALL skip it on every later run (`--apply` or `--apply --force`); `--force` only bypasses the receipt short-circuit (D-19).
- WHEN FR-010 exits 8 THE SYSTEM SHALL write the failed ids to `fanout-pending.json`, mark `tasks.done: false`, and on the next `--apply` re-invoke FR-010 with `--retry-commitment <id>` for each pending id; on success it clears the file and sets `tasks.done: true`.
- WHEN all steps are done THE SYSTEM SHALL run `git -C <vault> add -- <pathspec>` where pathspec = `raw/media/transcripts/<kind>/<id>` (envelope + derived artifacts, no `_state`), `raw/media/transcripts/_recap-ledger.txt`, `raw/media/transcripts/_writeback-ledger.txt` (the `LEDGER_FILE` the orchestrator sets), `raw/areas/clearworks/org-brain/meetings/<note>`, `raw/areas/clearworks/org-brain/<home_path>`, and when they exist `raw/areas/clearworks/org-brain/clients/<slug>.md`, `raw/areas/clearworks/org-brain/projects/<engagement>.md` (FR-011's `last_update`), `raw/areas/clearworks/org-brain/STATE.md`, `raw/areas/clearworks/org-brain/_filed.log`, `<status artifact relPath>`; then `git commit -m "brain: <home-slug>[/<node>] <date> from <kind>:<id>"`.
- WHEN the commit succeeds THE SYSTEM SHALL set `progress.commit = {done: true, vault_sha}` and write `receipt.json` composed from `progress.json` (§4a), preserving `first_applied_at` from any existing receipt, then print `receipt: <vault_sha>` as the last line.
- WHEN `git commit` reports nothing to commit THE SYSTEM SHALL treat it as success, keep the existing `vault_sha` (from `progress.commit` or the prior receipt), and print `receipt: <vault_sha> (unchanged)`; WHEN the commit fails for any other reason THE SYSTEM SHALL exit 10 `FAILED at commit: <git stderr line>` and leave `progress.json` intact so the re-run retries only the commit.
- WHEN `make_variant.py --meeting-id <id> --vault <copy> --variant A|B` runs THE SYSTEM SHALL copy the production vault, delete `_state/<kind>-<id>/` and every derived artifact for that meeting, apply the variant edit to the envelope (A: strip `aliases:` from `projects/alloi-03.md`; B: replace `@alloi.us` participants with `sam@newco-fixture.test`), rewrite `source.json` in canonical bytes, recompute `source.sha256`, and exit 0 (D-18).

**Bucket:** A — two JSON files and a git pathspec in new repo-level code; no new capability (G-35, G-40, G-41).

**Depends on claims:** G-35, G-40, G-41, G-51, G-52

## 5. API contracts

| Method | Path | Auth | Verified status | Response shape | Probe evidence |
|--------|------|------|-----------------|----------------|----------------|
| POST | `https://api.fireflies.ai/graphql` (`transcript(id:)` query — read-only) | `Authorization: Bearer $FIREFLIES_API_KEY` | 200 | `{data:{transcript:{id,title,date,duration,organizer_email,participants[],meeting_attendees[{displayName,email}],sentences[{index,speaker_name,text,start_time}],summary{overview,action_items,keywords,bullet_gist,short_summary}}}}` | G-28, G-54 |

### `POST /graphql` — detail

- **Request:** JSON `{query}` with the field list above; no variables.
- **Errors:** `errors[]` in body with HTTP 200; `data.transcript` null for unknown id.
- **Rate limit:** none observed in three calls; not relied on.
- **Pagination:** none; 863 sentences returned at once for a 65-minute meeting (25 KB of text).
- **Fields relied on:** `sentences[].text` (quote check), `meeting_attendees[].email` (resolution; 7 entries with emails for the acceptance meeting, G-54), `duration`/`sentences` length (readiness guard), `summary.*` (prompt hint only).

Local CLIs invoked (not HTTP): `claude -p` (G-27, G-49), `gws gmail +draft` (G-19, G-39), `cortextos bus create-task` / `event-dedup` / `list-workers` (G-12, G-13, G-52, G-60).

## 6. MCP tool contracts

None. The loop calls no MCP tool.

## 7. Grounding Ledger

| ID | Claim | Probe | Evidence | Verdict |
|----|-------|-------|----------|---------|
| G-01 | `meeting-crm-sync.py --event-file` still calls `load_full_meeting` → `ff-extractor --mode full` unconditionally | `sed -n 140,173p; 388,446p orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py` | `:399 full_meeting = load_full_meeting(resolved_id)`; `:153 _run(["python3", FF_EXTRACTOR, "--mode","full",…])` | VERIFIED |
| G-02 | `meeting-fanout.py` has a `Deps.load_full` seam; `prod_load_full` shells `ff-extractor --mode full` | `sed -n 68,85p; 363,380p orgs/clearworksai/agents/crm/crm/meeting-fanout.py` | `:73 load_full: Callable[[str], dict]`; `:375 return {"mode":"full","meetings":[]}` on failure | VERIFIED |
| G-03 | `meeting-fanout.py` `TRIAGE_OWNER` defaults to `pa` (a disabled agent); overridable via `FANOUT_TRIAGE_OWNER` | run-probes `code_contains` + `sed -n 63p` | match at `meeting-fanout.py:63` | VERIFIED |
| G-04 | fanout dedups on `commitment:<commitmentId>` via `bus event-dedup --fire-once` | run-probes `code_contains` + `sed -n 280,288p` | `:17`, `:281 source_key = f"commitment:{c.commitment_id}"`, `:282 deps.dedup_surface(source_key)` | VERIFIED |
| G-05 | `meeting_writeback.py` rebuilds the client file from a fixed six-heading whitelist and drops any other `##` section | `sed -n 440,505p orgs/clearworksai/agents/pa/scripts/meeting_writeback.py` | `:472 rebuilt = [ title, "## Contacts", …, "## Open Items" …]; client_path.write_text("\n".join(rebuilt))` — no other sections carried | VERIFIED |
| G-06 | `meeting_writeback.py` accepts `--payload` JSON, holds an `fcntl` lock per client file, prepends History, dedupes History on `meeting_rel` | run-probes + `sed -n 40,60p; 452,467p` | `:18 --payload`; `:40 client_file_lock`; `:466 if meeting_rel not in "\n".join(history_lines)` | VERIFIED |
| G-07 | `meeting_recap_draft.py` shells `gws gmail +draft` with `--to josh@clearworks.ai` hardcoded | run-probes + J-05b | match at `meeting_recap_draft.py:209`; `:210-211 "--to","josh@clearworks.ai"` | VERIFIED |
| G-08 | every `ff-extractor.py` mode calls `require_env("OPENROUTER_API_KEY")` | run-probes `code_contains` | match at `ff-extractor.py:1875` (also `:2182`, `:2255`) | VERIFIED |
| G-09 | `ff-extractor.py` has no fetch-only mode | run-probes `code_contains` expect=false | no match for `fetch-only` or `fetch_only` | VERIFIED |
| G-10 | `delivery-status.ts` exports `buildStatusReportPlan` and `parseClientFile`; `buildStatusReportPlan` always calls `parseClientFile`, whose title regex expects `# Client:`; `BuildPlanInput` has no node/state input; the plan may be `draft`, `brief`, or `skip` | Codex r1/r2 + `sed -n 262p; 474p; 490p; 501,515p` | title regex `:262`; unconditional call `:490`; `:109`, `:501`, `:515` action variants | VERIFIED |
| G-11 | `tests/unit/bus/delivery-status.test.ts` exists with 13 `it()` blocks; its guard checks only exact `send` keys and unsafe autosend variants | `grep -c "it(" tests/unit/bus/delivery-status.test.ts`; `sed -n 185,195p` | 13; `:189-193` asserts no `"send"` key / `autosend` | VERIFIED |
| G-12 | `bus create-task` writes the task file directly on disk under a file lock; no IPC | run-probes + J-04 | `src/bus/task.ts:819 atomicWriteSync(join(paths.taskDir, …))`; grep for `ipc` and `socket` = 0 hits | VERIFIED |
| G-13 | `bus event-dedup` command exists in `bus.ts` | `grep -n "command('event-dedup'" src/cli/bus.ts` | defined at `src/cli/bus.ts:4105` (the `:72` hit is an import) | VERIFIED |
| G-14 | `org-brain/clients/_template.md` exists | run-probes `file_exists` | exists via `orgs/clearworksai/knowledge` symlink | VERIFIED |
| G-15 | `org-brain/clients/alloi.md` exists | run-probes `file_exists` | exists | VERIFIED |
| G-16 | `org-brain/projects/` does not exist yet | run-probes `file_exists` expect=false | missing | VERIFIED |
| G-17 | `org-brain/orgs/` does not exist yet | run-probes `file_exists` expect=false | missing | VERIFIED |
| G-18 | `crm-codex/crm/contacts.json` contains `@alloi.us` contacts; the Alloi contact's `company` is the domain string `"alloi.us"`, not a display name | run-probes + Codex r1 `contacts.json:6106` | match at `:6109`; `company: "alloi.us"` at `:6106` | VERIFIED |
| G-19 | `~/.local/bin/gws-dwd` supports `gmail +draft --to --subject --body [--from]` | run-probes + `sed -n 8p; 256p` | `:8 usage line`; `:256 elif subcommand == "+draft"` | VERIFIED |
| G-20 | `cortextos spawn-worker` is daemon IPC; the CLI returns on enqueue with no exit code | run-probes + `sed -n 16,30p src/cli/workers.ts` | `IPCClient` send `{type:'spawn-worker'}`; result "spawning" | VERIFIED |
| G-21 | `dispatchMeetingConsumers` runs only from daemon `onDone` for `meeting-writeback-*` workers | run-probes + `sed -n 1569,1590p src/daemon/agent-manager.ts` | `maybeEmitMeetingEvent` → `dispatchMeetingConsumers` in `onDone` | VERIFIED |
| G-22 | `test_meeting_writeback.py` exists; 8 tests, none pins the whitelist rebuild | run-probes + J-03 | all 8 classified CONTROL; rebuild `:472-502` unpinned | VERIFIED |
| G-23 | `delivery-status-plan` command is absent from `bus.ts` | run-probes `code_contains` expect=false | no match | VERIFIED |
| G-24 | `package.json` has no `zod`/`ajv` runtime dependency | run-probes `code_contains` expect=false | no match | VERIFIED |
| G-25 | `knowledge-base/venv` has no `anthropic` SDK (system pythons do, but no key exists — G-29 — so the CLI is the path) | run-probes `file_exists` expect=false; `python3 -c "import anthropic"` on 3 interpreters | venv: missing; `/usr/bin/python3` 0.102.0, `/opt/homebrew/bin/python3` 0.96.0 | VERIFIED |
| G-26 | `add-interaction.py` selects `ROOT/interactions.jsonl` (`CRM_INTERACTIONS_PATH` override); rewrites of existing rows are atomic, but a NEW interaction is a bare append (not atomic); dedups on `source_ref` + `contact_id` | Codex r2/r3 + `sed -n 26,40p; 70,98p; 115,116p` | path `:26-28`; atomic replace `:31-40` for rewrites; `:115-116` bare append for new rows; dedup `:70-98` | PARTIAL |
| G-27 | Headless `claude -p --model sonnet --output-format json --max-turns 1` works on this machine and returns `{type:result, subtype:success, result, total_cost_usd, modelUsage}` | `claude -p 'Reply with exactly: {"ok":true}' --model sonnet --output-format json --max-turns 1` (cwd `/tmp`) | `type: result, subtype: success, result: {"ok":true}, cost_usd: 0.165, model: ['claude-sonnet-5']`; Claude Code 2.1.261 | VERIFIED |
| G-28 | Fireflies `transcript(id:)` returns `sentences[]` and `summary{overview,action_items,keywords,bullet_gist,short_summary}` for the acceptance meeting | read-only GraphQL POST for `01M1MW2GAZ1DQ0C6PG3KJ557JA` | `sentences: 863`, speakers `Ivette Ramos, Joseph Chang, Josh Weiss, Molly`, 25,180 chars; all five summary keys present; `errors: None` | VERIFIED |
| G-29 | No `ANTHROPIC_API_KEY` exists in any repo/org/agent env file; Claude Code auth is what `claude -p` uses | scoped grep of `.env`, `orgs/clearworksai/.env`, `secrets.env`, `pa-codex/.env`, `maven-codex/.env`, `~/.cortextos/secrets/*` | zero files contain `ANTHROPIC_API_KEY=`; G-27 succeeded without it | VERIFIED |
| G-30 | `FIREFLIES_API_KEY` is set in `orgs/clearworksai/agents/pa-codex/.env` (also `pa/.env`, `crm-codex/.env`); not in `orgs/clearworksai/secrets.env` | scoped grep by name | three agent files contain the key name; org file does not | VERIFIED |
| G-31 | On extractor failure `load_full_meeting` returns `{}` and `append_interactions` still runs with degraded fields — only when the event payload supplies external attendees; with none, `process()` returns before `append_interactions`; `sync_deal_stage` touches `pipeline.json` only when `meeting_type == sales`; `meeting_type: delivery` returns before any pipeline writer; the only injection seam is module-level `_run`; the CRM-sync suite has 11 `def test_` | J-01 + Codex r1/r3 | `:402 deal_state = … or None`; `:428 if not attendees: … return`; `:438 append_interactions(...)`; `:328-338 sync_deal_stage`; `:104 def _run`; 11 tests | VERIFIED |
| G-32 | `crm-codex/crm/org-aliases.json` exists with 5 alias→org rows; values are display strings, keys include domains (e.g. `msia.org`) | scout `python3 -c json.load` | 5 keys, e.g. `"msia.org"` → `"Movement of Spiritual Awareness Internationale (MSIA)"` | VERIFIED |
| G-33 | `meeting-fanout.py main()` has no flag to supply a full-meeting file and always uses `production_deps()`; sinks are create-task, create-approval (client_facing only), briefs POST (degrades without env), add-followup (deadline only), one batched Telegram; `_run` swallows sink failure and `main()` returns 0 | J-02 + Codex r1 | `:492 --meeting-id required`; `:516 deps=production_deps()`; `:344 deps.send_telegram(...)`; `:355`, `:510` | VERIFIED |
| G-34 | A Google service-account key for gws exists locally | `ls ~/.config/gws/` | `cortextos-gws-495505-*.json`, `client_secret.json`, `sa_token_cache.json` present | VERIFIED |
| G-35 | `knowledge-sync` origin is a private GitHub repo | `gh repo view clearworks-ai/knowledge-sync --json visibility` | `PRIVATE` | VERIFIED |
| G-36 | `meeting_recap_draft.py` reads `id,title,date,organizer,attendees[] (strings),summary{overview,bullets,action_items},next_steps[{text,owner,direction}],client_context,sourceRef` under `{"meetings":[…]}` | J-05a `sed -n 80,126p; 155,200p` + Codex r3 `:80-89` | `:181-183 step.get("direction"/"owner"/"text")`; `:195 sourceRef or id`; attendees joined as strings | VERIFIED |
| G-37 | `meeting-crm-sync.py` `upsert_contacts` creates a CRM contact for every external attendee not yet known (`upsert-contact.py --type person --tag fireflies-attendee --match-email`) before `append_interactions`; a failed upsert is logged and skipped; name-only attendees get `--id slugify(name)` with no email | `sed -n 221,256p orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py` | `:221 def upsert_contacts(attendees, source_ref)`; argv `--id slugify(name) --name --type person --tag fireflies-attendee --source-ref … [--email --match-email]`; `if res.returncode != 0: _log(...); continue` | VERIFIED |
| G-38 | fanout `--dry-run` calls `dedup_surface` (which fires `event-dedup --fire-once`) BEFORE checking `dry_run`, so a dry-run consumes the once-only mark; `_run` swallows `create-task` failure at `:355-360` | `sed -n 278,292p; 355,360p meeting-fanout.py` | `:281-285 if not deps.dedup_surface(source_key): … continue` precedes `:287 if dry_run: continue`; `:355 _run` returns on failure without raising | VERIFIED |
| G-39 | `~/.local/bin/gws gmail …` always execs `gws-dwd` via `uv run --with cryptography` unless `GWS_USE_OAUTH=1` | `sed -n 23,33p ~/.local/bin/gws` | `:32 if [[ "$FIRST_ARG" == "gmail" && -x "$GWS_DWD" && "${GWS_USE_OAUTH:-0}" != "1" ]]; then exec uv run --with cryptography "$GWS_DWD" "$@"` | VERIFIED |
| G-40 | Bus task files live under `~/.cortextos/<instance>/orgs/<org>/tasks/`, not in the repo | `sed -n 24,34p src/utils/paths.ts` | `const ctxRoot = join(homedir(), '.cortextos', instanceId)` → org-scoped `tasks/` | VERIFIED |
| G-41 | `orgs/clearworksai/agents/crm-codex/crm` is a symlink to `../crm/crm`; there is one `interactions.jsonl` (1,087 rows, last ts 2026-09-04); `orgs/` is gitignored with a `!orgs/` negation and `git` refuses paths through the symlink | `readlink`, `wc -l`, `git check-ignore -v`, `.gitignore:10-14` | `crm-codex/crm -> ../crm/crm`; `fatal: pathspec … is beyond a symbolic link`; `.gitignore: orgs/` then `!orgs/` | VERIFIED |
| G-42 | `meeting_recap_draft.py` treats only `direction == "inbound"` as the other side's step; every other value (incl. `outbound`) renders as Josh's | Codex r1/r2 `meeting_recap_draft.py:175` | `build_next_steps` branches on `"inbound"` only | VERIFIED |
| G-43 | `meeting_writeback.py main()` unconditionally requires `ORG_ROOT` and `LEDGER_FILE`; its History dedupe does not prevent rewriting the meeting file, appending the ledger, or rewriting the event file; its writes use bare `write_text`; the CLI has only `--payload`; today's filenames are date/client/topic and the ledger holds bare meeting ids | `sed -n 374,390p; 449p; 460,467p; 502,504p; 554,574p` + Codex r3 | `:554 add_argument("--payload")` only; `:374-390` filename; `:504` ledger bare id; `meeting_path.write_text`, `client_path.write_text` | VERIFIED |
| G-44 | fanout truncates task titles to 120 chars; the CLI converts a date-only `--due` to `23:59:59Z` and `createTask` rejects due dates more than 1 hour past or 365 days future (inclusive bounds); explicit assignees are persisted verbatim and only validated (`[a-z0-9_-]+`) by the later notification path when they differ from the caller | Codex r1/r2 `meeting-fanout.py:293`, `bus.ts:306`, `task.ts:166`, `:741-760`, `:789`, `message.ts:62` | `task_title = c.text[:117] + "..."`; `Invalid due_date … more than 1 hour in the past`; assignee written before notify | VERIFIED |
| G-45 | `bus create-task` triggers a best-effort, never-throwing Multica outbound mirror when `resolveMulticaConfig()` is non-null | `sed -n 18,30p src/bus/multica/trigger.ts` | `if (resolveMulticaConfig() === null) return;` — direction out only | VERIFIED |
| G-46 | fanout derives `client_facing` solely from `direction == "outbound"` (given a client-facing meeting), accepts `internal`, creates the task, and does not create an approval for it | `sed -n 129,141p; 158p; 304p meeting-fanout.py` + Codex r2 | `:136 return meeting_client_facing and _s(direction).lower() == "outbound"`; `:158`, `:304` | VERIFIED |
| G-47 | `STATE.md` has one code reader: `ff-extractor.py:570` reads its first Active-work / Next-priorities line into extraction context; that reader is still invoked by the legacy crm-sync/fanout paths when `--full-file` is omitted | Codex r1/r2 | `ff-extractor.py:570`; `meeting-crm-sync.py:144`; `meeting-fanout.py:363` | VERIFIED |
| G-48 | `meeting_recap_draft.py` records `draft_failures` in its plan JSON but always exits 0; it appends the ledger after a successful draft | Codex r1/r3 `:50-53`, `:272-276`, `:278`, `:298` | returns 0 after processing regardless of failures; ledger append `:272-276` | VERIFIED |
| G-49 | `claude -p` supports `--setting-sources "" ` (skip user/project/local settings) and `--bare` (API-key-only auth; unusable on OAuth machines) and `--disallowedTools <tools...>` | `claude -p --help` | `--bare  Minimal mode: skip hooks, LSP, plugin`; `--disallowedTools, --disallowed-tools <tools...>` | VERIFIED |
| G-50 | The repo already has a non-shell env-file parser (first `=`, strips quotes, skips comments) at `src/utils/env.ts:249` whose semantics FR-001 mirrors in Python | Codex r2 | `env.ts:249` | VERIFIED |
| G-51 | Re-running `meeting-crm-sync.py` for a meeting passes no `decisions`; `add-interaction.py` treats that as `[]` and can rewrite an existing row, clearing attached decisions | Codex r2/r3 `meeting-crm-sync.py:255-277`, `add-interaction.py:90-98` | dedupe hit path rewrites the row | VERIFIED |
| G-52 | `bus event-dedup` only checks-and-records (`--fire-once`); rollback exists in `src/utils/event-dedup.ts:128-133` but is not CLI-exposed; no check-only mode; fanout can bypass `dedup_surface` per id without touching `src/` | Codex r2/r3 `bus.ts:4105`, `event-dedup.ts:91,128,133`, `meeting-fanout.py:280-305` | no peek path; per-id bypass feasible in fanout | VERIFIED |
| G-53 | `parseClientFile`/`parseReporting`/`parseHistory`/`parseOpenItems` accept a synthetic `# Client: …` markdown; `Current state` is not parsed and Open Items are not passed into `gatherSinceLastUpdate`; the engine keeps only History strictly after `last_update`; `BuildPlanInput.slug` is used directly in artifact paths | Codex r2/r3 `delivery-status.ts:188,202,226,261,277,474-482,517-553` | parsers accept; `:277` date filter; `:517-553` slug in paths | VERIFIED |
| G-54 | The acceptance meeting's `meeting_attendees` has 7 entries, all with emails: `josh@clearworks.ai` + `marcos, michelle, joe, cindy, ivette, molly @alloi.us` → 6 emailed external attendees | read-only GraphQL POST (`title date duration organizer_email participants meeting_attendees{displayName email}`) | `participants: [marcos@alloi.us, michelle@alloi.us, josh@clearworks.ai, joe@alloi.us, cindy@alloi.us, ivette@alloi.us, molly@alloi.us]` | VERIFIED |
| G-55 | `contacts.json` = `{contacts:[…]}`; each contact has `id, name, company, emails[] (list), aliases, category, …`; `company` is a display name for 235, null for 238, a domain for 43; 10 contacts carry `@alloi.us` emails with `company` ∈ {`alloi.us`, `Alloi`, null} (one null at `:21008-21012`) — so rule 4 must tolerate null and rule 3 (domain) is the reliable Alloi path | `python3 -c json.load` over `crm-codex/crm/contacts.json` + Codex r4 | keys list; `company kinds: {'name': 235, 'null': 238, 'domain': 43}`; `alloi contacts: 10`, one with `company: null` | VERIFIED |
| G-56 | `orgs/clearworksai/secrets.env` is untracked and gitignored | `git ls-files orgs/clearworksai/secrets.env`; `git check-ignore -v` | 0 tracked; `.gitignore:17 orgs/clearworksai/*` matches | VERIFIED |
| G-57 | fanout sink 3 creates a CRM follow-up row (`deps.add_followup`) for every commitment with a deadline | `sed -n 330,342p meeting-fanout.py` | `:333 if c.deadline: followup_id = deps.add_followup(...)` | VERIFIED |
| G-58 | `prod_dedup_surface` treats empty `event-dedup` output (command failure) as "already surfaced" (returns False) — indistinguishable from a real duplicate | `sed -n 441,447p meeting-fanout.py` | `out = _run([...]); return out.upper().startswith("SURFACE")` | VERIFIED |
| G-59 | `meeting-crm-sync.py` hardcodes the `fireflies:<id>` prefix for `source_ref` and the summary; `event.json` carries no `source` field the script would read | Codex r3 `meeting-crm-sync.py:376-385,407-409` | `source_ref = f"fireflies:{resolved_id}"` | VERIFIED |
| G-61 | `meeting-crm-sync.py` `external_attendees` reads `attendees` as flat strings (`str(v)`), treats email-shaped entries as contacts with email and any other string as a name-only contact (upserted by name); objects would become dict-shaped names with empty email | `sed -n 179,208p meeting-crm-sync.py` + Codex r4 `:229-243` | `raw.extend(str(v).strip() …)`; `if _is_email(entry): … else: people.append({"name": entry, "email": ""})` | VERIFIED |
| G-62 | fanout composes the task `desc` itself (`From meeting <id> · due …`) and reports `tasks: [taskId]` with no per-commitment mapping (`FanoutResult.surfaced[]` and `tasks[]` are separate; a failed creation omits its entry) | `sed -n 226,248p; 294,303p; 518,522p meeting-fanout.py` | `desc=f"From meeting {meeting_id}" + …`; `if task_id: result.tasks.append(task_id)`; `print(json.dumps(result.as_dict()))` | VERIFIED |
| G-60 | `cortextos list-workers` exists, is registered, prints worker name + status, and is an IPC round-trip that requires the daemon — so FR-012 treats a non-zero exit or timeout as "daemon down, guard skipped" | Codex r3/r4 `src/cli/index.ts:61-63`, `src/cli/workers.ts:64-92`, `src/daemon/ipc-server.ts:711-713` | `case 'list-workers': response = { success: true, data: this.agentManager.listWorkers() }`; IPC client call; exit code non-zero when no daemon socket | VERIFIED |

Probed against: local checkout `/Users/joshweiss/code/cortextos` @ `feat/cortextos-backup-dr` (HEAD `07d660c8`), vault `~/code/knowledge-sync`, live Fireflies API (read-only), local `claude` 2.1.261 — 2026-09-04.

## 8. Feasibility summary

| Bucket | FRs | Meaning |
|---|---|---|
| A — buildable now | FR-001, FR-002, FR-003, FR-004, FR-007, FR-011, FR-012, FR-013, FR-014 | All claims verified; new repo-level scripts; FR-011 composes markdown for the unchanged engine; FR-014 is two JSON files + a git pathspec |
| B — needs work in existing code | FR-005 (replace whitelist rebuild `meeting_writeback.py:472-502`, resolution mode with `--dry-run`/`--apply`, id-keyed idempotency, atomic writes, Open Items rows), FR-008 (`--dry-run`, `<kind>:<id>` ledger key), FR-009 (`--full-file`), FR-010 (`--full-file`, `--no-telegram`, `--no-followups`, `--retry-commitment`, `--strict`) | Additive flags + two safety fixes; all existing tests classified CONTROL; no `src/` change |
| C — needs new schema/data | FR-006 | New `projects/`, `orgs/`, two templates, `## Node` contract, three seed files — hand-written under the existing markdown convention, no migration |
| D — needs a capability we lack | — | none |

## 9. Accepted assumptions

| ID | Assumption | Why unprobed | Owner | Settles when |
|----|-----------|--------------|-------|--------------|
| A-01 | Committing client transcripts (`source.json`) to the private `knowledge-sync` repo is acceptable | Policy, not code; vault already stores `raw/media/transcripts/` | Josh | Josh objects, or a client contract forbids it |
| A-02 | One `claude -p` extraction per meeting costs ≈ $0.3–1.5 (25 KB transcript + schema, `--setting-sources ""`, empty cwd) | Only a trivial call was measured (G-27: $0.17 with a loaded cwd) | Josh | First real extraction prints `cost_usd`; first real extraction 2026-09-05: $0.34–0.36 per meeting, receipt claude-sonnet-5 |
| A-03 | Fireflies `summary.*` is a hint to the extractor; nothing from it is written without a quote-checked item or the `Outcomes:` summary label | Design rule enforced by FR-003; `Outcomes:` is explicitly a summary | coordinator | FR-003 `dropped` counts on the first run |
| A-04 | The `@alloi.us` contacts map to slug `alloi` through the domain-label rule (`company` = `"alloi.us"`) or `slugify("Alloi")` (G-55) | Both company forms observed; alias table has no Alloi row | coordinator | FR-003 variant A prints `rule=3` |
| A-05 | Multica outbound mirror firing on `create-task` (when configured) is acceptable internal tooling, not an external side effect this loop must suppress | `resolveMulticaConfig()` source not read (G-45) | Josh | Build reads the config resolver; if it is env-based the orchestrator unsets it |
| A-06 | A crash between `gws` draft success and the ledger append can duplicate a draft on re-run (rare, low); a crash between `create-task` success and the progress write is recovered by `--retry-commitment` creating a second task at worst | Ordering inside existing scripts | coordinator | Never observed; accepted |
| A-07 | The bare-append path for new `interactions.jsonl` rows (G-26 PARTIAL) is safe because this loop is the only writer during a manual run and rows are ≤ 1 KB | Existing code; fixing it means editing `add-interaction.py` beyond an additive flag | coordinator | A torn row is ever observed; then fix the append to temp+replace |

## 10. Non-functional requirements

- **Runtime:** `--dry-run` under 4 minutes for a 65-minute meeting; `--apply` adds under 60 s. Measured, not gated.
- **Cost:** one `claude -p` call per meeting (A-02); zero other metered calls.
- **Idempotency:** every step is gated by `progress.json` (FR-014); the orchestrator short-circuits on `receipt.json` with `vault_sha` (FR-012).
- **Failure visibility:** every non-zero exit carries a one-line reason on stderr and the step name; exit-code table in FR-012; the orchestrator inspects script JSON where the script itself exits 0 (G-48, G-38); `--strict` makes fanout name every failed id.
- **Privacy:** transcripts only in the private vault (G-35); `_filed.log` carries title + slug, no emails.
- **Isolation:** code in worktree `brain-loop` (D-10); data written via `--repo-root`/`--vault`; variants on a vault copy (D-18); vault commits use the FR-014 pathspec, never `-A`; no `git checkout/reset/clean` in the shared checkout.

## 11. Open follow-ups

- `orgs/clearworksai/secrets.env:45` (`API_KEY_21ST=op://…` unquoted) breaks `bash source` consumers such as `bus/kb-query.sh`; FR-001's parser sidesteps it, and the build quotes the line locally (file is gitignored, G-56).
- `knowledge-sync` remote URL embeds a GitHub PAT in plaintext; move to the credential helper.
- `meeting-consumer-dispatch.ts` still fires the legacy `--meeting-id` consumers whenever a webhook-spawned `meeting-writeback-*` worker finishes; phase G replaces that path with `run_meeting.py`.
- `TRIAGE_OWNER` default `pa` in `meeting-fanout.py:63` should become `pa-codex` in code, not just via env.
- `bus event-dedup` should grow `--check` and `--release` modes so fanout can order dedup after sink success; out of scope here (no `src/` change, D-04).
- `meeting-crm-sync.py` and `meeting_recap_draft.py` need a `--source-ref <kind>:<id>` flag before a non-Fireflies source is projected (G-59).
- `meeting_recap_draft.py` drafts to Josh only; a `--to <external attendees>` mode (unsent draft) is the next step once Josh wants it.
- `add-interaction.py` new-row append is not atomic (G-26, A-07).
- CRM follow-up rows (`add-followup`) are suppressed in v1 (`--no-followups`); decide whether the Brain's Open Items or CRM follow-ups own that fact before re-enabling.

## 12. Handoff notes

**For `/goalify`:** phases — (1) FR-006 seed + FR-001..004 + `--dry-run` on the acceptance meeting (production vault, no writes outside the envelope dir; vault `.gitignore` gains `raw/media/transcripts/_state/`); (2) FR-005/009/010/008/012/014 `--apply`, restart proof, repeat `--apply` (short-circuit), `--apply --force` (zero new writes), acceptance minimums; (3) FR-007/011/013 on the same meeting + variants A and B via `make_variant.py` + `--dry-run` on the vault copy (D-18). Staging gate per phase = `receipt.json` with `vault_sha` + `git status --porcelain -- <FR-014 pathspec>` empty on the repeat run. Load the `claude-api` skill before writing FR-002's prompt/model code.
**For `planify`:** Global Constraints verbatim — no `spawn-worker`; no cron; no new deps; no `src/` change; new code only under `scripts/brain/`; existing agent scripts get additive flags + the D-15 fix; every write temp + `os.replace`; `claude -p --bare --disallowedTools "*" --model sonnet --output-format json --max-turns 1` from an empty cwd is the only LLM call; never re-extract without `--re-extract`; `unknown` illegal; quotes normalized-substring of `text_units` for decisions, commitments, promotions; forward-only promotions; side by participant index; only OURS become tasks; Josh's tasks → `pa-codex`; deadline floor tomorrow; envelope schema `brain.source/1`; `source.json` bytes = canonical dump; loaders skip `_` stems; variants dry-run only; progress-gated steps; receipt after commit.
**For plan mode:** start from §4a + §4 + §7.

## Changelog
- **2026-09-04** — v1.0. Mode=standard. Roast RESHAPE. Probed 37 claims (37 VERIFIED). Round 1 dispatched (Codex + Fable).
- **2026-09-04** — v1.1. Round 1 merged: Codex (4 ledger corrections, 21 unrecorded assumptions, 3 bucket corrections) + Fable (3 CRITICAL, 13 HIGH, 14 MEDIUM, 8 LOW). Ledger 48 rows. FRs covered: FR-001–FR-013.
- **2026-09-04** — v1.2. Round 2 merged: Codex (4 citation fixes, 9 unrecorded assumptions, 3 bucket corrections) + Fable (2 CRITICAL, 12 HIGH, 17 MEDIUM, 9 LOW). Ledger 53 rows. FRs covered: FR-001–FR-013.
- **2026-09-04** — v1.3. Round 3 merged: Codex (G-26 → PARTIAL, 12 unrecorded assumptions, FR-012 → C as written) + Fable (2 CRITICAL, 13 HIGH, 11 MEDIUM, 1 LOW). Both reviewers independently named FR-012's checkpoint semantics as the non-converging part; per the 3-round rule the spec was **decomposed**: FR-012 keeps sequencing/exit codes, new **FR-014** owns the checkpoint protocol (`_state/` gitignored dir, `progress.json` per-step markers, `fanout-pending.json` auto-retry, receipt composed after commit, "nothing to commit" = success, `make_variant.py`). Other fixes: `validated.json` between FR-003 and FR-004; `source.json` bytes are the hash input; never re-extract implicitly (D-19); notetaker exclusion by name/domain; `unknown` side → THEIRS; `owner_label` separate from title; rule 5/7 exists-guards and FR-005 exit 7 on create-over-existing; full-name person slugs with `<name>-<yyyymm>` fallback; email-less participants never upserted; `_` stems skipped and `projects/_template.md` specified; daemon-down worker guard (G-60); FR-011 sets `last_update` on write and passes the client slug (G-53); forward-only promotions; Open Items source `commitment:<id>`; rule 3 collects both candidate kinds; ledgers in the commit pathspec; contacts `company` branches (G-55); `--no-followups` (G-57); `--strict` dedup failure (G-58); CRM Fireflies-only `source_ref` noted (G-59); acceptance minimum 5 contacts grounded (G-54). Ledger 60 rows. FRs covered by round 3: FR-001–FR-013.
- **2026-09-04** — v1.4. Round 4 (Codex-only, scoped to FR-003/004/005/009/010/011/012/014 — a documented deviation from the 3-round cap, approved by Josh 2026-09-04 22:53 PDT as option A): G-55 corrected (null `company` case), G-60 citation refreshed, alias lookup ordered before `slugify` (FR-003), `event.json.attendees` flattened to email strings (FR-004, G-61), fanout `task_map` + `owner_label` fields (FR-010/FR-014, G-62); every other scoped row VERIFIED-CORRECT. Ledger 62 rows (61 VERIFIED, 1 PARTIAL owned by A-07, 0 FALSE, 0 UNVERIFIABLE). FRs covered by round 4: FR-001–FR-014.
- **2026-09-05** — v1.6 patch. FR-004 writeback payload gains `source{kind,id}` (D-16 idempotency key, G0 C2-2). FR-012 dry-run nouns extended with recap recipients, CRM interaction row, bus task payloads (Josh D-09 review). FR-012 adds `sign-check: 15` and the no-bypass d09-signed gate (D-09). Approved by Josh 2026-09-05.
- **2026-09-05** — v1.5 patch. D-06 runtime flag: --bare → --setting-sources "" (bare is API-key-only; no key exists per G-29). G-49 and A-02 updated. Josh approved 2026-09-05 at D-09 sign-off.
- **2026-09-04** — Converged with zero CRITICAL/HIGH: round 4 returned only grounded corrections, each fixed and re-probed in v1.4.
