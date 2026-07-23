# spec-03 — recap-mode unit tests

## Scope (verbatim)

Unit tests proving spec-01's hard invariants: recap emit contract, ledger read-only skip,
meeting-level suppression, casual skip, noise-gate reuse on next_steps, watermark untouched,
existing commitments contract unchanged.

## File

MODIFY `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/test_ff_extractor.py`
— the ONLY file in this shard. Follow the file's existing pattern exactly: module loaded via
`importlib.util.spec_from_file_location` at lines 17-23 (`MODULE` global), `unittest.TestCase`
classes, run with `python3 -m unittest test_ff_extractor -v` from the `scripts/` dir. No pytest,
no new deps.

## Test class: `RecapModeTests(unittest.TestCase)`

Shared fixture helpers (add to the class):

- `make_recap_transcript(**overrides)` → dict with `id="meeting_r1"`, `title`, `date`,
  `organizer_email`, `participants=["josh@clearworks.ai", "sara@acme.com"]`,
  `summary={"overview": "...", "shorthand_bullet": "...", "action_items": "..."}`, and one Josh
  sentence — mirroring `make_transcript` at lines 27-38.
- `fake_urlopen(responses)` — a stub `Urlopen` returning canned Fireflies GraphQL and
  OpenRouter payloads in sequence (context-manager objects with `.read()`/`.status`), matching
  how `urlopen` is injected throughout the module (`fireflies_graphql` line 343,
  `openrouter_request` line 433). All network is stubbed; zero real HTTP.

Tests (names are the contract; implementer keeps them 1:1):

1. `test_parse_args_recap_defaults` — `MODULE.parse_args(["--recap"])` sets `recap=True` and
   `recap_ledger` ends with `state/meeting-recap-drafts-surfaced.txt`.
2. `test_load_recap_ledger_missing_and_malformed` — missing path → `set()`; a tmp file with
   `"m1 1720000000\n\ngarbage-only-token\n m2 999\n"` → `{"m1", "garbage-only-token", "m2"}`
   (first token per non-empty line, malformed tolerated).
3. `test_run_recap_skips_ledgered_meeting_before_llm` — ledger contains the meeting id;
   `run_recap` output has `meetings == []`, `skipped_ledger == 1`, and the OpenRouter stub was
   NEVER called (assert call count 0 → proves pre-LLM skip).
4. `test_run_recap_suppresses_marcos_meeting` — transcript with `title="Sync with Marcos Santa Ana"`
   → `meetings == []`, `skipped_suppressed == 1`, no OpenRouter calls. Repeat with the name only
   in `participants`.
5. `test_run_recap_skips_casual_meeting` — classifier stub returns `is_casual: true` →
   `meetings == []`, `skipped_casual == 1`, extractor model never called.
6. `test_run_recap_emits_contract_shape` — happy path: one meeting; assert stdout JSON (capture
   via `contextlib.redirect_stdout` like existing tests) has `recap is True`, meeting fields
   `id/title/date/organizer/attendees/summary{overview,bullets,action_items}/next_steps`, and
   `next_steps` entries carry `{id, text, direction, source, sourceRef}` produced by
   `refine_items` (i.e. a vague `"Explore options"` item and a `GENERIC_OWNERS`-owned inbound
   item fed through the extractor stub do NOT appear, while a concrete Josh item with a due
   date does — this pins the noise-gate reuse).
7. `test_run_recap_never_touches_watermark_or_ledger` — point a tmp dir at both files; after
   `run_recap`, watermark file does not exist (never created) and ledger content is
   byte-identical (read-only).
8. `test_execute_recap_error_contract` — force `require_env` failure (env cleared via
   `unittest.mock.patch.dict(os.environ, {}, clear=True)` as existing tests do); rc 1 and
   stdout JSON is `{"error": ..., "recap": true, "meetings": []}`.
9. `test_recap_mode_does_not_require_ingest_env` — env has only FIREFLIES_API_KEY +
   OPENROUTER_API_KEY; happy-path `run_recap` returns 0 (proves invariant 3).

## Regression guard

10. `test_existing_dry_run_contract_unchanged` — only add if not already covered by an existing
    test: `parse_args([])` has `recap is False`, and the pre-existing tests in this file all
    pass unmodified. Do not edit any existing test.

## Done definition

- `cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts && python3 -m unittest test_ff_extractor -v`
  → all tests green (old + new), zero network access, zero writes outside tmp dirs.
- Every spec-01 hard invariant (2, 3, 4, noise-gate reuse) has at least one failing-if-broken test.
