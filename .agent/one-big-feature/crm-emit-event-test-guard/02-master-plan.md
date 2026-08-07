# 02 — Master Plan: crm event-emit test-mode guard

> Fast, low-risk follow-up. NOT a refactor. Full investigation detail is in `01-research.md`.

## Objective
Make crm event emits automatically safe under test runs — no test file should be able to spam crm's
live bus inbox by exercising an emit code path — WITHOUT requiring every test file to remember to set
`CRM_EVENT_EMIT_LOG`, and without changing real production emit behavior or the existing log-file seam.

## Chosen signal (justified)
Guard fires when the emit runs under a test framework, detected by a layered check evaluated at emit time:

```python
def _in_test_mode() -> bool:
    return (
        os.environ.get("PYTEST_CURRENT_TEST") is not None   # pytest, incl. inherited by subprocess children
        or "pytest" in sys.modules                          # pytest, in-process
        or "unittest" in sys.modules                        # plain `python3 test_x.py`, in-process
    )
```

Why this signal (vs `CRM_CONTACTS_PATH`-is-a-tempdir heuristics or a new required flag):
- `PYTEST_CURRENT_TEST` is auto-set by pytest and — critically — **inherited into subprocess children**
  via `os.environ.copy()` (both subprocess-launching test files use it). It covers the reproduced flood
  (PR#317 ran under pytest) for both in-process and subprocess emits, with zero test-file edits.
- `"unittest"/"pytest" in sys.modules` backstops plain `python3 test_x.py` in-process runs — which are
  the ACTUAL current live bleeders (`test_sync_board.py`, `test_reconcile_intake.py` emit in-process).
- Rejected `CRM_CONTACTS_PATH`-points-to-tempdir: not reliably set across all four scripts' tests
  (sync-board/reconcile tests never set it), path-shape sniffing is fragile, and it says nothing about
  the deal/stage/email paths.
- Rejected a NEW required flag (`CRM_TESTING=1`): violates the "must be automatic, don't edit every test
  file" constraint. `PYTEST_CURRENT_TEST` can't be forgotten; a new flag can.

Behavior of the guard: when `_in_test_mode()` is true AND `CRM_EVENT_EMIT_LOG` is NOT set, the emit becomes
a silent no-op (return without shelling out). The existing `CRM_EVENT_EMIT_LOG` branch is UNCHANGED and
takes precedence — tests that assert emit content still work exactly as before. Production (neither test
signal present) is UNCHANGED — real `subprocess.run` fires as today.

Residual narrow gap (documented, not fixed): a plain-`unittest` run that spawns `upsert-contact.py` as a
subprocess has no automatic signal in the child. No such emitting test exists today; `test_crm_events.py`'s
E3 subprocess case already sets `CRM_EVENT_EMIT_LOG`. Left as a known edge with a one-line note, not
addressed by new infra.

## Shared-helper vs inline decision — **INLINE, justified**
Choice: apply the SAME small guard inline to each of the 4 implementations (add `_in_test_mode()` + one
early-return line to each), rather than extracting a single shared helper that all four import.

Why inline (smaller, safer for a fast follow-up):
- The 4 copies are already independent by design — 3 of them are deliberate duplicates (each script is
  standalone/subprocess-invokable; `comms-backfill.py` and `sync-board.py` intentionally don't import the
  shared module). Forcing a shared import now means new import wiring in files that currently have none,
  which is a bigger, riskier diff than a 3-line inline guard per file.
- `upsert-contact.py` runs as a fresh subprocess; it must not gain a fragile import dependency on
  `crm_connect_common` just for a guard.
- Drift risk is real but bounded: the guard is 4 lines and covered by a new regression test that asserts
  NO real subprocess fires under pytest for each of the 4 paths — so drift would be caught mechanically.
- Net diff: ~4 files, ~5 lines each, plus 2 one-line `import sys` additions (crm_connect_common.py,
  comms-backfill.py). No new module coupling. This is the minimal, lowest-blast-radius change.

(If Josh later wants de-duplication, that's a separate refactor OBF — out of scope here.)

## Scope
- IN: add `_in_test_mode()` + guard early-return to all 4 emit implementations; add `import sys` where
  missing; add 1 regression test proving no real subprocess fires under test mode.
- OUT: de-duplicating the 4 copies into one shared function; changing `CRM_EVENT_EMIT_LOG` semantics;
  changing production emit behavior; touching the runbook/cron/AGENTS.md event mappings.

## Rollout risk: very low
- Production path untouched (guard only short-circuits when a test signal is present).
- Existing 19 tests must still pass; the `CRM_EVENT_EMIT_LOG` assertions are unaffected because that
  branch is checked and returns BEFORE the test-mode no-op matters (log path wins).
- No schema, no migration, no multi-repo, no daemon change.

## Success criteria
1. All existing crm tests still pass (19/19 baseline).
2. New regression test proves each of the 4 emit paths does NOT invoke the real `cortextos bus` subprocess
   when run under pytest with `CRM_EVENT_EMIT_LOG` unset.
3. With `CRM_EVENT_EMIT_LOG` set, the log seam still records the event line (unchanged behavior).
4. Guard is a no-op in production (verified by construction/review: neither signal present → real emit).
