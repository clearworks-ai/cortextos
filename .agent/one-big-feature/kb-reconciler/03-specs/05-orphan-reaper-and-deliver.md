# Spec 05 — Orphan reaper + deliver

**File:** `knowledge-base/scripts/mmrag.py` (`reconcile` orphan phase + new `deliver` command)
**Repo:** cortextos
**Goal:** Two things Josh hit directly. (a) 37 orphaned empty `agent-comms-check-*` collections (of 53 total) clutter the store and skew `list`/`collections`. (b) He asked THREE times for a file he could open from his laptop and never cleanly got it — retrieval that can't DELIVER is useless.

## Scope (exact)

### 1. Orphan reaper (folded into reconcile)
- Enumerate all collections.
- An "orphan" = an `agent-*` collection with 0 documents (empty), OR an agent-scoped collection whose owning agent no longer exists in the fleet roster.
- Add `reconcile --reap-orphans` (and include it in the nightly full reconcile): delete empty/orphaned agent collections. NEVER delete `shared-*` collections or any non-empty collection.
- Flags: `--dry-run`, `--json`. Report `{orphans_found, orphans_reaped, kept}`.
- Baseline (2026-07-01): ~37 empty `agent-comms-check-*` collections should be reaped; `shared-clearworksai` and any populated agent collection preserved.

### 2. `deliver` command (retrieval → a link Josh can open)
`deliver <source_file_or_query> [--to drive|dashboard] [--json]`:
- Resolve the target: if given a path, use it; if given a query, run `--docs` (spec 04) and take the top document (require `--yes` or interactive confirm if score is low/ambiguous).
- Push the file to a Josh-accessible surface and RETURN A LINK:
  - `--to drive` (default): upload to the Clearworks Google Drive via the existing Drive MCP/officecli path; return the shareable link.
  - `--to dashboard`: publish into the briefs/ops dashboard file surface (reuse the publish-brief mechanism) and return the URL.
- Output: `{delivered_path, destination, link}`. The LINK is the whole point — an agent relays the link to Josh so he opens it on his laptop.
- Do NOT email or post externally without an explicit destination; delivery is to Josh's own surfaces only.

### 3. Wiring
Reaper runs in the nightly reconcile. `deliver` is an on-demand command an agent calls when Josh asks for a file. Document it in the knowledge-base skill so agents reach for `deliver` instead of pasting fragments into Telegram.

## Acceptance
- `reconcile --reap-orphans --dry-run` lists the ~37 empty `agent-comms-check-*` collections and nothing populated; real run deletes exactly those; `shared-clearworksai` untouched; second run reaps 0.
- `deliver <path> --to drive` returns a working Drive link to that exact file.
- `deliver "Logan Currie" --to drive` resolves to Logan's source doc and returns a link (uses spec-04 doc ranking).
- No `shared-*` or non-empty collection is ever deleted.

## Tests (`_test_clients/test_mmrag_orphan_deliver.py`)
- Create empty `agent-test-x` + populated `agent-test-y` + `shared-test` → reap → only `agent-test-x` gone.
- Reap idempotent (second run 0).
- `deliver` path-mode returns a link object with `link` set (Drive/dashboard call mocked in test).
- `deliver` query-mode with a clear top doc resolves to that doc; ambiguous/low-score requires `--yes`.
- Never-delete guard: assert reap refuses a non-empty or `shared-*` collection even if named `agent-*`.

## Constraints
Destructive on local kb store but reproducible (empty collections carry no data). `deliver` external surface (Drive/dashboard) must reuse existing authenticated paths — do NOT hardcode new credentials. No `any`-equivalent, no debug prints. Delivery destinations are Josh's own Drive/dashboard only, never third-party/external.
