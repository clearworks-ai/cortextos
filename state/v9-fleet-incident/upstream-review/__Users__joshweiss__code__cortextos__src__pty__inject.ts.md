# Deep pass: src/pty/inject.ts (fork vs upstream/main)

Analyzed: 2026-08-02 (M1 backfill — this file was cited in _SYNTHESIS but had no review doc). Upstream ref = `upstream/main` @ `dfedf9b`.

Divergence at analysis time: **+14 / -1 lines** — a single semantic unit: `MessageDedup.remove()` + a private `hashContent()` refactor, introduced by `b3fca59` 2026-07-05 ("fix(dispatch): opencode silent-drop — inject-then-ACK, dedup rollback, retry, dead-letter (#69)").

## D1. Orphaned #69 dedup-rollback primitive — DEAD-CODE DIVERGENCE (drift confirmed, caller gone)

- **Introduced:** `b3fca59` (#69, 2026-07-05). #69 was a 4-file mechanism: `injectMessageDetailed()` returned a `delivery: Promise<boolean>`, `AgentPTY.injectMessage`/`OpencodePTY.injectMessage` returned delivery booleans, agent-process rolled back the dedup hash via `this.dedup.remove(content)` on failed delivery, and fast-checker retried + dead-lettered.
- **Dropped:** the rebaseline-stripdown **evil merge `1011619` (PR #172, 2026-07-31)** removed the *entire* caller side. Verified: `git log -m -S "dedup.remove" --first-parent -- src/daemon/agent-process.ts` shows only `b3fca59` (add) and `1011619` (merge removal); plain `git log -S` misses it because the removal lives in a merge. Post-seam state: `agent-process.ts` injectMessageDetailed == upstream (fire-and-forget, `:335-361` upstream), `opencode-pty.ts` diff-empty vs upstream, `fast-checker.ts` diff-empty (M8). Only the `remove()`/`hashContent()` primitive in inject.ts survived — **zero production callers** (grep `\.remove(|hashContent` over src/ hits only inject.ts itself) — plus one orphan unit test (`tests/unit/pty/inject.test.ts:27-30`).
- **Consequence of the seam:** the silent-retry-drop window #69 closed is re-open — an injection that fails after `isDuplicate()` records the hash leaves the content permanently DEDUPED, so any retry of the same content is silently swallowed. Note this window is **upstream-shared**: upstream records the hash before writing and returns `ok:true` without delivery confirmation (upstream agent-process.ts:340-350). 60-100 upstream installs run this shape stably.

## Verdict: CONVERGE-TO-UPSTREAM (applied)

Per the convergence discipline (fork-only fix is first assumed to band-aid a fork-inflicted exposure):
1. The #69 exposure came from the fork's own dispatch machinery (fast-checker/cron retry pressure on opencode agents), not an upstream defect upstream users hit.
2. A re-land is not a one-line restore — it requires re-diverging 4 currently-converged files (incl. fast-checker.ts, the review's only diff-empty exoneration) and the 2026-07-05 plumbing predates pty-host (`4c3fe4f` 07-23): a sync "write succeeded" now proves even less, since writes travel async IPC to the pty-host child. A naive re-land would be stale machinery giving false delivery confidence.
3. Keeping a caller-less `remove()` is exactly the dead-divergence class the plan deletes elsewhere (agent-session-isolation.ts precedent).

**Applied:** `src/pty/inject.ts` and `tests/unit/pty/inject.test.ts` reset byte-identical to `upstream/main` (verified with `diff` against `git show upstream/main:<file>` — exit 0 both).

**Re-land trigger (recorded, not scheduled):** if live silent-drop evidence recurs post-rebaseline (a dispatched item ACKed but never seen in the agent transcript), re-land #69 as a *deliberate ADD* designed against the pty-host protocol — delivery confirmation must come from the pty-host side (e.g. echo/ack in pty-ipc), not from a local synchronous write return.

Everything else in the file (bracketed-paste injector incl. the guarded deferred-Enter try/catch, KEYS, selectOption, toggleAndSubmit) is upstream-shared — not fork surface.
