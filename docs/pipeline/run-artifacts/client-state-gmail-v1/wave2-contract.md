# G0 round-1 fix wave — shared contract (BINDING for every writer)

Read before editing your section. These decisions resolve the cross-section findings
from G0a (opus, empirical: applied all 23 tasks, ran every Step 2/4 — artifact
docs/pipeline/run-artifacts/client-state-gmail-v1/G0-review-opus.json + .md) and G0b
(codex: G0b-codex-last.json). Every writer edits ONLY their own part file(s) under
scratchpad/plan-parts/ and must re-extract + re-run their code (py_compile + pytest of
their own test files against the REAL sibling modules extracted from the other parts —
`python3 scratchpad/g0-compile.py scratchpad/plan-assembled.md <dest>` materialises every
labelled block; the assembled plan is re-built by the orchestrator, so materialise from
the current parts yourself if you need siblings: concatenate skeleton + parts in order
01,02,03,04,05,06,07,08,09 first).

## C1. FakeRunner (Task 1, `scripts/brain/tests/helpers_client_state.py`)
`FakeRunner(responses)` accepts EITHER a list of `(argv_prefix_tuple, CompletedProcess)`
pairs OR a dict `{argv_prefix_tuple: CompletedProcess}` (first matching prefix wins, in
insertion order). `.calls` is a `list[list[str]]` of argv lists (bare lists, no dicts).
Unmatched argv → `CompletedProcess(argv, 127, "", "FakeRunner: no response for ...")`.
Also exposes `.record(prefix, rc=0, stdout="", stderr="")` convenience. Every test in
every task uses THIS class — no local look-alikes.

## C2. sys.path (Task 1)
Add `scripts/brain/tests/conftest.py` inserting `scripts/brain` and `scripts/brain/tests`
into `sys.path` (tests dir is a package via `__init__.py`, so a bare
`import helpers_client_state` fails without it). Test files may keep their own inserts.
Task 22's docstring claim "no conftest" is corrected.

## C3. Resolution.outcome
Values: `"pending"` (transient — resolver output, never persisted), `"filed"`,
`"escalated"`, `"ignored"`. The Interfaces block is updated by the orchestrator.
`resolve_message` returns one Resolution PER KNOWN COUNTERPARTY (contact-level rows;
several rows may share a slug — do NOT dedupe by slug). Page bindings = distinct slugs
across rows; CRM rows = per contact_id. Sender gates (ignored sender ⇒ single ignored row).

## C4. Ledger API changes (Task 1)
- `open_email_tasks() -> list[dict]` with `{"id","title","source_ref"}` REPLACES
  `open_email_task_titles()`; writes entries are `"task:<id>|<title>"`.
- `record_failure(state_dir, error: str, **partial) -> None` (Task 3): writes the receipt
  with `error`, `failed_at`, any partial fields (message_count, cost_usd, truncation),
  and PRESERVES the previous `last_success_at`. `write_receipt` is the success path.
- `escalated_for(source_ref, digest)` stays; consumed by the orchestrator (C7).

## C5. gmail_source (Task 5)
`sweep(runner, days, today, extra_query: str | None = None)` composes
`<extra_query> <date operators> <EXCLUSION_QUERY>` into the full-window query AND every
per-day query; the 50-cap day-sweep applies on the `--query` path too. The orchestrator
never calls `list_messages` directly for the backfill path.
`read_hostile.json` is owned by Task 5 in gws `+read` payload shape ONLY. Task 11 builds
its hostile `Message` through `gmail_source.parse_message(json.load(...))`.

## C6. Projections module (Task 15, NEW `scripts/brain/client_state_projections.py`)
Pure functions, no I/O, no subprocess; the ONLY source for every preview AND every live
write/send. Both dry-run and live call these, then a `do_*` executes the result:
- `plan_history_entry(row_or_parts...) -> HistoryEntry` (uses writeback_email.render_history_entry)
- `plan_add_interaction_argv(crm_dir, contact_id, msg, extraction) -> list[str]`
- `plan_upsert_contact_argv(crm_dir, from_name, from_email) -> list[str]`
- `plan_task_create_argv(plan: TaskPlan) -> list[str]`
- `plan_escalation(msg, resolutions) -> str` (text sent via `cortextos bus send-telegram <TELEGRAM_CHAT_ID> <text>`, chat id `6690120787` imported from meeting_loop_watch constants or duplicated as `TELEGRAM_CHAT_ID`; any dedup key ever written carries the `clientstate:` prefix — none is written in v1: gating = `ledger.escalated_for`)
- `plan_digest_line(row: ObservationRow) -> list[str]` (per-write lines INCLUDING the extraction summary; used by client_state_digest.gmail_section AND by the dry-run's "digest preview")
- `plan_message_preview(msg, resolutions, extraction, previews...) -> str` — the per-message dry-run block carrying EVERY G4 item-3 field: source_ref, thread_id, sender (name + email), each resolution {slug, kind, method, outcome, reason, contact_id}, cached-or-fresh flag, extraction summary + every decision/commitment/open_question WITH its grounding quote + matches_open_item, CRM argv previews, page unified diff, task lines with dedup verdicts, escalation text, `cost_usd` + `model_receipt`.
Task 19 (digest) and Task 23 (parity) import from this module.

## C7. Orchestrator (Tasks 8 + 15 — ONE author: the S-06 writer; Task 8 moves to a new part file `04-s04.md`; the S-03/04 writer deletes Task 8 from `03-s03-s04.md`)
- Dry-run persists to `--state-dir` (scratch by construction): ledger rows, extraction
  cache, run receipt, argv.log (main() uses `LoggingRunner(SubprocessRunner(), state_dir)`).
  ONLY the irreversible transports are skipped in dry-run: `create-task`, `send-telegram`,
  the CRM subprocesses, the vault page write (page diff is previewed from the COPY).
  NOTE: in the live copy-only G4 run the CRM/vault ARE copies — but dry-run semantics stay
  "no external effect"; the G4 dry-run evidence is previews + persisted ledger/receipt.
- Partial-resolution merge: load `ledger.latest(ref)`; if same digest, carry forward
  every resolution already `filed`, resolve afresh only the rest, file only not-yet-filed;
  widen extraction context from ALL bound slugs (filed + newly fileable); no-change
  re-check ⇒ no append; ignored/escalated re-checks with identical outcome set ⇒ no append.
- Escalation: `plan_escalation` text; live send via runner `cortextos bus send-telegram`
  only if `not ledger.escalated_for(ref, digest)`; dry-run previews the text; the row
  records outcome escalated.
- `--query` ⇒ `sweep(..., extra_query=cfg.query)`.
- Failures: `except (GmailSourceError, ExtractionError) as exc` ⇒ `record_failure(...)`
  + exit 3; `except BudgetExceeded as exc` ⇒ persist `exc.extraction` cost/receipt/cache
  on the row, `record_failure(error="budget", cost_usd=...)`, exit 12; lock held ⇒
  `record_failure(error="lock-held")` — the receipt's `last_success_at` is unchanged;
  catch-all ⇒ record_failure + exit 3. Never mark filed on a non-zero writer rc
  (`write_interaction`/`create_task` raise `WriterError` on rc≠0 or malformed stdout).
- CRM rows per contact_id (every known counterparty with a contact); contact auto-create
  ONLY for the SENDER when domain-matched with no contact row (From header name+email);
  recipients without a contact row are NOT created (their page still gets History).
- History write: `client_file_lock(page_path)` from
  `orgs/clearworksai/agents/pa/scripts/meeting_writeback.py` (import via
  `importlib.util.spec_from_file_location`, read-only reuse — FR-010) held across
  read + render + atomic write; dry-run reads under the lock too (cheap) and previews.
- `_file_message` sets outcome `filed` only after every write for that resolution
  succeeded; `reason` set on ignored rows; `del cfg` bug removed.
- Task 15 restates the WHOLE test file (no append block).

## C8. client_state_writes (Tasks 12 + 14)
- commitments use `owner_name` everywhere (schema field); fixtures schema-valid.
- `list_open_tasks(runner) -> list[dict]`: for cls in ("human", "build"):
  `cortextos bus list-tasks --open --class <cls> --format json --limit 200`; rc≠0 ⇒
  raise `TaskEnumerationError` (never an empty authoritative list); returns dicts with
  id/title/status/assigned_to; the orchestrator joins `ledger.open_email_tasks()` ids to
  this list and keeps only those still open. Owner for tier-1 = `normalize_owner(task["assigned_to"])`.
- `ensure_contact` parses upsert-contact.py's REAL stdout (read the script; if it prints
  the id, use it; else reload contacts.json and match by email); `write_interaction` /
  `create_task` raise `WriterError` on rc≠0 or unparsable stdout.
- `import difflib` in the test header; `--limit 200` (bus clamp `LIST_TASKS_MAX_LIMIT = 200`).

## C9. extract_email (Tasks 9–11)
- Typed validator against `email_extraction.schema.json`: required keys, nested primitive
  types (string/integer/null), `additionalProperties:false` at every level, nullable
  `deadline_iso`/`matches_open_item`; then single-line checks; then range check.
- Task 11 hostile test: extraction-level assertions only (item survives gate; validator
  accepts; routing is asserted in Task 15's tests, which import plan_tasks legitimately).

## C10. Digest (Tasks 18–20)
- NO auto-baseline. New CLI entry `python3 scripts/brain/client_state_digest.py write-baseline --state-dir … --vault …`
  (explicit, one-time; the activate goal commits it). `gmail_section` with a missing or
  corrupt baseline emits an ERROR line (`- invariants: baseline missing — run write-baseline`)
  and never writes one.
- `new_violations` compares canonical records (name/domain/ref + sorted page set); a page
  added to an existing duplicate set is NEW.
- Superseded-task lines: for each revision row in the last 24h, find ALL prior rows for the
  same source_ref (full history), collect their `task:<id>` writes, keep those whose current
  status is open (join against `list_open_tasks` via the runner — digest takes a runner),
  emit `- evidence superseded — review: task:<id> <title>`.
- Sections: `try/except Exception` around EACH section body; test where `list_transcripts`
  raises; both lines composed; digest lines from `plan_digest_line` (extraction summary shown).

## C11. Ops (Tasks 21–23)
- `g1-count-delta.sh`: parse vitest FAIL records only (`grep -a -E '^ (FAIL|×)'` or the
  " ❯ path (N tests | M failed)" lines — inspect a real log
  `docs/pipeline/run-artifacts/client-state-gmail-v1/baseline-npm-test.log` in the worktree
  and pin the regex to it); keep every runner rc (no `|| true`), include `test:node`;
  `check` also asserts zero overlap between BASELINE failing files and `git diff --name-only <base>...HEAD`.
- `g4-check.sh`: every numbered item asserts every named field/companion artifact
  (item 1: counts == G1 record + clean tree; item 3: ledger + receipt + per-message
  fields incl. model_receipt; item 5: zero previews, cost delta 0.00, receipt unchanged,
  lock tests incl. stale-cleared-then-win; item 8: named layers + existing evidence paths);
  negative fixture per item in a selftest.
- `mutation-check.sh`: registry loader failure ⇒ exit 1; zero rows ⇒ exit 1; `REPO_ROOT`
  required; back up each target file before sed and restore from the backup under an
  `EXIT` trap (never `git checkout --`; the claim guard is uncommitted at that point).
- Parity test: import `client_state_projections`; for every projection assert preview text
  == what the live `do_*` consumer executes (run `do_*` against a tmp copy / FakeRunner and
  compare the argv/text it used); no skips.
- `single_flight.acquire` retries ONCE when the claim CLI reports `stale-cleared`
  (meeting-brief semantics: stale never wins in-band; the second call wins) — Task 2 owns
  the change; Task 23/G4 item 5 asserts "stale ⇒ next acquire wins".
- Guard registry: rebuild from the FINAL parts — one row per `# G-<ID>` / `// G-<ID>`
  marker actually present; every writer puts the marker ON the operative line.

## C12. Counts
Every Step 2/4 expected count is re-derived from a real run against the real siblings
after the fix; the File map (orchestrator) gains every test file the tasks create.
