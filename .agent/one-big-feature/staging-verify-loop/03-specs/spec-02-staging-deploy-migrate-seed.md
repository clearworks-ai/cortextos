# spec-02 — Staging deploy + migrate + seed (Railway adapter)

## File targets
- `src/pipeline/staging-verify/railway.ts` — env-pinned spawn wrapper around the `railway` CLI binary.
- `src/pipeline/staging-verify/deploy.ts` — implements `StageFns.apply / deploy / migrate / seed / teardown` (spec-01 interface).

## railway.ts

```typescript
export interface ExecResult { code: number; stdout: string; stderr: string; }
export type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

export function defaultExec(): ExecFn;   // child_process.spawn, no shell:true, captures streams, kills on timeout

export class RailwayCli {
  constructor(opts: { exec?: ExecFn; binary?: string /* default 'railway' */ });
  environmentList(cwd: string): Promise<string[]>;                       // `railway environment list --json` (fallback: parse plain output)
  up(cwd: string, env: string): Promise<{ ok: boolean; detail: string }>; // `railway up --ci --environment <env>`
  statusJson(cwd: string, env: string): Promise<unknown>;                 // `railway status --json --environment <env>`
  run(cwd: string, env: string, command: string[]): Promise<ExecResult>;  // `railway run --environment <env> -- <command...>`
  serviceDelete(cwd: string, env: string): Promise<ExecResult>;           // teardown: `railway down --environment <env> --yes` (or service delete equivalent)
}
```

Hard rules:
- **Every** subcommand passes explicit `--environment <env>`. Never rely on linked env state (link state is sticky and prod-touch is the catastrophic failure mode).
- Constructor-injected `ExecFn` — all tests run against a fake; no unit test spawns the real binary.
- Guard: before `up`/`run`/`serviceDelete`, assert `env` is the configured `RepoConfig.stagingEnv` AND `!repo.prodEnvNames.includes(env)`; violation throws (never a silent fallback). This is a code-level invariant, not just a config convention.
- Timeouts: `up` 600s; `run` 300s; others 60s. Timeout → `ExecResult.code = 124` style sentinel the caller classifies as **transient**.
- Output hygiene: stdout/stderr captured for classification but NEVER copied into evidence verbatim (may echo env vars). Only derived facts (exit code, URL, first matching error line) propagate.

## deploy.ts stage implementations

### apply(ctx)
- Create/refresh a dedicated worktree of the target repo at `<repo.localPath>/../.staging-verify-worktrees/<slug>` via `git worktree add --force` (or `git -C <worktree> fetch && reset --hard`) pointed at the build output:
  - If `ctx.buildOutputPath` is a git ref/branch name in the target repo → check it out.
  - If it is a directory (codexer diff output applied elsewhere) → `fatal` in v1 with detail "build-output must be a git ref/branch of the target repo" (directory-apply is out of scope; the pipeline's build output is always a branch).
- Record resolved HEAD sha in `ctx` (goes into evidence as `applied_git_sha`).
- Errors: git failures = `fatal` (nothing transient about a bad ref).

### deploy(ctx)
1. Preflight (done in spec-01 preflight but re-asserted cheaply): `environmentList` contains `repo.stagingEnv`, else `fatal` ("staging env missing — see PIPELINE-STAGING.md, create via railway environment new").
2. `up(worktree, stagingEnv)` — non-zero: classify `transient` iff stderr/stdout matches network/timeout/registry patterns (`timed out|ECONN|502|503|temporar`i), else `fatal`.
3. Resolve `staging_url` from `statusJson` (service domains array); if absent, generate domain via `railway domain --environment staging` once, re-read. No URL after both → `transient` (deploy may still be propagating).
4. Health poll: `GET <staging_url><repo.healthPath>` with `accept: application/json`, up to 30 tries × 10s. Success = HTTP 200 AND `content-type` includes `application/json` AND body parses as JSON (never accept an HTML 200 shell — Website Accuracy Rule). Exhausted → `transient`.
5. Set `ctx.stagingUrl`. Outcome `ok`.

### migrate(ctx)
- If `repo.migrateCommand` unset → `ok` (skip, recorded in StageRecord detail `"skipped: no migrateCommand"`).
- Else `run(worktree, stagingEnv, splitCommand(repo.migrateCommand))` — `railway run` injects the STAGING env's `DATABASE_URL`, so migrations hit the staging DB only. Non-zero exit → `fatal` (schema failures are never flakes). Registry defaults: clearpath/cxportal/nonprofit-hub `npm run db:push` (codexer: confirm each repo's real script name from its package.json at implementation time and hardcode the confirmed value); auditos/gws-security unset in v1.

### seed(ctx)
- If `repo.seedCommand` unset → `ok` (skipped).
- Else run like migrate. **Invariant enforced in code:** before running, refuse (`fatal`) if the resolved command string matches `/prod|production|dump|restore/i` — synthetic-fixture seeds only; prod-data copies are destructive-adjacent and out of scope (CLAUDE.md Staging-First Protocol).
- Non-zero exit → `fatal`.

### teardown(ctx)
- Best-effort `serviceDelete(worktree, stagingEnv)`; log-and-swallow all errors (never mask the run result). Skipped when `ctx.keepDeploy`.
- Also `git worktree remove --force` the apply worktree (same swallow rule).

## Inputs/outputs summary
| Stage | In | Out | transient | fatal |
|---|---|---|---|---|
| apply | buildOutputPath (git ref) | worktree + applied_git_sha | — | bad ref, git error, dir input |
| deploy | worktree, stagingEnv | ctx.stagingUrl | up timeout/5xx, no URL yet, health-poll exhausted | env missing, build error in up output |
| migrate | migrateCommand | — | — | non-zero exit |
| seed | seedCommand | — | — | non-zero exit, prod-pattern match |
| teardown | — | — | (never fails the run) | — |

## Acceptance tests (`tests/unit/pipeline/staging-verify/` — fake ExecFn throughout)
1. Every RailwayCli call includes `--environment staging` in recorded args (assert on ALL calls).
2. `up` against env `production` (or any prodEnvNames member) throws before exec — guard test.
3. `up` stderr `"ETIMEDOUT"` → deploy outcome transient; stderr `"Build failed"` → fatal.
4. Health poll: fake fetch returning 200 `text/html` forever → transient (HTML never satisfies); 502,502,200-JSON → ok with stagingUrl set.
5. migrate unset → ok skipped; migrate exit 1 → fatal.
6. seed command containing `pg_restore prod_dump` → fatal without exec being called.
7. teardown exec throws → runner result unchanged (still whatever the run produced).
8. `defaultExec` unit: kills a `sleep`-style child on timeout and returns the timeout sentinel (guarded, short timeout).
