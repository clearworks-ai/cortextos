# 01 — Research: crm event-emit test-mode guard

## Bug (reported by frank2 + crm, reproduced under PR#317 test run)

The crm agent's DESIGN-B event lane (shipped PR#305, commit `d9cb5c83`) emits a real bus
message on every write via `subprocess.run(["cortextos","bus","send-message","crm","normal",line])`
UNLESS the env var `CRM_EVENT_EMIT_LOG` is set (in which case it appends the line to that log file
instead — the intended test seam). Not every test that exercises an emit-triggering code path sets
`CRM_EVENT_EMIT_LOG`, so those tests spam crm's live bus inbox with synthetic events. Tonight this
produced a real event flood, first misdiagnosed as a spoofed/malicious sender, then root-caused to
test traffic.

## Verified call sites (all citations confirmed against current source this session)

Four separate implementations, NOT one shared function:

| # | File | Function | Line | Emits | Called by | Emit mechanism |
|---|------|----------|------|-------|-----------|----------------|
| 1 | `orgs/clearworksai/agents/crm/crm/upsert-contact.py` | `_emit_crm_event` | 241 | `crm.contact.created` | `emit_contact_created_event` (238), only when `is_new_contact and type==person and not junk` (228→229) | in-process AND via subprocess (script is `python3 upsert-contact.py`) |
| 2 | `orgs/clearworksai/agents/crm/crm/sync-board.py` | `_emit_crm_event` (its own copy) | 191 | `crm.deal.stage_changed` | `emit_stage_changed_event` (188), per changed engagement | in-process (tests import via importlib) |
| 3 | `orgs/clearworksai/agents/crm/crm/crm_connect_common.py` | `emit_crm_event` (SHARED) | 494 | — | imported by `reconcile-intake.py` (import at line 21, call `emit_crm_event("crm.deal.created",…)` at line 83 via `emit_deal_created_event`) | in-process |
| 4 | `orgs/clearworksai/agents/crm/crm/comms-backfill.py` | `emit_crm_event` (its OWN local copy) | 72 | `crm.email.captured` | `log_interaction` (70) | in-process |

### Citation corrections vs the brief
- **Confirmed accurate:** upsert-contact.py:241, sync-board.py:191, crm_connect_common.py:494,
  reconcile-intake.py call at :83, comms-backfill.py local copy at :72 / call at :70.
- **Confirmed:** `comms-backfill.py` does NOT import from `crm_connect_common.py` — it has its own
  duplicate `emit_crm_event` (line 72). It DOES import `os` and `subprocess` (combined `import` on
  line 7) but does **not** import `sys`.
- **Confirmed:** `reconcile-intake.py` DOES import `emit_crm_event` from `crm_connect_common` (line 21),
  so call site #3's shared function serves reconcile-intake only; comms-backfill is independent.
- **Import inventory:** upsert-contact.py and sync-board.py both already import `os`, `subprocess`, AND
  `sys` at top level. crm_connect_common.py imports `os` + `subprocess` but NOT `sys`. comms-backfill.py
  imports `os` + `subprocess` but NOT `sys`. => any guard that references `sys.modules` must ensure `sys`
  is imported in crm_connect_common.py and comms-backfill.py (2 one-line import additions).

All four bodies are byte-identical in shape:
```python
line = f"EVENT {event_type} — {payload}"
log_path = os.environ.get("CRM_EVENT_EMIT_LOG")
if log_path:
    ...append to file, return
try:
    subprocess.run(["cortextos","bus","send-message","crm","normal",line], ...)
except (OSError, subprocess.SubprocessError):
    pass
```

## Test-file audit — which tests fire a REAL emit today

| Test file | Runner style | Sets `CRM_EVENT_EMIT_LOG`? | Fires real bus today? |
|-----------|--------------|---------------------------|-----------------------|
| `test_crm_events.py` | in-process import + one subprocess (E3) | **YES** (setUp) | No — safe, this is the seam's own test |
| `test_sync_board.py` | in-process (`MODULE.sync_board`) | NO | **YES** — `test_board_stage_change_updates_engagement…` changes lead→qualified → `emit_stage_changed_event` fires in-process |
| `test_reconcile_intake.py` | in-process (`MODULE`) | NO | **YES** — `test_merge_appends_one_new_engagement…` appends a new engagement → `emit_deal_created_event` fires in-process |
| `test_upsert_contact.py` | subprocess (`python3 upsert-contact.py`), sets `CRM_CONTACTS_PATH`+`CRM_SUPPRESSION_PATH` only | NO | Not TODAY (its one test uses `--match-email` on an EXISTING contact, so `is_new_contact` is false and the emit branch at 228 is skipped) — but latent: any new-person test here would fire a real bus message |

**Primary live flood sources = the in-process tests (`test_sync_board.py`, `test_reconcile_intake.py`).**
The subprocess path (`test_upsert_contact.py`) is a latent trap, not the current bleeder.

## Test-mode signal investigation (empirically probed this session)

No existing `CRM_TESTING`/`CI`/`PYTEST` convention exists in the crm scripts. `.env` holds only Zoom
creds. There is no `conftest.py`, `pytest.ini`, `setup.cfg`, or `pyproject.toml` under the crm agent,
and no fleet harness reference that pins a runner — the test files end in `unittest.main()`, so they can
be run either as `pytest test_x.py` OR as plain `python3 test_x.py`.

Probed behavior (see task evidence):

| Signal | pytest, in-process | pytest, subprocess child (`os.environ.copy()`) | plain `python3 test_x.py`, in-process | plain unittest, subprocess child |
|--------|--------------------|-----------------------------------------------|---------------------------------------|-----------------------------------|
| `PYTEST_CURRENT_TEST` env | **set** | **inherited** ✅ | not set | not set |
| `"pytest" in sys.modules` | **True** | False (fresh interp) | False | False |
| `"unittest" in sys.modules` | True (pytest loads it) | False | **True** | False |
| `CRM_EVENT_EMIT_LOG` | only if test sets it | inherited if set | only if set | inherited if set |

### Consequences for guard design
1. `PYTEST_CURRENT_TEST` is the single strongest AUTOMATIC signal: pytest sets it, and it is inherited by
   subprocess children through `os.environ.copy()` (which both subprocess-launching test files use). It
   covers the reproduced case (PR#317 ran under pytest) for BOTH in-process and subprocess emits.
2. Under plain `python3 test_x.py`, PCT is absent. For **in-process** emits, `"unittest" in sys.modules`
   (or `"pytest" in sys.modules`) is a reliable automatic backstop — the framework module is loaded in
   the same interpreter that runs the emit. This covers the actual live bleeders (sync-board / reconcile).
3. Residual narrow gap: a plain-`unittest` run that launches `upsert-contact.py` as a **subprocess** has
   NO automatic signal in the child (no PCT, no unittest in child's modules). The only universal cover
   there is an env var the parent test passes. Today no such test exists (the sole subprocess test uses
   `--match-email` and doesn't emit), so this gap is theoretical. Mitigation: (a) the guard's belt-and-
   suspenders `CRM_EVENT_EMIT_LOG`-set path already neutralizes it whenever a test sets the log, and
   (b) `test_crm_events.py`'s E3 subprocess case DOES set the log. Document, don't over-engineer.

## Does any test rely on the emit reaching the REAL bus?
No. Every emit-asserting test in `test_crm_events.py` asserts against the `CRM_EVENT_EMIT_LOG` file, never
against the live bus. `test_sync_board.py` / `test_reconcile_intake.py` don't assert on the emit at all —
they assert on pipeline/engagement state; the emit is an unwanted side effect. So suppressing the real
subprocess under test mode breaks nothing.

## Baseline
`python3 -m pytest test_crm_events.py test_sync_board.py test_reconcile_intake.py test_upsert_contact.py`
=> **19 passed** (pre-change baseline captured this session).
