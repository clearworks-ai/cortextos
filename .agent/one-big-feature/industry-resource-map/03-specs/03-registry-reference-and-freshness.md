# Spec 03 — Registry reference + freshness / delta-refresh (`registry_ref.py`)

**Target file (net-new):**
`orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/registry_ref.py`

Reads the `research-pulse` registry for a vertical **by reference** (path + notebook_id + a small
snapshot), computes **freshness**, and — per Josh's hard requirement — is AWARE of the
`research-pulse-delta` cron and can REQUEST/RUN a refresh when the registry is stale. It NEVER
mutates the research-pulse registry (all writes to it belong to `delta_check.py`).

Style: stdlib only (`json`, `os`, `subprocess`, `datetime`, `pathlib`, `argparse`); `from
__future__ import annotations`; no `print` outside `main()`.

---

## 1. Constants + paths

```python
RESEARCH_PULSE_STATE_DIR = (
    "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse"
)
DELTA_SCRIPT_REL = ".claude/skills/research-pulse/scripts/delta_check.py"
DELTA_CRON_NAME = "research-pulse-delta"
STALE_THRESHOLD_HOURS = 18.0   # delta cron runs every 12h (15 6,18 * * *); 18h = 1.5 cycles,
                               # so one missed run does not trip, a stalled poller does.
```

- `registry_path(vertical) -> Path` → `RESEARCH_PULSE_STATE_DIR/registry/<vertical>.json`, honoring
  a `PULSE_STATE_DIR` env override (same env var pulse_registry uses) so tests can point at a
  fixture registry. **Read-only** everywhere in this module.
- `_parse_iso8601(value) -> datetime | None` — copy pulse_registry's parser
  (`%Y-%m-%dT%H:%M:%SZ`, tz=UTC, `None` on bad/missing).
- `utc_now()` / `utc_now_iso()` — same convention as the other scripts.

## 2. `read_registry_ref(vertical) -> dict`

- Open + `json.load` the registry (raise `FileNotFoundError` if absent — a caller precondition is
  that the pulse exists; SKILL.md Step 1 checks this).
- Do NOT run pulse_registry's full `validate_registry` (we don't want a hard failure if the
  registry has a schema quirk); do a minimal read: require top-level `vertical`, `sources` list.
- Return a reference snapshot (NOT a copy of sources):

```python
{
    "registry_path": str(registry_path(vertical).resolve()),
    "notebook_id": registry.get("notebook_id"),
    "framework_doc": registry.get("framework_doc"),
    "source_count": len(registry.get("sources", [])),
    "registry_updated_at": registry.get("updated_at"),
}
```

- MUST NOT open the file for writing, MUST NOT call `save_registry`. A test asserts the registry
  file's content + mtime are unchanged after this call.

## 3. `compute_freshness(vertical, *, stale_hours=STALE_THRESHOLD_HOURS, now=None) -> dict`

The core of the Josh stale-awareness requirement.

1. Load the registry (read-only, as §2 but needs `sources` for `last_checked`).
2. **Signal:** `most_recent_last_checked` = MAX of every source's `last_checked` (parse via
   `_parse_iso8601`, ignore nulls). This is the true "when did the delta pollers last run" — the
   delta engine stamps `last_checked` on every polled source. If NO source has a `last_checked`,
   fall back to registry `updated_at`.
3. `reference_dt` = that datetime; `age_hours` = `(now - reference_dt).total_seconds() / 3600`
   (use passed `now` for testability; default `utc_now()`).
4. `is_stale = age_hours > stale_hours` (also `True` if `reference_dt` is `None` — no signal at all
   ⇒ treat as stale).
5. Return the freshness block persisted into the manifest's `external.freshness`:

```python
{
    "checked_at": utc_now_iso(),
    "registry_updated_at": registry.get("updated_at"),
    "most_recent_last_checked": <iso or None>,
    "age_hours": round(age_hours, 1) if reference_dt else None,
    "stale_threshold_hours": stale_hours,
    "is_stale": is_stale,
    "delta_refresh_requested": False,          # set True by request_delta_refresh (§4)
    "delta_refresh_command": build_delta_command(vertical),
    "delta_cron_name": DELTA_CRON_NAME,
}
```

## 4. `build_delta_command(vertical) -> str` + `request_delta_refresh(vertical, agent_home=None, run=False) -> dict`

- `build_delta_command(vertical)` returns exactly:
  `f"python3 {DELTA_SCRIPT_REL} --vertical {vertical}"`
  (relative to the agent home, matching how SKILL prompts reference `.claude/skills/...`). This
  exact string is asserted in tests.
- `request_delta_refresh`:
  - `agent_home` defaults to the muse agent dir
    (`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse`); overridable for tests.
  - Resolves the delta script absolute path = `agent_home / DELTA_SCRIPT_REL`.
  - If `run=False` (default): return
    `{ "requested": True, "ran": False, "command": build_delta_command(vertical),
       "cron_name": DELTA_CRON_NAME, "script_path": str(script), "reason": "announce-only" }` —
    i.e. ANNOUNCE the refresh without executing (used when deps/binary unavailable, or when the
    caller just wants the command surfaced).
  - If `run=True`: verify the script exists (`FileNotFoundError` → return `ran:False` +
    `reason:"delta_script_missing"`, never crash); else
    `subprocess.run([sys.executable, str(script), "--vertical", vertical], cwd=agent_home,
    capture_output=True, text=True, timeout=600)`. Return
    `{ "requested": True, "ran": True, "returncode": <int>, "command": ...,
       "summary": <parsed JSON from stdout or None>, "cron_name": DELTA_CRON_NAME }`.
    A non-zero return code or unparseable stdout is reported (not raised) — the caller decides.
  - **Never** writes the registry itself; `delta_check.py` owns that. This function only invokes it.

## 5. `refresh_if_stale(vertical, *, stale_hours=STALE_THRESHOLD_HOURS, run=True, agent_home=None, now=None) -> dict`

Convenience used by SKILL.md Step 2:

1. `freshness = compute_freshness(vertical, stale_hours=stale_hours, now=now)`.
2. If not `freshness["is_stale"]` → return `{"freshness": freshness, "action": "none"}`.
3. If stale → `req = request_delta_refresh(vertical, agent_home=agent_home, run=run)`; set
   `freshness["delta_refresh_requested"] = True`.
   - If `req["ran"]` and returncode 0 → RE-compute freshness (`compute_freshness` again) so the
     manifest records the post-refresh state; return
     `{"freshness": <recomputed>, "action": "refreshed", "request": req}`.
   - Else (announce-only or failed run) → return
     `{"freshness": freshness, "action": "announced", "request": req}` (freshness keeps
     `is_stale:True` and the command populated so the report tells the human exactly how to
     refresh).

## 6. `main(argv) -> int` (CLI used by SKILL.md)

Flags: `--vertical <slug>` (required); `--stale-hours <float>` (default 18);
`--no-run` (announce-only, don't execute delta); `--agent-home <path>` (test/override);
`--json` (always on — output is a single JSON object).

Behavior: run `refresh_if_stale` (or just `compute_freshness` under a `--check-only` flag),
print the resulting dict as one JSON object to stdout, `sys.exit(0)`. Registry not found /
bad vertical → stderr message + `exit 1`, never a bare traceback.

## 7. Guarantees (asserted in spec 05 tests)

- Registry file is byte-identical + mtime-unchanged after any `read_registry_ref` /
  `compute_freshness` call (read-only proof).
- Fresh fixture (recent `last_checked`) → `is_stale: False`.
- Stale fixture (old/absent `last_checked`) → `is_stale: True` and
  `delta_refresh_command == "python3 .claude/skills/research-pulse/scripts/delta_check.py --vertical aec"`.
- `updated_at` fallback path used when no source has `last_checked`.
- `request_delta_refresh(run=False)` never spawns a subprocess (mock `subprocess.run`, assert not
  called); `run=True` with a mocked script invokes `delta_check.py --vertical <v>` with the muse
  home as cwd.

## 8. Out of scope

- No manifest schema/writes (spec 01). No discovery (spec 02). No re-implementation of polling —
  the ONLY way this module changes external state is by INVOKING the existing `delta_check.py`.
