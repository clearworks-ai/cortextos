# cortextOS Upstream Catch-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: **implementify**
> (AllSafe SDD for multi-task plans). Checkbox steps are the execution ledger.

**Goal:** Reconcile the Clearworks fork with `grandamenium/cortextos@6f9383809f7b87a15e9819f83f9a7f147b202883` without losing fork-specific runtime, transport, policy, or safety behavior, then deliver one fully validated pull request for Josh's merge decision.

**Architecture:** Perform one history-preserving, two-parent merge from a clean branch based on `clearworks-ai/cortextos@e000e6867f7ad3849ae207a81724f7c6d3bb3b29`. Resolve the merge as six behavior-oriented slices inside one atomic merge transaction. Preserve the fork's proven transport topology and policies while adopting upstream fixes at named public seams. No shared checkout, live daemon, production state, or external transport is used for validation.

**Tech Stack:** Git, Node.js 20 and 24, TypeScript 6, Vitest 4, tsup, Next.js dashboard build, shell leak guard.

**Seams under test:** Git lineage; bus/state atomicity; daemon/PTY lifecycle; `MessageConnector`; Telegram/Slack/Buzz ingress and egress; template generation parity; CLI lifecycle status; dashboard cron API; CI/leak guard.

## Binding scope

Josh's verbatim request:

> "yes plse make theplan so we can catch up with updstaerm"

This plan is the requested artifact. It is not merge, deployment, restart, or implementation authorization.

## Pinned repository facts

| Ref | SHA | Role |
|---|---|---|
| Fork integration base | `origin/main` = `e000e6867f7ad3849ae207a81724f7c6d3bb3b29` | First parent of the future merge |
| Upstream target | `upstream/main` = `6f9383809f7b87a15e9819f83f9a7f147b202883` | Second parent of the future merge |
| Merge base | `a15baad45cde344f97468ce1b8fe1d012125a415` | Three-way comparison base |
| Local-only `main` | `c544b9d1646d0b192d1589c19a4b9ef5ee1df186` | Three unpushed client-state specification commits; explicitly excluded |

Current divergence from the merge base:

- Fork `origin/main`: 1,004 unique commits and 1,580 changed paths.
- Upstream `main`: 49 unique commits and 235 changed paths.
- Paths changed on both sides: 125.
- Upstream-only paths: 110.
- Predicted textual conflicts from read-only `git merge-tree`: 46 files (see inventory reconciliation: live unmerged at merge-open was **44**; two template `CLAUDE.md` paths auto-merged and were still reviewed under D-07); 34 additional files changed on both sides merge cleanly.

The prior April conflict map is obsolete: it used a different merge base, only 31 upstream commits, and predicted 14 conflicts.

## Global constraints

1. Use a new task-owned worktree and branch based on the pinned `origin/main`; never modify `/Users/joshweiss/cortextos` or any existing worktree.
2. Fetching and read-only comparison are allowed. Do not merge, push, open a PR, restart the daemon, deploy, or mutate live state without the separately authorized execution step.
3. Preserve the 3 local-only `main` commits on their existing lineage; do not silently include them in the catch-up branch.
4. Preserve Clearworks product/tenant isolation, task authority, Telegram chat-first authorization, Herdr receipts, and current agent policy. Generic upstream templates may not overwrite those policies.
5. Never resolve runtime or test conflicts with directory-wide `--ours` or `--theirs`.
6. Every stateful test uses a temporary `CTX_ROOT`; tests must leave tracked files and the inherited process environment untouched.
7. No live Telegram, Slack, Buzz, Gmail, Railway, production database, or daemon process is a test target.
8. The final deliverable is a PR with green CI and an immutable evidence ledger. Merge to `main` remains a separate Josh approval.

## Decisions

- **D-01 — Merge, do not replay.** Use a single `--no-ff` merge of the pinned upstream SHA. Cherry-picking 49 commits would duplicate merge commits, obscure provenance, and make later upstream syncs harder.
- **D-02 — Remote fork main is the base.** Start from `origin/main`, not dirty local `main` and not the current feature checkout.
- **D-03 — Resolve by behavior.** The 46 textual conflicts are grouped into state contracts, lifecycle, connectors, templates, and tests. Each group is validated at its public seam before the merge commit is created.
- **D-04 — Connector topology.** Adopt upstream's `MessageConnector` interface, Telegram adapter, Null adapter, and compatibility shims. Preserve the fork's org-level singleton Slack Socket Mode topology; port upstream fail-closed identity, routing, redaction, and reconnect protections into that topology instead of replacing it with unproven per-agent listener ownership. Preserve Buzz org-level singleton behavior and add upstream reconnect/runtime guards.
- **D-05 — State safety.** Adopt upstream symlink-aware atomic writes, RMW locking, orphaned-lock recovery, honest inbox failure, and transport requeue semantics while preserving fork task, cron, audit, and exactly-once contracts. The separate lifecycle-store stale-handle identity bug remains its own remediation and may not be declared fixed by this merge.
- **D-06 — Lifecycle union.** Preserve fork supervisor receipts, force-fresh handling, wedge recovery, and duplicate-session controls; add upstream dead-map restart, disabled-agent no-resurrection, idempotent start, dormancy, death-confirmed stop, and PTY recovery behavior.
- **D-07 — Local policies win, generic corrections port.** Clearworks-specific `AGENTS.md`, `CLAUDE.md`, and heartbeat policy remain authoritative. Port only upstream's portable fixes and new skill/catalog additions.
- **D-08 — Tests are specifications.** Conflict tests must union non-contradictory assertions from both sides. Do not choose one branch's test file wholesale.
- **D-09 — Open upstream PRs are deferred.** This plan targets only `6f938380`. Before execution, refresh upstream and either repin the plan or record that later open PRs remain outside the batch.

## Module/seam board (detailify)

| ID | Module | Public interface | Stays inside | Seam | Depth note |
|---|---|---|---|---|---|
| M-01 | Git integration transaction | Two-parent merge commit and pinned parent SHAs | Conflict index and resolution staging | `git merge-tree`, merge parents, clean index | Deep: one auditable commit hides 49 upstream commits without erasing provenance |
| M-02 | Bus/state persistence | Bus CLI results, JSON/JSONL state, task/cron/heartbeat APIs | Atomic write, lock, retry, audit implementation | Temporary `CTX_ROOT` filesystem | Deep: callers keep stable commands while persistence hardens |
| M-03 | Agent lifecycle runtime | `AgentManager`, `AgentProcess`, PTY start/stop/recover | Map identity, child process, marker and teardown logic | Fake PTY/process adapters and daemon unit tests | Deep: lifecycle invariants remain behind existing start/stop methods |
| M-04 | Messaging connectors | `MessageConnector`, legacy Telegram shims, Slack/Buzz dispatch | Credentials, socket ownership, routing, redaction, reconnect loops | Connector conformance and transport mocks | Deep if callers do not learn transport-specific internals |
| M-05 | CLI/lifecycle status | CLI commands and redacted status schemas | Status probes, error redaction, option parsing | CLI invocation with temporary state | Deep: operator contracts remain stable across runtime changes |
| M-06 | Agent templates and skills | Generated agent tree and catalog entries | Portable defaults and policy text | Template parity tests | Deep: one template contract drives all generated agent types |
| M-07 | Dashboard cron read model | `GET /api/workflows/crons` | Execution-log caching and transformation | Route tests and dashboard typecheck/build | Small isolated seam; upstream change is one route |

Decisions: D-01 through D-09 · settled_by: detailify · 2026-09-28.

## Slice graph

| ID | Slice (demoable end-to-end) | Blocked by | Tasks |
|---|---|---|---|
| S-00 | Reproducible baseline and immutable conflict ledger | none | 1 |
| S-01 | Merge transaction opened with low-risk surfaces reconciled | S-00 | 2–3 |
| S-02 | Bus, state, CLI, and lifecycle-status contracts pass in a temp root | S-01 | 4 |
| S-03 | Agent lifecycle and PTY recovery matrix passes | S-02 | 5 |
| S-04 | Telegram, Slack, Buzz, and Null transports pass conformance and security tests | S-03 | 6 |
| S-05 | Templates, tests, dashboard, build, and leak guard pass without tracked-state mutation | S-04 | 7–8 |
| S-06 | Auditable merge commit and PR ready for Josh's decision | S-05 | 9 |

## File map

### Exact predicted textual conflicts (46)

Plan-time `git merge-tree` listed 46 paths. **Live `git merge --no-ff --no-commit` unmerged set was 44.** The two-path drift is not a missing resolution:

| Path | Plan (46) | Live merge-open |
|---|---|---|
| `templates/agent/CLAUDE.md` | textual conflict | auto-merged; reviewed under D-07 (fork policy kept, portable quoting ported) |
| `templates/orchestrator/CLAUDE.md` | textual conflict | auto-merged; same D-07 treatment |

The other 44 match the baseline ledger (`docs/pipeline/evidence/2026-09-28-upstream-baseline.md`). After Tasks 3–4 staged 20 of those 44, **24** remained unmerged (handoff arithmetic: 44 − 20 = 24) until Tasks 5–7 resolved them. Acceptance “all 46” means: 44 explicit conflict resolutions + 2 auto-merged CLAUDE.md files still checked under D-07. Evidence: `docs/pipeline/evidence/2026-09-28-conflict-inventory-reconciliation.md`.

**Root/state safety (2):** `.gitignore`, `src/utils/atomic.ts`

**Bus and CLI contracts (10):** `src/bus/cron-state.ts`, `src/bus/heartbeat.ts`, `src/bus/task.ts`, `src/cli/add-agent.ts`, `src/cli/bus.ts`, `src/cli/buzz.ts`, `src/cli/index.ts`, `src/cli/restart.ts`, `src/cli/status.ts`, `src/types/index.ts`

**Lifecycle runtime (6):** `src/daemon/agent-manager.ts`, `src/daemon/agent-process.ts`, `src/daemon/cron-scheduler.ts`, `src/daemon/fast-checker.ts`, `src/daemon/ipc-server.ts`, `src/pty/opencode-pty.ts`

**Connectors (7):** `bus/send-slack.sh`, `docs/runbook/slack-adapter-setup.md`, `src/buzz/relay-client.ts`, `src/slack/api.ts`, `src/telegram/api.ts`, `src/telegram/logging.ts`, `src/telegram/poller.ts`

**Skills and templates (10):** `community/catalog.json`, five `community/skills/cortext-self-diagnosis/**` files, `templates/agent/{AGENTS.md,CLAUDE.md}`, `templates/orchestrator/{AGENTS.md,CLAUDE.md}`

**Tests (11):** `tests/unit/bus/{message,task}.test.ts`, `tests/unit/buzz/relay-client.test.ts`, `tests/unit/cli/{add-agent-codex,restart-command}.test.ts`, `tests/unit/daemon/{agent-manager-inspect-op,agent-manager-map-entry-race,agent-process,cron-scheduler,fast-checker-buzz,fast-checker}.test.ts`

### Important clean overlaps and upstream additions

- State/runtime: `src/utils/lock.ts`, `src/utils/dormancy.ts`, `src/bus/{crons,event,message,metrics}.ts`, `src/pty/{agent-pty,codex-app-server-pty}.ts`.
- Connector architecture: `src/connectors/**`, Telegram compatibility shims, upstream Slack routing/redaction/socket files, and lifecycle status modules under `src/lifecycle/**`.
- Packaging: `package.json`, `package-lock.json`, schemas, lifecycle scripts, and `scripts/opencode-usage.*`.
- Dashboard: `dashboard/src/app/api/workflows/crons/route.ts`.
- Portable skills: Claude-to-Codex migration and Cortext self-diagnosis bundles plus template copies.

## Task 1: Freeze refs and establish the fork baseline

**Slice:** S-00
**Seam:** M-01 Git lineage and CI baseline
**Files:** Create `docs/pipeline/evidence/2026-09-28-upstream-baseline.md`; no production source changes
**Interfaces:**
- Consumes: `origin/main`, `upstream/main`, the merge base, repository test commands.
- Produces: immutable SHA ledger, baseline test ledger, and exact 46-file conflict inventory.

- [ ] Create a fresh execution worktree only after implementation is authorized:

```bash
git -C /Users/joshweiss/cortextos fetch origin
git -C /Users/joshweiss/cortextos fetch upstream
git -C /Users/joshweiss/cortextos worktree add \
  -b integrate/upstream-6f938380-20260928 \
  /Users/joshweiss/code/cortextos-worktrees/upstream-integration-6f938380 \
  e000e6867f7ad3849ae207a81724f7c6d3bb3b29
```

- [ ] Assert refs have not drifted. If either assertion fails, stop and regenerate the plan rather than silently widening scope:

```bash
test "$(git rev-parse HEAD)" = e000e6867f7ad3849ae207a81724f7c6d3bb3b29
test "$(git rev-parse upstream/main)" = 6f9383809f7b87a15e9819f83f9a7f147b202883
test "$(git merge-base HEAD upstream/main)" = a15baad45cde344f97468ce1b8fe1d012125a415
```

- [ ] Install deterministically and run the complete pre-merge baseline:

```bash
npm ci
npm ci --prefix dashboard
npm run typecheck
npm run build
npm test
npm run test:codex
(cd dashboard && npx tsc --noEmit && npm run build)
bash .github/scripts/leak-guard.sh --tree HEAD
bash tests/leak-guard.test.sh
```

- [ ] Record exact pass/fail counts and `git status --porcelain` before and after tests. Any tracked-file mutation or secret-shaped failure output blocks the merge and routes to the existing remediation tasks.
- [ ] Commit only the baseline evidence file:

```bash
git add -f docs/pipeline/evidence/2026-09-28-upstream-baseline.md
git commit -m "docs(upstream): freeze catch-up baseline"
```

Expected result: a clean, reproducible fork baseline or an explicit prerequisite blocker. No upstream merge has started.

## Task 2: Open the pinned merge transaction

**Slice:** S-01
**Seam:** M-01 Git integration transaction
**Files:** Merge index only
**Interfaces:**
- Consumes: the green baseline commit and pinned upstream SHA.
- Produces: one uncommitted merge transaction with exactly the predicted conflict set.

- [ ] Start the merge without committing:

```bash
git merge --no-ff --no-commit 6f9383809f7b87a15e9819f83f9a7f147b202883 || true
git diff --name-only --diff-filter=U | sort > /tmp/cortextos-upstream-unmerged.txt
test "$(wc -l < /tmp/cortextos-upstream-unmerged.txt | tr -d ' ')" = 46
```

- [ ] Compare `/tmp/cortextos-upstream-unmerged.txt` with the plan inventory. **Live pin: 44 unmerged paths**, not 46. The two extras (`templates/agent/CLAUDE.md`, `templates/orchestrator/CLAUDE.md`) auto-merge; still apply D-07. Unexpected extra or missing paths stop the run for replanning.
- [ ] Do not commit. The merge remains one atomic transaction until Task 8.

Expected result: upstream-only and cleanly merged changes are staged automatically; 46 known files remain unresolved.

## Task 3: Reconcile root, packaging, dashboard, skills, and templates

**Slice:** S-01
**Seams:** M-06 template parity; M-07 dashboard cron API
**Files:** `.gitignore`, `package*.json`, `community/**`, `templates/**`, `dashboard/src/app/api/workflows/crons/route.ts`, schemas and upstream scripts
**Interfaces:**
- Consumes: upstream portable defaults and fork policy templates.
- Produces: merged package graph, catalog, portable skills, template policy, and dashboard route.

- [ ] Resolve `.gitignore` as a union; never re-track secrets, runtime databases, caches, or generated deployment artifacts.
- [ ] Preserve fork policy text in `AGENTS.md`/`CLAUDE.md`; manually port upstream date-format quoting and other portable corrections. Add upstream migration/self-diagnosis bundles and catalog entries without overwriting the fork's richer versions.
- [ ] Reconcile `package.json`, then regenerate only the lockfile:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
npm ci --prefix dashboard
```

- [ ] Validate the slice:

```bash
npx vitest run tests/unit/cli/add-agent-template-parity.test.ts tests/sprint1-templates.test.ts
(cd dashboard && npx tsc --noEmit && npm run build)
git diff --check
```

- [ ] Stage resolved files; do not commit while other conflicts remain:

```bash
git add .gitignore package.json package-lock.json community templates dashboard schemas scripts
```

Expected result: template parity and dashboard build pass; remaining unmerged files are confined to bus/runtime/connectors/tests.

## Task 4: Reconcile bus, state, CLI, and lifecycle-status contracts

**Slice:** S-02
**Seams:** M-02 bus/state persistence; M-05 CLI/lifecycle status
**Files:** `src/bus/**`, `src/cli/**`, `src/types/index.ts`, `src/utils/{atomic,lock,dormancy,validate}.ts`, `src/lifecycle/**`, associated schemas/scripts/tests
**Interfaces:**
- Consumes: fork task/cron/event semantics and upstream atomicity/status fixes.
- Produces: stable bus commands, safe state writes, redacted lifecycle status, and unchanged task identity.

- [ ] Resolve public types first. Preserve existing fork fields; add upstream connector, lifecycle-status, internal-only agent, metric, and heartbeat opt-in fields without weakening validation.
- [ ] Implement D-05 explicitly: symlink-aware atomic replacement; per-file RMW locks; bounded orphan recovery; honest inbox errors; failed transport requeue; opt-in heartbeat refresh.
- [ ] Preserve fork task audit/dependency/claim semantics and full task IDs. Never infer completion or liveness from a failed read.
- [ ] Run targeted red-green tests in a temporary root:

```bash
export CTX_ROOT="$(mktemp -d)"
npx vitest run \
  tests/unit/bus/event.test.ts \
  tests/unit/bus/message.test.ts \
  tests/unit/bus/task.test.ts \
  tests/unit/cli/task-table.test.ts \
  tests/integration/cli-error-boundary.test.ts \
  tests/integration/crons-migration.test.ts
node scripts/verify-lifecycle-status-cli.mjs
```

- [ ] Stage this module family without committing:

```bash
git add src/bus src/cli src/types src/utils src/lifecycle schemas scripts tests/unit/bus tests/unit/cli tests/integration
git diff --check
```

Expected result: bus/CLI tests pass in isolated state, lifecycle output is redacted, and no task or heartbeat semantics regress.

## Task 5: Reconcile daemon and PTY lifecycle behavior

**Slice:** S-03
**Seam:** M-03 agent lifecycle runtime
**Files:** `src/daemon/{agent-manager,agent-process,cron-scheduler,fast-checker,ipc-server}.ts`, `src/pty/**`, `src/utils/dormancy.ts`, corresponding daemon/PTY tests
**Interfaces:**
- Consumes: fork supervisor/recovery behavior and upstream race/wedge fixes.
- Produces: one coherent start/stop/restart state machine with no duplicate PTY, resurrection, or false liveness.

- [ ] Build a behavior matrix before resolving code. It must include: dead mapped agent restart; disabled agent no-resurrection; duplicate start idempotency; map-entry identity; force-fresh consumption only after successful spawn; exit-0 OpenCode wedge recovery; confirmed-dead stale reap; dormancy detection; context-handoff suppression; death-confirmed stop; exact teardown of pollers/connectors/checkers.
- [ ] Resolve methods by matrix row. Never choose the 1,987-line fork or 897-line upstream `agent-manager.ts` wholesale.
- [ ] Keep mocked child-process environments allowlisted and failure serialization redacted. All fixture roots must be temporary.
- [ ] Run the targeted lifecycle suite on Node 20 and Node 24:

```bash
npx vitest run \
  tests/unit/daemon/agent-manager*.test.ts \
  tests/unit/daemon/agent-process*.test.ts \
  tests/unit/daemon/cron-scheduler.test.ts \
  tests/unit/daemon/fast-checker*.test.ts \
  tests/unit/pty/*.test.ts \
  tests/unit/utils/dormancy.test.ts
```

- [ ] Repeat race-sensitive files 100 times in an isolated Linux runner. A single failure blocks the slice.
- [ ] Assert tests did not mutate tracked cron fixtures or serialize credential-shaped environment keys.
- [ ] Stage the resolved runtime and tests; do not commit:

```bash
git add src/daemon src/pty src/utils/dormancy.ts tests/unit/daemon tests/unit/pty tests/unit/utils
git diff --check
```

Expected result: the lifecycle matrix is green on both supported Node families with clean tracked state.

## Task 6: Reconcile Telegram, Slack, Buzz, and connector architecture

**Slice:** S-04
**Seam:** M-04 `MessageConnector` and transport mocks
**Files:** `src/connectors/**`, `src/telegram/**`, `src/slack/**`, `src/buzz/**`, `bus/send-{slack,buzz}.sh`, transport runbooks and tests
**Interfaces:**
- Consumes: upstream connector interface/security fixes and fork transport topology/idempotency.
- Produces: compatible Telegram/Null adapters plus preserved, hardened Slack and Buzz transports.

- [ ] Adopt upstream `MessageConnector`, `TelegramConnector`, `NullConnector`, factory allowlist, and deep legacy Telegram shims.
- [ ] Preserve one shared Telegram API instance between connector and legacy paths.
- [ ] Preserve the fork's org-level singleton Slack Socket Mode ownership. Port upstream agent-name identity gates, fail-closed routing, redaction, auth-dead stop, reconnect handling, and Node WebSocket capability guard behind the fork dispatcher.
- [ ] Preserve fork Buzz org-level singleton registration and routing; add upstream reconnect-hang and unsupported-Node guards.
- [ ] Keep all transport credentials out of logs and test output.
- [ ] Validate with mocks only:

```bash
npx vitest run \
  tests/unit/connectors/*.test.ts \
  tests/unit/telegram/*.test.ts \
  tests/unit/slack/*.test.ts \
  tests/unit/buzz/*.test.ts \
  tests/unit/daemon/fast-checker-buzz.test.ts
```

- [ ] Stage connectors and tests; do not commit:

```bash
git add src/connectors src/telegram src/slack src/buzz bus/send-slack.sh bus/send-buzz.sh docs/runbook tests/unit/connectors tests/unit/telegram tests/unit/slack tests/unit/buzz
git diff --check
```

Expected result: connector conformance, routing, redaction, retry, deduplication, and compatibility tests all pass without external network traffic.

## Task 7: Reconcile conflicted tests as union specifications

**Slice:** S-05
**Seams:** M-02 through M-06
**Files:** the exact 11 conflicted test files plus any new regression tests required by Tasks 4–6
**Interfaces:**
- Consumes: resolved public behavior and both branches' non-contradictory assertions.
- Produces: one test contract that detects loss of either fork or upstream behavior.

- [ ] For each conflicted test file, enumerate fork-only and upstream-only assertions before editing.
- [ ] Keep both assertion sets unless a documented D-## decision makes them mutually exclusive; then test the chosen contract and cite the decision in the test name or comment.
- [ ] Add explicit regressions for:
  - tracked fixtures unchanged after the suite;
  - environment values redacted from failures;
  - stale lock handles cannot delete replacement locks;
  - disabled agents stay disabled;
  - duplicate PTYs close only after confirmed death;
  - Slack/Buzz routing fails closed.
- [ ] Prove no unresolved entries or conflict markers remain:

```bash
test -z "$(git diff --name-only --diff-filter=U)"
! git grep -nE '^(<<<<<<<|=======|>>>>>>>)'
npm run typecheck
```

- [ ] Stage the final test resolutions; do not commit yet:

```bash
git add tests
git diff --cached --check
```

Expected result: every conflict is resolved and the index represents one coherent combined behavior.

## Task 8: Run full verification and create the atomic merge commit

**Slice:** S-05
**Seams:** All
**Files:** Entire merged tree; create `docs/pipeline/evidence/2026-09-28-upstream-merge-verification.md`
**Interfaces:**
- Consumes: fully resolved merge index.
- Produces: green evidence ledger and a two-parent merge commit.

- [ ] Capture a pre-test tracked-state fingerprint:

```bash
git diff --name-only > /tmp/pre-test-worktree.txt
git diff --cached --name-only > /tmp/pre-test-index.txt
```

- [ ] Run the exact release gate:

```bash
npm ci
npm ci --prefix dashboard
npm run typecheck
npm run build
npm test
npm run test:codex
(cd dashboard && npx tsc --noEmit && npm run build)
bash tests/leak-guard.test.sh
node dist/cli.js --help
```

Before the merge commit exists, scan the staged integration payload itself:

```bash
git diff --cached --name-only --diff-filter=ACMR -z | \
  xargs -0 .github/scripts/leak-guard.sh
```

- [ ] Recompute the tracked-state fingerprint. Test-generated changes are failures, not cleanup chores.
- [ ] Record commands, versions, durations, pass counts, and SHA-256 hashes in the verification ledger.
- [ ] Create exactly one merge commit:

```bash
git add -f docs/pipeline/evidence/2026-09-28-upstream-merge-verification.md
git commit -m "merge(upstream): reconcile through 6f938380"
test "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = 3
test "$(git rev-parse HEAD^2)" = 6f9383809f7b87a15e9819f83f9a7f147b202883
bash .github/scripts/leak-guard.sh --tree HEAD
```

Expected result: one auditable merge commit with upstream as its second parent, full green verification, and a clean worktree.

## Task 9: Independent review, push, and open the PR

**Slice:** S-06
**Seams:** M-01 lineage and all release gates
**Files:** No new product files unless review finds a defect
**Interfaces:**
- Consumes: immutable merge SHA and evidence ledger.
- Produces: reviewed PR against `clearworks-ai/cortextos:main`.

- [ ] Run `reviewify` against parent 1 of the merge. Review must check scope, conflict resolutions, local invariant preservation, upstream behavior coverage, and any silent dropped assertions.
- [ ] Repair findings on the same task branch, rerun affected tests and the full gate, and obtain a clean independent re-review.
- [ ] Push the task branch and open a PR; never push directly to `main`. PR body is the consolidated final verification ledger (historical Task 8 / review-repair ledgers stay on disk and are not the `--body-file`):

```bash
git push -u origin integrate/upstream-6f938380-20260928
gh pr create \
  --repo clearworks-ai/cortextos \
  --base main \
  --head integrate/upstream-6f938380-20260928 \
  --title "merge(upstream): catch up through 6f938380" \
  --body-file docs/pipeline/evidence/2026-09-28-upstream-final-verification.md
```

- [ ] Require Build & Type Check, Unit Tests, Codex parity, Dashboard Build, and Operational-leak scan to pass on the immutable PR SHA.
- [ ] Return the PR, merge SHA, parent SHAs, conflict-resolution ledger, and CI links to Josh. Stop for explicit merge approval.

Expected result: a green, review-clean PR; no merge or deployment.

## Open-upstream watchlist

These are not in `6f938380` and must not be silently folded into this batch. Refresh their status before implementation:

- #1018 first-run/credit-meter prompt handling
- #1010 timing-flake hardening
- #1009 lifecycle-status/git-maintenance race
- #1008 heredoc injection hardening
- #1005 orphaned Codex app-server child reap
- #1002 upstream-ahead false-positive
- #994 daemon roster authority
- #972 per-agent liveness watchdog
- #971 Agent City dashboard and instruction fixes
- #963 theta-wave learning persistence

If any lands before Task 1, repin upstream and regenerate the conflict ledger rather than appending it opportunistically.

## Rollback

- Before merge approval: close the PR and delete only the task-owned branch/worktree. The fork mainline and live runtime are unchanged.
- After an approved Git merge but before deployment: revert the merge with `git revert -m 1 <merge_sha>` through a new reviewed PR.
- Any future runtime deployment must be a separate authorized task with a pre-deploy build snapshot, exact runtime receipt, and rollback command. This plan authorizes none of those actions.

## Acceptance criteria

1. The merge commit has exactly two parents; parent 2 is `6f938380`.
2. All 46 planned conflict paths have an explicit resolution or a recorded auto-merge + D-07 review (live unmerged = 44; two CLAUDE.md auto-merged). No conflict markers remain.
3. Upstream connector, state-safety, lifecycle, CLI, metrics, dashboard, migration, diagnosis, and usage-script behavior is present.
4. Fork task semantics, policy, Herdr receipts, transport topology, supervisor recovery, and product/tenant boundaries remain present.
5. Full CI and leak guard pass on the immutable PR SHA under Linux; Node 20 is mandatory and Node 24 lifecycle/connector coverage also passes.
6. Tests leave tracked files unchanged and never serialize credential-shaped environment values.
7. No shared checkout, live daemon, production service, external transport, or main branch was mutated during validation.
8. Josh receives one PR and evidence ledger for a separate merge decision.

## Task-count gate

Six independent risk families are being integrated: lineage/packaging, state/CLI, lifecycle/PTY, connectors, templates/dashboard, and test/release validation. This plan has 9 tasks: **1.5 tasks per risk family**, below the 3x bug-fix ceiling and well below the 30-task feature split threshold.
