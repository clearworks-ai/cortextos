# 02 — Master Plan: staging-verify-loop

Slug: `staging-verify-loop` · Target: cortextOS `src/pipeline/staging-verify/` · Implementer: codexer (this doc + 03-specs are the full scope).

## Goal
A driver CLI (`bin/staging-verify`) that, given `--slug --repo --build-output`, runs the full simulated-human staging loop end-to-end and — only on total success — emits the signed `staging-verify` ledger row that `gate-pr-push.sh:47-57` consumes. Failure = no emit, gate keeps blocking.

## Module boundaries (all new files unless noted)

```
bin/staging-verify                          # bash shim, mirrors bin/pipeline-stage-emit (dist-first, tsx fallback)
src/pipeline/staging-verify/
  cli.ts            # arg parse + orchestration entry (spec-01)
  types.ts          # shared interfaces: RepoConfig, Scenario, RunContext, StepResult, Evidence (specs 01–04)
  repos.ts          # default 5-repo registry + config-file override loader (spec-01)
  runner.ts         # the loop/retry state machine (spec-01 + spec-03 bounds)
  deploy.ts         # Railway staging deploy + migrate + seed adapter (spec-02)
  railway.ts        # thin spawn wrapper around the railway CLI, env-pinned (spec-02)
  drive.ts          # human-drive engine: fetch + cookie jar + scenario steps (spec-03)
  state-read.ts     # real end-state readers: JSON API + railway-run DB query (spec-03)
  verify.ts         # runs the repo's real verify command, captures exit/output (spec-03)
  evidence.ts       # evidence schema, redaction, atomic write (spec-04)
  emit.ts           # shells out to bin/pipeline-stage-emit; preflight review-chain check (spec-04)
tests/unit/pipeline/staging-verify/
  runner.test.ts  drive.test.ts  evidence.test.ts  repos.test.ts  emit.test.ts
tests/integration/staging-verify-loop.test.ts   # fixture HTTP server + fake railway binary + real emitLedgerRow
```

Dependency rule: only Node stdlib (`child_process`, `crypto`, `fs`, `path`, global `fetch`) + existing repo modules (`src/pipeline/ledger.ts` types, `src/utils/lock.ts`). No new package.json entries.

## The loop / retry state machine (implemented in runner.ts; bounds in spec-03)

States, in order — each returns `ok | transient | fatal`:

```
PREFLIGHT → APPLY → DEPLOY → MIGRATE → SEED → DRIVE → READ_STATE → VERIFY → EVIDENCE → EMIT → TEARDOWN
```

- **PREFLIGHT** (no retry): repo config resolves; staging env exists (`railway environment list`); signed `review` row exists for slug (`pipeline-stage-emit --verify --through review`, avoids a doomed deploy — ledger.ts:346 requires review before staging-verify); build-output path exists → sha256 computed.
- **APPLY**: check out / hard-reset a staging worktree of the target repo to the build output (branch or patch).
- **DEPLOY**: `railway up` into the staging env; capture assigned `staging_url`; poll health until 200-JSON or timeout. Transient on timeout/5xx.
- **MIGRATE / SEED**: adapter commands via `railway run --environment staging` (spec-02). Seed is synthetic-fixture only.
- **DRIVE**: scenario steps over real HTTP with an auth session (spec-03). Per-step transient classification (network/5xx = transient; 4xx/assertion = fatal).
- **READ_STATE**: query staging DB (via `railway run` in-repo script) or JSON API; evaluate numeric assertions expected-vs-actual.
- **VERIFY**: run the repo's real verify command; exit must be 0. Non-zero = fatal (a broken build is not a flake).
- **EVIDENCE**: write evidence JSON (success or failure variant) — always written, even on failure.
- **EMIT**: only reached when every prior state is `ok`; calls `bin/pipeline-stage-emit --stage staging-verify` (spec-04).
- **TEARDOWN** (`finally`): delete the on-demand staging service unless `--keep-deploy`.

Retry policy: `transient` → rewind to DEPLOY (fresh deploy) and re-run forward, up to `--max-attempts` (default 3, hard cap 5). `fatal` → stop immediately, write failure evidence, exit non-zero. This is the whole "self-serving loop": self-correction = bounded re-deploy + re-drive, never assertion-loosening.

## How it deploys to Railway staging (spec-02)
Every railway invocation goes through `railway.ts` which (a) always passes explicit `--environment <staging-env>` — never trusts linked state; (b) refuses to run if the resolved env equals the prod env; (c) runs with cwd = the staging worktree. Deploy = `railway up --ci` (non-interactive), URL parsed from output / `railway status --json`, then health-polled. Secrets stay inside Railway env — the tool never reads them into evidence or logs.

## How it reads real end-state (spec-03)
Two readers, both honoring the never-scrape-HTML rule (larry CLAUDE.md Website Accuracy Rule):
1. **JSON API**: `GET`/`POST` to the app's own endpoints with the authed session; assert on parsed JSON fields (numbers/ids), verified `content-type: application/json`.
2. **DB query**: `railway run --environment staging -- node <repo-local query script>` executed inside the target repo (its own drizzle/pg deps), printing one JSON line the tool parses. For gws-security (Python): `railway run ... -- uv run python -c '<query>'`.
Assertions are `{name, source: 'db'|'json-api', query/endpoint, expected, actual, pass}` — numbers, recorded verbatim in evidence.

## How it emits the signed row (spec-04)
`emit.ts` spawns `bin/pipeline-stage-emit --slug <slug> --stage staging-verify --artifact <build-output> --evidence <evidence.json> --runner <runner (default staging-verify-loop)> [--ledger --secret passthrough]`. staging-verify is non-authored (ledger.ts:134) so no transcript args. Success = exit 0 + parsed row JSON echoed. Then a self-check: `--verify --slug <slug> --through staging-verify --max-age 86400` must exit 0 with non-empty `evidence_path` — i.e. the exact command the gate runs (gate-pr-push.sh:48) — before the CLI reports success.

## Testing strategy
- **Unit** (vitest, no network): runner state machine transitions + retry bounds (injected fake stage fns); drive engine against `node:http` local server (cookie persistence, redirect, transient classification); evidence schema validation + redaction + failure-variant; repos registry + config override; emit arg construction (injected spawn).
- **Integration** (`tests/integration/staging-verify-loop.test.ts`): fake `railway` shell script on PATH (records calls, serves canned `status --json`, "runs" migrate/seed), fixture Express-less `node:http` app with login + form + `/api/state` JSON, temp ledger + secret; full run must produce evidence + a real signed row that `verifyChainDetailed --through staging-verify` accepts (reuse the chain-builder pattern from `tests/unit/pipeline/hook-gates.test.ts`).
- **Gate compatibility regression**: extend `tests/unit/pipeline/hook-gates.test.ts` pattern — a row emitted by this tool passes the gate's exact verify invocation.
- **Live acceptance** (larry-run, not CI): one real run against clearpath staging for a trivial slug; gate-pr-push dry-run passes.

## Phased task list → specs
| Phase | Task | Spec |
|---|---|---|
| P1 | `types.ts`, `repos.ts`, `cli.ts`, `runner.ts` skeleton + PREFLIGHT + unit tests | spec-01 |
| P2 | `railway.ts`, `deploy.ts` (APPLY/DEPLOY/MIGRATE/SEED/TEARDOWN) + unit tests | spec-02 |
| P3 | `drive.ts`, `state-read.ts`, `verify.ts` + retry classification + unit tests | spec-03 |
| P4 | `evidence.ts`, `emit.ts`, `bin/staging-verify` shim + integration test + gate-compat test | spec-04 |
| P5 | Live acceptance run on clearpath staging (larry, not codexer) + PIPELINE-STAGING.md update to point at the tool | — |

Order is strict; each phase lands green (`npm run typecheck` + `npm test`) before the next.
