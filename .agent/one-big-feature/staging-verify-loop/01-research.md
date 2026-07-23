# 01 — Research: staging-verify-loop (automated producer of signed staging-verify evidence)

Slug: `staging-verify-loop` · Repo: cortextOS (`/Users/joshweiss/code/cortextos`) · Framework: one-big-feature

## 1. Current state — the gate exists, the producer does not

### The consumer (LIVE)
`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh`
- Fires on any `gh pr create` (line 24). Parses a leading `cd <dir>` to evaluate the TARGET repo, not the hook cwd (lines 30–33).
- Derives `SLUG` from the branch tail (lines 35–38), matches origin against the 5 prod repos: `clearpath | cxportal | nonprofit-hub | auditos | gws-security` (lines 42–45).
- For a prod repo it runs `bin/pipeline-stage-emit --verify --slug <slug> --through staging-verify --max-age 86400` (line 48) and BLOCKS unless that exits 0 (lines 50–52) AND the terminal row's `evidence_path` is non-empty on disk (lines 54–56, `jq .evidence_path` + `-s` check).
- Then separately requires a fresh `true-verify` row for every PR (lines 59–67).

### The evidence format + provenance rules (LIVE)
`/Users/joshweiss/code/cortextos/src/pipeline/ledger.ts`
- `STAGES` (lines 15–25) includes `staging-verify` at rank 6 (line 332).
- `staging-verify` is **NOT** in `AUTHORED_STAGES` (line 134: only `synthesize, plan, specs, review`) → **no transcript/session provenance required**. It is a runner+evidence stage.
- `emitLedgerRow` (lines 844–957): for `staging-verify` (and `true-verify`) it hard-requires a non-empty `--evidence` file (lines 871–875). Chain rule `allowedPreviousStages('staging-verify') = ['review']` (line 346) — a signed `review` row for the slug MUST already exist or emit throws `CHAIN_BREAK` (lines 922–929). `staging-verify` is an allowed predecessor of `true-verify` (line 347).
- `verifyChainDetailed` (lines 1032–1182): walks sig-verified rows back to `research`, enforces stage-rank monotonicity + increasing ts, staleness vs `--max-age` (lines 1158–1165). Signing = HMAC-SHA256 over `canonicalPayload` (lines 260–278) with the secret at `~/.pipeline-secret` (line 423). Ledger default: `<projectRoot>/state/pipeline-ledger.jsonl` (line 419).

### The CLI shim (LIVE)
`/Users/joshweiss/code/cortextos/bin/pipeline-stage-emit` → `dist/pipeline/stage-emit.js` or tsx `src/pipeline/stage-emit.ts`. Emit path: `src/pipeline/stage-emit.ts` lines 137–161; verify path: lines 105–135 (prints terminal row JSON incl. `evidence_path` on success). Exit-code map at lines 80–88 (2=SECRET_UNREADABLE, 3=CHAIN_BREAK, 4=evidence missing, 6=provenance).

### The producer (MISSING — this build)
Today a human/agent (larry) produces the row by hand per `orgs/clearworksai/agents/larry/PIPELINE-STAGING.md` (runbook steps 1–5). Nothing automates it. That is the whole feature.

## 2. The by-hand procedure this replaces (verbatim shape, from PIPELINE-STAGING.md + spec 03)
1. Apply the codexer build output to a staging branch/checkout of the target prod repo.
2. `railway environment staging` → `railway up` (deploy on-demand into the staging env; envs are empty placeholders, `staging_url` is assigned at deploy time). Never touch prod. Re-link to `production` after.
3. Run migrations + seed against the STAGING DB (staging-first safety: synthetic/fixture data preferred; any prod-data copy is destructive-adjacent → staging-first marker required).
4. Run the repo's REAL verify command — exit must be 0.
5. Drive the app like a human (real HTTP + auth + submissions) and read the REAL end-state via DB/JSON API — never rendered HTML (Website Accuracy Rule, larry CLAUDE.md).
6. Write evidence JSON to `orgs/clearworksai/agents/larry/state/staging-verify/<slug>.json` (non-empty; gate asserts `-s`).
7. `bin/pipeline-stage-emit --slug <slug> --stage staging-verify --artifact <build-output> --evidence <file> --runner larry`.

## 3. Machinery inventory (cited)
| Piece | Path | Role |
|---|---|---|
| PR gate (consumer) | `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh:24-68` | blocks prod-repo PRs without fresh signed staging-verify + evidence |
| Ledger core | `src/pipeline/ledger.ts` (`emitLedgerRow:844`, `verifyChainDetailed:1032`, `allowedPreviousStages:338`, `STAGES:15`) | signed append-only chain |
| Emit CLI | `bin/pipeline-stage-emit` + `src/pipeline/stage-emit.ts:99-176` | the ONLY way this tool writes/verifies rows |
| Existing runbook spec | `.agent/one-big-feature/pipeline-staging-verify-gate/03-specs/03-staging-envs-runbook.md` | per-repo env table + evidence shape (REUSED below) |
| Operational runbook | `orgs/clearworksai/agents/larry/PIPELINE-STAGING.md` | manual 5-step procedure being automated |
| Regression proof of gate | `tests/unit/pipeline/ledger.test.ts` (14), `tests/unit/pipeline/hook-gates.test.ts` (9) | patterns to extend for the producer |
| File lock util | `src/utils/lock.ts` (`withFileLockSync`, used ledger.ts:952) | reuse for evidence-dir writes if needed |

## 4. Per-repo staging env + verify-command table (from runbook, confirmed live 2026-07-20 — MUTABLE-FACT: re-verify via `railway environment list` at run time)
| Prod repo | Local path | Railway project | Staging env | Real verify command | Notes |
|---|---|---|---|---|---|
| clearpath | `~/code/clearpath` | `awake-recreation` | `staging` | `npm test` | env re-created 2026-07-20 |
| cxportal (lifecycle-killer) | `~/code/cxportal` → `~/code/lifecycle-killer` | `joyful-learning` | `staging` | `npm run check` | no `npm test` |
| nonprofit-hub | `~/code/nonprofit-hub` | `unique-perception` | `staging` | `npm run check` | no `npm test` |
| auditos | `~/code/auditos` | `miraculous-ambition` | `staging` | `bin/verify.sh` | 13-gate harness |
| gws-security | `~/code/gws-security` | `gws-security` | `staging` | `uv run python -m pytest` | Flask + uv |

Staging envs are **empty placeholders** — services deploy on-demand per run; `staging_url` is captured from the deploy output and recorded in evidence. There is no standing URL to hardcode.

## 5. Constraints that shape the design
- **No new runtime deps** (cortextOS rule; package.json runtime deps are fixed). Consequences:
  - HTTP driving uses Node 20 global `fetch` + a hand-rolled cookie jar (no axios/playwright).
  - Railway operations shell out to the `railway` CLI binary (already installed system-wide; a binary is not an npm dep).
  - **No `pg`/drizzle in cortextOS** → direct DB reads run INSIDE the target repo via `railway run --environment staging -- node -e '<query script>'` (target repo's own node_modules has drizzle/pg), OR via the app's own JSON API endpoints. Both satisfy "real end-state, never rendered HTML".
- **TypeScript strict**, no `any`, no `console.log` in library code (CLI prints via a thin logger to stdout/stderr).
- New code under `src/` (chosen home: `src/pipeline/staging-verify/`), implemented by codexer — this OBF only specs.
- The tool must NEVER emit on failure — a failed run writes a failure evidence file for debugging but does not call `pipeline-stage-emit` (the gate must keep blocking).
- Evidence must carry: `repo`, `staging_url`, `verify_command`, `exit_code`, `build_output_sha256`, and numeric end-state assertions (expected vs actual — numbers, not vibes).

## 6. Risks
1. **Flakes / transient failures** — deploy timeouts, cold-start 502s, webhook race. Mitigation: bounded retry state machine (spec-03), transient-vs-deterministic error classification; deterministic failures never retry past 1 re-check.
2. **Staging drift** — env deleted (clearpath's was, 2026-07-20), migrations diverged from prod schema. Mitigation: preflight `railway environment list` check; migrate step is per-repo adapter-owned and always runs before drive.
3. **Secret handling** — staging DB URLs / session creds must come from Railway env (`railway variables`/`railway run` inherits them) — never written into evidence files or logs. Evidence schema forbids credential fields; redaction pass before write.
4. **Prod-touch hazard** — `railway` CLI link state is sticky. Mitigation: every railway invocation passes explicit `--environment staging` (never relies on linked state); adapter refuses to run if resolved env name ≠ configured staging env.
5. **Seed destructiveness** — staging-first marker rule applies to the SEED itself if it copies prod data. Default: synthetic fixtures only; prod-copy seeding is out of scope for v1 and hard-blocked by the adapter.
6. **Chain precondition** — emit fails with `CHAIN_BREAK` if no `review` row exists for the slug (ledger.ts:346, 927–929). The CLI must preflight-verify `--through review` and fail fast with a clear message instead of burning a full deploy.
7. **Ledger/secret location** — emits must run with cwd (or `--ledger`) resolving to the same ledger the gate reads (`defaultLedgerPath` = `CTX_PROJECT_ROOT`-relative, ledger.ts:401–420). CLI passes `--ledger`/`--secret` through explicitly.

## 7. Open questions (non-blocking; defaults chosen in 02-master-plan)
1. **Scenario source** — per-repo drive scenarios (auth + steps + assertions) live as JSON files in the target repo (`<repo>/.staging-verify/scenario.json`) vs in cortextOS. **Default: target repo owns its scenario file**, cortextOS ships the schema + a fallback "deploy + health JSON + verify-cmd only" minimal scenario when the file is absent.
2. **Runner identity** — `--runner` value on the emitted row. Default: `staging-verify-loop` (distinguishes automated from hand-run `larry` rows; gate does not check runner, only chain validity).
3. **auditos/gws-security drive step** — non-Node stacks; v1 ships full adapters for the 3 Node repos and verify-cmd-only adapters (deploy + migrate + verify + health JSON, no form-drive scenario) for auditos/gws-security until scenarios are authored.
4. **Where teardown happens** — on-demand staging services bill while up. Default: `railway down` (service delete in staging env) in a `finally` teardown unless `--keep-deploy` is passed.
