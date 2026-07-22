# spec-01 — ff-extractor `--recap` mode

## Scope (verbatim)

Add a recap emit mode to the existing Fireflies extractor so the meeting-recap-draft-worker can
obtain (a) meeting recap material (title/date/attendees/summary) and (b) noise-gated next-steps,
without re-implementing Fireflies fetching and without disturbing the commitments pipeline.

## File

MODIFY `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` — this is the ONLY production file in this shard.

## Hard invariants (violating any = FAIL)

1. Existing CLI (`--limit`, `--dry-run`, `--watermark-path`) behavior unchanged; existing stdout
   JSON contracts unchanged.
2. Recap mode NEVER calls `save_watermark` (lines 286-307) and NEVER calls `post_commitments`
   (lines 741-762). It does not read the watermark either.
3. Recap mode requires only `FIREFLIES_API_KEY` + `OPENROUTER_API_KEY` (via `require_env`,
   line 765). Never `BRIEFS_INGEST_URL` / `TASKS_INGEST_TOKEN`.
4. Recap mode never WRITES the ledger file — read-only.
5. Noise-gate reuse by calling existing functions — do NOT copy or re-declare
   `VAGUE_ACTION_PREFIXES` (136-147), `SUPPRESSED_NAMES` (148-149), `GENERIC_OWNERS` (150-151).
6. No new imports beyond stdlib already present; no `print` other than the single stdout JSON
   line per invocation (match current style — `LOGGER.error` for errors).

## Changes

### 1. `parse_args` (currently lines 860-865)

Add:
```python
parser.add_argument("--recap", action="store_true", help="Emit recap JSON (summary + gated next steps); no POST, no watermark")
parser.add_argument("--recap-ledger", default=str(STATE_DIR / "meeting-recap-drafts-surfaced.txt"))
```

### 2. `main` (currently lines 868-875)

If `args.recap`: dispatch to `execute_recap(limit=max(1, args.limit), ledger_path=Path(args.recap_ledger))` instead of `execute`. `--dry-run` is ignored in recap mode (recap never POSTs anyway).

### 3. New `execute_recap(*, limit, ledger_path, urlopen=urllib.request.urlopen) -> int`

Mirror `execute()` (lines 772-785): same exception tuple, on failure
`LOGGER.error(...)` + `print(json.dumps({"error": reason, "recap": True, "meetings": []}))` + return 1.

### 4. New `load_recap_ledger(path: Path) -> set[str]`

Missing file → empty set. Else: for each non-empty line, first whitespace-delimited token is a
meeting id; return the set. Tolerate any malformed lines (skip). Never writes.

### 5. New `is_suppressed_meeting(transcript: dict[str, Any]) -> bool`

True if any name in `SUPPRESSED_NAMES` appears (substring, after `normalize_action`) in the
meeting `title`, `organizer_email`, or any entry of `participants` (list of emails/names — treat
non-list defensively like other accessors in this file). This is the meeting-level Marcos
Santa Ana hard-no: suppressed meetings get NO recap at all.

### 6. New `build_recap_meeting(transcript, *, openrouter_api_key, urlopen) -> dict | None`

Returns `None` for: missing `id`; empty `build_transcript_text(sentences, limit=CLASSIFIER_MAX_CHARS)`;
`is_casual_transcript(...)` True. Otherwise:

```python
{
  "id": meeting_id,
  "title": collapse_ws(str(transcript.get("title") or "Untitled Meeting")),
  "date": <ISO-Z from parse_transcript_datetime(transcript.get("date")), else "">,
  "organizer": collapse_ws(str(transcript.get("organizer_email") or "")),
  "attendees": [collapse_ws(str(p)) for p in participants if truthy],   # participants list, defensive on non-list
  "summary": {
    "overview": collapse_ws(str(summary.get("overview") or "")),
    "bullets": collapse_ws(str(summary.get("shorthand_bullet") or "")),
    "action_items": collapse_ws(str(summary.get("action_items") or "")),
  },
  "next_steps": commitment_payload_entries(refine_items(transcript, extracted)),
}
```
where `summary = transcript.get("summary") or {}` (defensive: non-dict → `{}`), and
`extracted = extract_action_items(build_transcript_text(sentences, limit=EXTRACTOR_MAX_CHARS), openrouter_api_key=..., urlopen=...)`.
`refine_items` (691-725) is the entire noise gate — no extra filtering here.

### 7. New `run_recap(*, limit, ledger_path, urlopen) -> int`

1. `require_env` the two keys (invariant 3).
2. `ledger_ids = load_recap_ledger(ledger_path)`.
3. `recent = fetch_recent_transcripts(api_key, limit=limit, urlopen=urlopen)` (370-381).
4. Order newest-first: `sorted(recent, key=transcript_sort_key, reverse=True)`.
5. Iterate; track counters `skipped_ledger`, `skipped_suppressed`, `skipped_casual`:
   - no id → skip silently
   - id in `ledger_ids` → `skipped_ledger += 1`, continue (BEFORE any LLM call)
   - `is_suppressed_meeting` → `skipped_suppressed += 1`, continue (BEFORE any LLM call)
   - `build_recap_meeting(...)` → `None` means casual/empty → `skipped_casual += 1`
   - stop once `len(meetings) == limit`
6. `print(json.dumps({"recap": True, "meetings": meetings, "skipped_ledger": ..., "skipped_casual": ..., "skipped_suppressed": ...}))`; return 0. Zero meetings is a normal rc-0 outcome (SILENT-OK).

## Tests to add

Owned by spec-03 (`test_ff_extractor.py`). This shard is done only when spec-03's tests pass
against it.

## Done definition

- All hard invariants hold (spec-03 tests prove 2, 4, and the gates).
- `python3 scripts/ff-extractor.py --recap --limit 5 --recap-ledger /tmp/x.txt` from the frank2
  agent dir (env sourced) emits the contract JSON, rc 0, watermark file byte-identical
  before/after.
- `python3 -m unittest test_ff_extractor -v` fully green (old + new tests).
- No `any`-style loosening of existing type hints; keep `from __future__ import annotations`
  style consistent with the file.
