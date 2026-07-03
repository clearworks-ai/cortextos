# Master Plan — ci-alert-gate (deterministic CI-failure surface/skip gate)

## Problem (verified live this session, not assumed)
The `comms-check` worker keeps routing the SAME already-resolved CI failure to Larry every ~15 min. Verified 2026-07-03T07:4xZ against live GitHub:
- The failing runs were on `fix/cron-prompt-guard`, head SHA `1c35662` (a TS typecheck error), at 05:25 UTC.
- That was fixed by amending to `3291433`; the two newest CI runs (06:01 UTC) are **success**. PR #39 is OPEN + mergeStateStatus CLEAN.
- The worker's existing Gate C — `gh run list --branch <b> --limit 5 --json conclusion | jq '[.[].conclusion] | any(. == "success")'` — evaluates to **`true`** right now. So the gate *as written* WOULD suppress this alert.

**Conclusion:** the gate logic is not the failure. The failure is that the gates live as three separate prose bash snippets inside `comms-check-worker/SKILL.md` that an ephemeral LLM worker session must assemble and run correctly every cycle — and it does not do so reliably. This is the SAME class as `incident_false_crash_ratelimit_alerts` (LLM substring/heuristic gating producing recurring false positives). The durable fix is to move the decision out of LLM prose and into ONE deterministic CLI command with a binary output, then have the SKILL call that single command.

## Approach
Add a deterministic `cortextos bus ci-alert-gate` subcommand that, given a repo + branch (+ optional head-SHA from the failing email), gathers the live GitHub state via `gh` and prints exactly `SURFACE` or `SKIP` (with `--json` for structured output and a `reason`). The gating decision is a **pure function** so it is unit-testable without network/gh.

Split (mirrors the PR #39 `cron-prompt-validator` shape — pure util + thin I/O + table-driven test):
- `src/utils/ci-alert-gate.ts`:
  - `evaluateCiAlert(input): { surface: boolean; reason: string }` — PURE, deterministic, no I/O. Input = `{ prState, runs, headSha?, compareStatus? }`.
  - `gatherCiAlertContext(repo, branch, opts)` — the ONLY function that shells out (`execFileSync('gh', [...])`, matching `src/bus/catalog.ts`), returns the input object for `evaluateCiAlert`.
- `src/cli/bus.ts`: new `.command('ci-alert-gate')` that calls gather → evaluate → prints `SURFACE`/`SKIP` (+ `--json`).
- `tests/unit/utils/ci-alert-gate.test.ts`: table-driven over `evaluateCiAlert` (pure, no gh).
- SKILL.md prose update (Larry-owned, NOT in codexer scope): replace the three prose gates in `comms-check-worker/SKILL.md` Step 2 check 3 with a single `cortextos bus ci-alert-gate` call.

## Gate semantics (deterministic, tightened per task_1783063709060)
`evaluateCiAlert` returns `surface:false` (SKIP) if ANY of:
1. **PR merged/closed** — `prState` is `MERGED` or `CLOSED` (was Gate A).
2. **Head SHA already in main** — `compareStatus` (from `gh api compare/main...<headSha>`) is `behind` or `identical` (was Gate B). Only evaluated when a headSha is supplied.
3. **Latest run on the branch is not a failure** — of the runs sorted newest-first, the newest *completed* run's conclusion is `success` (or the newest run is still `in_progress`/`queued` with no completed failure newer than the last success). This is the CORE tightening: evaluate the LATEST run per branch/head-SHA, not a loose `any(success)` over the last N. A stale failure that has been superseded by a newer green run is SKIPPED.

Otherwise `surface:true`.

**Fail-safe direction:** if `gh` is missing or errors (auth, network, rate limit), default to **SKIP** and write the reason to stderr. Rationale: these alerts are a redundant convenience layer — real CI health reaches Larry independently via the repo-health cron + Railway CLI/MCP. Failing toward SKIP kills the documented spam; it does not blind the fleet to genuine breakage. This is a stated, deliberate tradeoff, not an oversight.

## Scope
IN:
1. `src/utils/ci-alert-gate.ts` — pure `evaluateCiAlert` + thin `gatherCiAlertContext` (gh via `execFileSync`).
2. `src/cli/bus.ts` — `ci-alert-gate` command (`--repo`, `--branch` required; `--head-sha` optional; `--json` optional). Prints `SURFACE`/`SKIP`; `--json` emits `{ surface, reason }`.
3. `tests/unit/utils/ci-alert-gate.test.ts` — table-driven over the pure evaluator: stale-failure-superseded-by-green → SKIP; merged PR → SKIP; closed PR → SKIP; headSha behind main → SKIP; headSha identical → SKIP; open PR + latest run failure + SHA ahead → SURFACE; the exact PR-#39 scenario (1c35662 failure superseded by 3291433 success) → SKIP.
4. Fail-safe SKIP-on-gh-error path, with a unit test that a context indicating gh-error yields SKIP.

OUT: any change to `send-message` dedup (that is the separate reworded-source-event dedup task `task_1782975510530_74147799`, related but not this scope); any change to the SKILL.md (Larry writes that, it is .md not source); changing repo-health cron behavior.

## Shards
- `03-specs/01-ci-alert-gate.md` — the pure evaluator + banned semantics, the gh gather fn, the CLI command, the fail-safe path, and the tests.

## Acceptance
1. `npm run typecheck` (tsc --noEmit — the CI gate) clean, `npm run build` clean, `npx vitest run tests/unit/utils/ci-alert-gate.test.ts` green.
2. `cortextos bus ci-alert-gate --repo clearworks-ai/cortextos --branch fix/cron-prompt-guard --head-sha 1c35662` prints `SKIP` against the live repo (newest run is green).
3. A synthetic open-PR-with-latest-failure case prints `SURFACE`.
4. Pure `evaluateCiAlert` covers every row in the test table without touching gh.
5. No `any`, no `console.log` in committed source (CLI `console.log` of the SURFACE/SKIP result is the command's stdout contract, which is allowed for a CLI action — matches existing bus commands).

## Risk + mitigation
- **gh unavailable in worker env** → fail-safe SKIP + stderr reason; repo-health cron remains the real CI safety net (documented tradeoff above).
- **Over-suppression hides a real failure** → only suppresses when a NEWER green run exists, or PR merged/closed, or SHA already in main — all states where the failure is genuinely stale. An open PR whose latest run is red still SURFACEs.
- **`gh` output shape drift** → gather fn requests explicit `--json` fields; evaluator consumes typed fields only; a parse failure routes through the fail-safe SKIP path rather than throwing.
