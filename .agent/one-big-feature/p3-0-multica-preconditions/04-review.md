# P3.0 Multica pilot preconditions — Independent Adversarial Review

Reviewer: independent subagent, zero prior context. Every item below was re-derived directly from
primary sources (file reads with line numbers, command output shown) — `02-master-plan.md`'s prose
was not read as ground truth; `03-specs/spec-01-verify.md` was followed as the checklist and every
claim in it was independently reproduced or refuted below.

## VERDICT: PASS — no-diff true-verify outcome. No code change required.

Both P3.0a (reverse-import) and P3.0b (duplicate-create recovery) are genuinely implemented, wired
unconditionally into the live poll/push code paths, and covered by real (not vacuous) tests. Build
is clean, the full multica unit suite is 52/52 green, a live read-only dry-run against real Multica
credentials returns `"errors":0`, and there is no source diff against `main`. No blocking findings.
Two trivial non-blocking line-drift notes only (see Summary).

---

## Checklist items — evidence

### 1. `runReverseImport` exists and is called unconditionally from `runInboundPoll` — CONFIRMED

`src/bus/multica/poll.ts`:
- `export async function runInboundPoll(` — **line 59**, exact match to the spec.
- `function runReverseImport(` — **line 426**, exact match. Real body: builds a `linkedIssueIds`
  set, iterates `issueById.values()`, skips already-linked and terminal (`done`/`cancelled`)
  issues, does crash-window re-link via an in-description `[multica-import:<id>]` marker match
  (lines 450–481), skips import when no `identity` is provided (483–491), and on a genuine new
  orphan calls `createTask` + `applyStatusWriteBack` + `store.upsertLink` inside a `try/catch`
  (505–568). Not a stub, not a `throw new Error(...)`.
- Call site inside `runInboundPoll`: **lines 232–243**, verbatim:
  ```
  runReverseImport(
    paths, config, store, state, busById, issueById, resolvedMatches, result, dryRun,
    options?.importIdentity,
  );
  ```
  This sits directly in the function's linear execution path — not inside any `if`, not commented
  out, not behind a feature flag. It runs immediately before `return result;` at **line 245**
  (exact match to spec). Note: `runReverseImport` is a synchronous `void` function (confirmed at
  its line-426 signature — no `async`, no `Promise` return type), so the call correctly has no
  `await`; this is not a missed-await bug, just a non-async helper.
- **Fail condition check**: none triggered. Call is present, unconditional, not gated, not a stub.

### 2. Orphan-adoption logic in `push.ts` + two guard rails — CONFIRMED

`src/bus/multica/push.ts`:
- `export async function runOutboundPush(` — **line 32**, exact match.
- `OutboundPlanEntry.reason` union — **line 16**:
  `'new_task' | 'hash_changed' | 'hash_unchanged' | 'not_pushable' | 'push_failed' | 'recovered_orphan'`
  — includes `'recovered_orphan'` as claimed.
- Orphan-reconcile block gating condition — **line 128**, verbatim:
  `if (!dryRun && existingIssueId === null && link?.pending_create) {` — exact match to spec.
  Block spans lines 125–181, matching the spec's "roughly 125–181" almost exactly.
- `listAllIssues(client)` fetch, cached once per run in `remoteIssues` (declared line 54,
  `null`-checked at line 131, assigned line 132) — confirmed single-fetch-per-run behavior.
- Match filter/sort — **lines 151–153**, verbatim:
  `remoteIssues.filter((issue) => issue.title === marker.title && !linkedIssueIds.has(issue.id)).sort((a, b) => a.created_at.localeCompare(b.created_at))`
  — exact match, and it does check `linkedIssueIds` (guards against stealing an issue already
  linked to a different task).
- On match, `store.upsertLink(task.id, { multica_issue_id: adopted.id, pending_create: null })` at
  **line 158** — exact match.

**Guard rail A (fetch failure → no create)**: `catch` around `listAllIssues` at **lines 134–149**.
On error: `result.errors += 1`, pushes a `plan` entry with `outcome: 'error'`, `reason:
'push_failed'`, logs a warning, then `continue;` — the comment `// Do NOT create blindly — that is
exactly the duplicate path.` sits at **line 148**, and the actual control flow (a `continue`
inside the `catch`, before any reference to `client.createIssue`) genuinely skips the create for
that task on this run. Confirmed by control flow, not just the comment. Exact line match to spec.

**Guard rail B (adopted-link ledger-write failure → no create)**: `catch` around
`store.upsertLink(task.id, { multica_issue_id: adopted.id, ... })` at **lines 159–174**. On error:
`result.errors += 1`, `plan` entry with `outcome: 'error'`, `reason: 'push_failed'`, warning log,
then `continue;` — comment `// Marker survives; retried next run.` at **line 173**. Control flow
confirmed: the `continue` sits before `existingIssueId = adopted.id;`/`recovered = true;`, so a
failed ledger write on the adopted link genuinely cannot fall through to a create call. Exact line
match to spec.

**Zero-candidates fall-through**: lines 179–181 comment (`// Zero candidates: the prior create
never landed. Fall through to a fresh create...`), and the code below (starting at line 183,
`const action = existingIssueId === null ? 'create' : 'update';`) is reached unconditionally when
`candidates.length === 0` because `existingIssueId` stays `null` — confirming genuinely-lost
creates are retried, not silently dropped. Matches spec's "around lines 179–183".

- **Fail condition check**: neither guard rail is missing; the match logic does check
  `linkedIssueIds`. No steal-vulnerability found. (Bonus: `tests/unit/bus/multica/push.test.ts`
  line 430, `'does not adopt an issue already linked to another task'`, independently exercises
  exactly this guard — not required by the checklist but corroborates it.)

### 3. Re-run the multica unit suite — CONFIRMED, 52/52, exact test names/behavior verified

```
npx vitest run tests/unit/bus/multica/
 Test Files  5 passed (5)
      Tests  52 passed (52)
```
`ls tests/unit/bus/multica/` confirms all 5 expected files by name: `client.test.ts`,
`mapping.test.ts`, `poll.test.ts`, `push.test.ts`, `sync-state.test.ts`. Count matches the spec's
"as of authoring, 52/52" exactly — no drift.

Spot-checked (read full bodies, not just names/counts):
- `tests/unit/bus/multica/poll.test.ts:73` — `describe('runInboundPoll - reverse import', ...)` —
  exact line match. `poll.test.ts:265` — `it('re-links crash-window orphan instead of
  duplicating', ...)` — exact line match. Body (lines 265–311): pre-seeds a bus task carrying a
  `[multica-import:<issueId>]` marker with no ledger link, runs `runInboundPoll`, and asserts
  `result.imported === 0`, `result.resolved_ids === 1`, a single `resolve_id` action, the ledger
  link now points at the correct issue, and — critically — `listTasks(paths)` has length **1**
  (no duplicate task created). This genuinely asserts the crash-window re-link behavior, not a
  vacuous pass.
- `tests/unit/bus/multica/push.test.ts:134` — `describe('multica outbound push', ...)` — exact
  line match. `push.test.ts:360` — `it('does not create a duplicate issue when the ledger write
  fails after a successful create', ...)` — exact line match. Body (lines 360–390): run 1 uses a
  `flakyStore` that fails the post-create `multica_issue_id` ledger write, asserting
  `createdTaskIds` has length 1 and a `pending_create` marker survives; run 2 uses the real store
  and asserts `createdTaskIds` **still has length 1** (no second `createIssue` call), the orphan is
  adopted via an `update` call with `reason: 'recovered_orphan'`, and the ledger link is repaired.
  This is exactly the "run twice, assert no duplicate on run 2" shape the spec describes.
- **Fail condition check**: no test failures, both named tests exist at the cited locations and
  assert real no-duplicate behavior (not just existing).

### 4. Clean build + live dry-run — CONFIRMED

```
npm run build   → "CJS ⚡️ Build success in 118ms" (all entry points built, no errors)
npm run typecheck (tsc --noEmit, extra rigor beyond the spec's literal command) → no output, exit clean
node dist/cli.js bus multica-sync --dry-run
  → {"direction":"both","pushed_creates":131,"pushed_updates":0,"skipped":2446,
     "wrote_back":0,"imported":0,"errors":0,"dry_run":true}
```
`"errors":0` confirmed. `imported:0` is present but per the spec's own framing this is not a
failure — reverse-import correctness is established by item 3's scripted tests, and this run
correctly reflects that there are currently no unlinked Multica-native issues in the live board
(131 pending outbound creates is orthogonal outbound-push volume, not an import-path signal).
- **Fail condition check**: build did not fail; dry-run `errors` is 0, not nonzero.

### 5. Confirm no source diff is needed — CONFIRMED

```
$ git branch --show-current
p3-0-multica-preconditions
$ git status --porcelain src/bus/multica/
(empty)
$ git diff main -- src/bus/multica/
(empty, exit 0)
```
Both commands return empty output exactly as the spec requires.
- **Fail condition check**: neither command shows a diff or untracked change.

---

## Summary of findings

No blocking findings. This is a genuine no-diff true-verify outcome — every claim in
`spec-01-verify.md` reproduced against primary sources with exact or near-exact line-number
matches (all "around line N" citations in the spec landed within 0–3 lines of the actual location,
well inside the spec's own stated tolerance for line drift). Both guard rails in `push.ts` were
verified by tracing actual control flow (not just locating the marker comments), and both named
unit tests were read in full and confirmed to assert genuine no-duplicate behavior rather than
merely existing.

Non-blocking, cosmetic-only observations:
- Spec item 2 says the `listAllIssues` fetch is "around lines 130–133"; the `try` opens at line
  130 but the actual call is at line 132 (inside a `remoteIssues === null` null-check at line
  131). Same block, trivial line-count drift, not a discrepancy in substance.
- Spec item 1 doesn't mention that `runReverseImport` is synchronous (`void`, not
  `Promise<void>`) and therefore correctly called without `await`. Worth noting explicitly in the
  record so a future reviewer doesn't mistake the missing `await` for a bug.

No escalation needed. Recommend recording this as a **PASS / no-diff true-verify outcome**.
