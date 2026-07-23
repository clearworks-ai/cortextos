# OBF Master Plan — meeting-recap-draft-worker

Plan engine: Fable (Josh-picked). Stage: PLAN. Date: 2026-07-21.

## Feature (verbatim scope)

Build a cortextOS AGENT-SIDE worker skill: `meeting-recap-draft-worker`. It auto-drafts a
post-meeting recap + next-steps email as a Gmail DRAFT (never sends). NOT a
cxportal/lifecycle-killer app feature. A short-lived, cron-spawned worker skill exactly like
the two existing sibling workers (`meeting-commitments-worker`, `transcript-scanner-worker`).

Home: `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/.claude/skills/meeting-recap-draft-worker/`

## Reuse decision (the core call)

**Chosen: Option (a) — add a `--recap` mode flag to `ff-extractor.py` itself.** No new script.

Facts found by reading `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/ff-extractor.py`:

1. The extractor **already fetches everything a recap needs but does not emit it**.
   `TRANSCRIPT_FIELDS` (lines 35-61) includes `title`, `date`, `organizer_email`,
   `participants`, `summary { overview, shorthand_bullet, action_items, keywords }`, and
   `sentences`. The current `run()` (lines 788-857) emits only the commitments `items` array.
   So no GraphQL change is needed — only a new emit path.
2. **Why not a thin sibling script importing ff-extractor:** the filename `ff-extractor.py`
   contains a hyphen, so it cannot be imported with a normal `import` statement; a new script
   would need an `importlib.util.spec_from_file_location` shim (exactly what
   `test_ff_extractor.py:17-23` does). A shim script is strictly MORE code and a second place
   Fireflies logic lives. A flag inside the one file is least-invasive and literally preserves
   "ff-extractor is the single Fireflies touchpoint."
3. **Watermark interference (the trap Option (a) must avoid):** `run()` advances
   `state/ff-extractor-watermark.json` via `save_watermark()` (lines 286-307, called at
   line 855-856) after processing, and the sibling meeting-commitments-worker depends on that
   watermark for its "fresh meetings" selection. If the recap worker ran the normal pipeline it
   would consume the sibling's freshness window. Therefore **recap mode never reads or writes
   the watermark and never POSTs to the ingest endpoint**. Recap freshness comes from the
   worker's own dedup ledger, passed read-only to the script as `--recap-ledger` so
   already-drafted meetings are skipped BEFORE any LLM spend.
4. **Noise-gate reuse is by function call, not copy:** recap next-steps are produced by the
   existing pipeline `build_transcript_text` (232-245) → `is_casual_transcript` (469-485) →
   `extract_action_items` (488-501) → `refine_items` (691-725) →
   `commitment_payload_entries` (728-738). `refine_items` already applies
   `VAGUE_ACTION_PREFIXES` (136-147, via `has_concrete_action` 571-575), `SUPPRESSED_NAMES`
   (148-149, via `is_suppressed` 607-611), and `GENERIC_OWNERS` (150-151, in
   `refine_inbound_item` 657-688). Recap mode additionally suppresses the WHOLE meeting when
   title/participants/organizer hit `SUPPRESSED_NAMES` (Marcos Santa Ana never gets a draft).

New CLI contract (additive, existing contract untouched):

```
python3 scripts/ff-extractor.py --recap --limit N [--recap-ledger PATH]
```

stdout JSON: `{"recap": true, "meetings": [...], "skipped_ledger": n, "skipped_casual": n, "skipped_suppressed": n}`
where each meeting = `{id, title, date, organizer, attendees, summary: {overview, bullets, action_items}, next_steps: [{id, text, direction, source, sourceRef}]}`.
Exit 0 on success (including zero meetings — SILENT-OK), exit 1 with `{"error": ..., "recap": true, "meetings": []}` on failure (mirrors `execute()` at lines 772-785).

## Gmail draft contract

The worker SESSION (not the python script) calls the Gmail MCP tool
`mcp__claude_ai_Gmail__create_draft` — one draft per new meeting. **NEVER send.** Recipient
defaults to Josh (`weissjosh0@gmail.com`) as a self-draft he reviews/edits/sends; the spec does
NOT auto-address attendees. Body = recap paragraph (summary.overview, fallback bullets) + a
"Next steps" numbered list from the noise-gated `next_steps`.

## Dedup ledger

`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/state/meeting-recap-drafts-surfaced.txt`
— append-only, line format `<meeting_id> <epoch>`, keyed by Fireflies transcript id. Absolute
path everywhere (both sibling ledgers currently exist in BOTH `pa/state/` and `frank2/state/`
because sibling SKILLs mix cwd-relative paths across a cd — this worker avoids that split-brain
by using the absolute frank2 path, colocated with the extractor watermark). The python script
READS it (`--recap-ledger`) to skip pre-LLM; only the worker session APPENDS, and only AFTER
`create_draft` succeeds — so a failed draft is retried next run.

## File manifest (everything the build creates/modifies)

| # | Path | Action |
|---|------|--------|
| 1 | `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` | MODIFY — add `--recap` mode (spec-01) |
| 2 | `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/test_ff_extractor.py` | MODIFY — add recap-mode tests (spec-03) |
| 3 | `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/.claude/skills/meeting-recap-draft-worker/SKILL.md` | CREATE — worker skill (spec-02) |

Runtime-created (not authored): `frank2/state/meeting-recap-drafts-surfaced.txt` (touched by SKILL Step 1).

Post-build ops step (not a file, needs Josh/pa runtime): register the cron that spawns the
worker (`meeting-recap-draft`, every 4h) on pa, mirroring how `meeting-commitments` is wired.

No new runtime deps: recap mode uses only stdlib + the env/model plumbing ff-extractor already
has (`FIREFLIES_API_KEY`, `OPENROUTER_API_KEY`; ingest envs NOT required in recap mode). No
`print`-debug noise; the single JSON stdout line is the contract, `LOGGER` for errors, same as today.

## Risks

1. **Watermark regression** — if recap mode accidentally calls `save_watermark` or requires
   ingest envs, it breaks meeting-commitments-worker. Mitigated: spec-01 forbids it; spec-03
   has an explicit test asserting the watermark file is untouched by `--recap`.
2. **LLM cost on every cron tick** — mitigated by `--recap-ledger` pre-LLM skip + `--limit 10`
   + the casual gate (casual meetings never drafted, and are ledger-appended by the worker as
   drained via the script's `skipped_casual` count? NO — casual meetings are NOT ledgered by
   the script; see spec-02 step 5: worker appends casual/suppressed ids too, so they aren't
   re-classified every run. Script stays read-only on the ledger.)
3. **Double-draft** — grep-before-draft in SKILL (belt) + script-side ledger skip (suspenders),
   mirroring the sibling `grep -qF` pattern exactly.
4. **Marcos Santa Ana leak** — three layers: meeting-level suppression in recap mode,
   `refine_items`' `is_suppressed` on items, and SKILL belt-and-suspenders text filter.
5. **Gmail MCP tool unavailable in worker session** — SKILL degrades: log
   `recap_degraded_no_gmail`, do NOT append ledger (retry next run), no Telegram spam.

## Acceptance criteria

- [ ] `python3 scripts/ff-extractor.py --recap --limit 5 --recap-ledger /tmp/empty.txt` emits
      schema-valid JSON (meetings array, per-meeting summary + gated next_steps), rc 0, and
      `state/ff-extractor-watermark.json` mtime/content unchanged.
- [ ] Existing CLI (`--limit N [--dry-run]`) behavior byte-identical (no contract change);
      all pre-existing tests in `test_ff_extractor.py` still pass.
- [ ] New unit tests pass: ledger skip, meeting-level suppression, casual skip, next-steps
      noise-gate reuse, watermark untouched, ledger never written by script.
- [ ] SKILL.md mirrors sibling shape: verbatim bash blocks, task create/complete,
      `update-cron-fire`, `log-event`, `cortextos terminate-worker "$CTX_AGENT_NAME"`,
      literal `DONE`, SILENT-OK on nothing-new.
- [ ] Draft path: `create_draft` only, to `weissjosh0@gmail.com`, never any send tool.
- [ ] Ledger append only after successful draft creation; append-only, absolute path.
- [ ] `python3 -m unittest test_ff_extractor -v` green from
      `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/scripts/`.

## Shards

- `03-specs/spec-01-ff-extractor-recap-mode.md` — the `--recap` emit mode in ff-extractor.py.
- `03-specs/spec-02-worker-skill.md` — the SKILL.md worker.
- `03-specs/spec-03-tests.md` — unit tests for recap mode.

Build order: 01 → 03 (test against 01) → 02. Spec-02 depends only on 01's CLI contract.
