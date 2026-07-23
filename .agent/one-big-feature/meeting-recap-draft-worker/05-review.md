# 05 — Adversarial Review: meeting-recap-draft-worker

## VERDICT: PASS

Reviewed at commit-diff level (`git diff`), traced every recap code path, ran the full test suite (35 passed). All seven hard invariants hold at the code level. Findings below are advisory only — none block.

Files reviewed:
- `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` (+183 / -0)
- `orgs/clearworksai/agents/frank2/scripts/test_ff_extractor.py` (+333 / -0)
- `orgs/clearworksai/agents/pa/.claude/skills/meeting-recap-draft-worker/SKILL.md`

---

## Findings (one line each)

- `ff-extractor.py:969`: LOW: `date_iso = parsed_date.isoformat() if parsed_date.tzinfo ...` dereferences `parsed_date.tzinfo` when `parse_transcript_datetime` can return `None` (documented return, line 248). It does not crash — the surrounding `except (ValueError, AttributeError)` (line 970) swallows the `AttributeError` and falls back to `""` — but this is exception-as-control-flow for an expected `None`. Fix: guard `if parsed_date is None: date_iso = ""` explicitly before the `.tzinfo` access.
- `ff-extractor.py:1021`: LOW: `if len(meetings) >= limit: break` reuses the fetch `limit` as the emit cap. Correct, but means when many meetings are deduped/suppressed the loop still processes up to `limit` NEW meetings through the LLM — acceptable and bounded, just noting the cap is shared, not separate.
- `ff-extractor.py:900-919` (`is_suppressed_meeting`): INFO: pre-LLM suppression checks only title + organizer_email + participants, NOT transcript body. This is correct by design (layer 1 is cheap metadata to avoid the LLM); body-level suppression is layer 2 inside `refine_items`. Not a gap.
- `SKILL.md` Step 5: INFO: footer/body construction is prose instructions to the worker LLM, not code — the byte-level guarantees below apply to the extractor; the "draft only / never send" constraint in the skill is enforced by tool-availability convention, not code. Acceptable for a skill, but the send-prevention is a soft (prompt) guarantee at the skill layer (see NO SEND note).

---

## Invariant Verification (evidence)

### 1. WATERMARK BYTE-IDENTICAL — PASS
The only watermark writer in the module is `save_watermark(path, ...)`, called exactly once at `run():856` (the commitments path). Traced the entire recap path — `main():886-890` → `execute_recap():869-881` → `run_recap():990-1027` → `build_recap_meeting():922-987` — grep across lines 886-1030 for `save_watermark|post_commitments|.write|open(...,"w")|BRIEFS_INGEST|TASKS_INGEST` returns **zero matches**. `run_recap` never loads or touches `DEFAULT_WATERMARK_PATH`; it only reads its own separate `--recap-ledger` (default `STATE_DIR/meeting-recap-drafts-surfaced.txt`, line 866) via `load_recap_ledger():894-907`, which is **read-only** (opens `"r"`, line 900). `main()` recap branch (line 887) `return`s before `execute()`/`run()` is ever reached, so the watermark path is unreachable in recap mode. Test `test_run_recap_never_touches_watermark_or_ledger` asserts byte-identical watermark AND ledger after a run — passes.

### 2. NO SEND — PASS (with note)
No email-send capability exists anywhere in the recap Python path — the extractor emits JSON to stdout only (`print(json.dumps(...))`, line 1021) and never calls any mail API. The only outbound network calls in recap are Fireflies GraphQL (read) and OpenRouter (classify/extract) via the injected `urlopen`. The skill's Step 5 restricts output to `mcp__claude_ai_Gmail__create_draft` (to `weissjosh0@gmail.com`, self-draft) and states "NEVER call any send tool" three times. NOTE: at the skill layer this is a prompt-level constraint (no code gate blocks a send MCP tool); acceptable given the worker is short-lived and the extractor itself is send-incapable, but the send-prevention is soft at the skill boundary.

### 3. MARCOS SUPPRESSION (3 layers) — PASS
- Layer 1 (pre-LLM, cost + privacy): `run_recap():1011-1013` calls `is_suppressed_meeting(transcript)` and `continue`s BEFORE `build_recap_meeting` (the only LLM caller). `is_suppressed_meeting():900-919` matches normalized `SUPPRESSED_NAMES = ("marcos", "santa ana")` against title/organizer/participants. Test `test_run_recap_suppresses_marcos_meeting` asserts `skipped_suppressed==1`, `meetings==[]`, and **`len(openrouter_calls)==0`** — proving the drop happens before any LLM/cost/privacy exposure.
- Layer 2 (body-level): `build_recap_meeting():986` → `refine_items()` → `refine_outbound_item():646` / `refine_inbound_item():680` both call `is_suppressed(...)` against the same `SUPPRESSED_NAMES`.
- Layer 3 (skill): SKILL.md Step 3 "EXCLUDE any meeting or next-step mentioning Marcos Santa Ana (hard no)."

### 4. DEDUP LEDGER ORDERING — PASS
The extractor never writes the ledger (read-only, finding above). The append happens only in the skill, Step 5: "Only AFTER `create_draft` returns success ... `echo "$MEETING_ID $(date -u +%s)" >> "$LEDGER"`", and explicitly "If `create_draft` fails ... do NOT append the ledger (the meeting retries next run)." Step 4 forbids appending on read. Ordering is correct: create_draft success → then append. Ledger is append-only; ledger read in `run_recap():1000` skips already-surfaced ids BEFORE suppression/LLM (`test_run_recap_skips_ledgered_meeting_before_llm` asserts `openrouter_calls==0` on a ledgered id).

### 5. NOISE GATE REUSE — PASS
`build_recap_meeting():986` calls the existing `refine_items(transcript, extracted)` (defined line 691, unchanged) and wraps it with the existing `commitment_payload_entries()` (line 728, unchanged). No reimplementation of the noise gate (VAGUE prefixes / GENERIC_OWNERS / SUPPRESSED_NAMES / due-date logic) — all inherited. `extract_action_items` and `is_casual_transcript` are also the existing functions, reused verbatim.

### 6. ADDITIVE ONLY — PASS
`git diff --numstat` = **183 insertions, 0 deletions** on `ff-extractor.py` (333/0 on tests). The only edits to existing code are two new `parser.add_argument` lines (865-866) appended inside `parse_args`, and a 5-line `if args.recap:` early-return block inserted at the top of `main()` (887-891) BEFORE the untouched `execute(...)` call. No existing commitments/POST/watermark line was modified or removed. `test_existing_dry_run_contract_unchanged` guards the pre-existing arg contract.

### 7. CODE QUALITY / SECRETS — PASS
No hardcoded secrets (diff scan for api_key/token/sk-/secret literals returns NO_HARDCODED_SECRETS; keys come via `require_env`). `run_recap` requires only `FIREFLIES_API_KEY` + `OPENROUTER_API_KEY` (lines 998-999) — NOT the ingest env, correct for a no-POST path (`test_recap_mode_does_not_require_ingest_env` passes). Error contract is well-formed: `execute_recap():869-880` catches the expected exception set and emits `{"error", "recap":true, "meetings":[]}` with rc=1 (`test_execute_recap_error_contract` passes). Defensive typing throughout (`isinstance` guards on participants/summary/sentences). Only nit: the line-969 `None`-deref-via-except noted above.

---

## Test Suite
`python3 -m pytest test_ff_extractor.py -q` → **35 passed in 0.05s**. New `RecapModeTests` covers: arg defaults, ledger parse (missing + malformed), pre-LLM ledger skip, Marcos suppression (0 LLM calls), casual skip (classifier-only, no extractor), contract shape, watermark+ledger byte-identity, error contract, ingest-env independence, and existing-contract regression guard.
