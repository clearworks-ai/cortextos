# Independent Pipeline Review — PR #304 `ea-cluster-proactive-pa`

Reviewer: independent Opus review session (did NOT build this). Adversarial.
PR head: `d022be9e9812f1183f6646399a1b5cb0f8053ef2` (branch `ea-cluster-proactive-pa`).
Base: `origin/main`.

## Scope (verified)
`git diff --name-only origin/main...FETCH_HEAD` = exactly 4 files:
- `orgs/clearworksai/agents/pa/.claude/skills/booking-coordinator-worker/SKILL.md` (new)
- `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md` (edit: EA lane classification + no-show sweep)
- `orgs/clearworksai/agents/pa/scripts/booking_coordinator.py` (new, 417 lines)
- `orgs/clearworksai/agents/pa/scripts/test_booking_coordinator.py` (new, 174 lines)

NO `src/daemon`, `src/hooks`, `src/telegram` touches. Confirmed.

## DRAFTS-ONLY / NO SEND PATH (invariant) — PASS
- Every `+send` occurrence in the diff is a negation or comment ("never `+send`", "no `+send` variant emitted"). No live send path.
- Both `+insert` occurrences carry `--dry-run` (prose L12 + `hold_validate_argv` L275). Never a real insert.
- Both `send` flags in `propose_plan` / `no-slots` are `False`; comment: "invariant: this worker never sends".
- Gmail path is `gws gmail +draft` only (DWD shim `+draft` structurally cannot send). No Gmail MCP tool referenced.
- Test `test_slots_avoid_busy_blocks_and_draft_never_sends` asserts `plan["send"]` false, `+draft` in argv, `+send` NOT in argv.
- ZCAL = public link appended to draft body (`zcal.co`), never a slot-create API; row closed by inbound signal (calendar-delta / Fireflies).

## Logic review (adversarial)
- **Scheduling-intent classifier**: deterministic regex, recall-first. Probed false positives (`reschedule my dentist`, `are you free-form`, `yes sounds good`) DO match — but by design these route to a Lane-B **draft** (unsent) that the human reviews; SKILL states the regex is the seam and prose judges residual cases. Human-in-the-loop backstop makes this acceptable, not a defect.
- **no-show-sweep**: `state==booked` AND `now >= call_time+45m` AND NOT `closed_by`. 2-touch cap → `not-now`. Correct; tests cover the 60m-open, 10m-not-yet, transcript-closed, and cap cases.
- **calendar-delta**: diffs prior vs new agenda snapshot by event id (booked/moved/cancelled); no new poller. Handles both str and dict `start` shapes (Python equality). Correct.
- **free_slots**: avoids every busy interval correctly (the DESIGN-A §4 failure class). NOTE (non-blocking): working-hours filter (9–17) is applied to the raw UTC `.hour` while the label is "PT" — proposed slots skew ~8h. Because every slot is a human-reviewed draft and busy-avoidance is unaffected, this is a quality note for follow-up, not a blocker for a drafts-only worker.

## Tests / build — PASS
- `python3 -m unittest test_booking_coordinator` → **Ran 10 tests, OK**.
- `python3 -m unittest test_meeting_recap_draft` → **Ran 6 tests, OK** (file untouched by PR — true no-regression baseline; `git diff --stat` empty for both recap files).
- `npm run build` → **Build success in 84ms, exit 0**.

## Gitignored-pa-file constraint
Build flagged that config/pmb/meeting-commitments prose edits are pa-local (gitignored). Confirmed: the PR'd logic is fully self-contained in the 4 tracked files above and independently tested — no dependency on untracked local prose to function.

## VERDICT: PASS
Drafts-only confirmed (no send path, dry-run-only calendar). Scope clean. Tests + build green. One non-blocking timezone quality note on slot working-hours filtering.

## Provenance note
No prior ledger rows exist for slug `ea-cluster-proactive-pa` in any checkout (genesis — no build chain). Per the pr279/pr286 pattern, an exempt genesis-anchored receipt is emitted, citing this independent review transcript.
