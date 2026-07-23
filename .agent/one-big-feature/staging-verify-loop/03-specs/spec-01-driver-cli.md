# spec-01 — Driver CLI + orchestration

## File targets
- `bin/staging-verify` — bash shim, byte-pattern of `bin/pipeline-stage-emit`: exec `dist/pipeline/staging-verify/cli.js` if present, else `node_modules/.bin/tsx src/pipeline/staging-verify/cli.ts`.
- `src/pipeline/staging-verify/cli.ts` — entrypoint + arg parsing.
- `src/pipeline/staging-verify/types.ts` — shared interfaces.
- `src/pipeline/staging-verify/repos.ts` — repo registry.
- `src/pipeline/staging-verify/runner.ts` — state machine.

## CLI contract

```
staging-verify --slug <slug> --repo <name|path> --build-output <path>
               [--staging-env <name=staging>] [--scenario <path>]
               [--max-attempts <n=3>] [--runner <name=staging-verify-loop>]
               [--config <repos.json>] [--ledger <path>] [--secret <path>]
               [--evidence-dir <dir>] [--keep-deploy] [--dry-run] [--json]
```

- Reuse the argv parser pattern from `src/pipeline/stage-emit.ts:18-57` (`parseArgs`, `stringFlag`, `requireString`) — copy locally, do NOT export from stage-emit.ts (keep modules decoupled).
- `--repo` accepts a registry key (`clearpath`, `cxportal`, `nonprofit-hub`, `auditos`, `gws-security`) or an absolute path matched against registry `localPath`.
- `--dry-run`: run PREFLIGHT only, print the resolved plan JSON, exit 0/1. No deploy, no emit.
- `--json`: machine-readable result line on stdout; human log lines always go to stderr.
- Exit codes: `0` success (row emitted + self-verified) · `1` fatal run failure · `2` preflight failure · `3` transient failures exhausted retries · `4` emit/self-verify failure (loop passed but row not produced).

## types.ts (exact interfaces)

```typescript
export type RepoKey = 'clearpath' | 'cxportal' | 'nonprofit-hub' | 'auditos' | 'gws-security';

export interface RepoConfig {
  key: RepoKey;
  localPath: string;              // e.g. /Users/joshweiss/code/clearpath
  railwayProject: string;         // e.g. awake-recreation
  stagingEnv: string;             // 'staging'
  prodEnvNames: string[];         // ['production'] — deploy refuses these
  verifyCommand: string;          // 'npm test' | 'npm run check' | 'bin/verify.sh' | 'uv run python -m pytest'
  migrateCommand?: string;        // run via railway run in staging env
  seedCommand?: string;           // synthetic fixtures only
  healthPath: string;             // JSON endpoint polled post-deploy, e.g. '/api/health'
  scenarioPath?: string;          // default <localPath>/.staging-verify/scenario.json
}

export type StageName =
  | 'preflight' | 'apply' | 'deploy' | 'migrate' | 'seed'
  | 'drive' | 'read-state' | 'verify' | 'evidence' | 'emit' | 'teardown';

export type StageOutcome =
  | { kind: 'ok'; detail?: string }
  | { kind: 'transient'; detail: string }
  | { kind: 'fatal'; detail: string };

export interface RunContext {
  slug: string;
  repo: RepoConfig;
  buildOutputPath: string;
  buildOutputSha256: string;      // computed in preflight via createHash('sha256') over describeArtifact-style digest
  stagingUrl?: string;            // set by deploy
  attempt: number;                // 1-based
  maxAttempts: number;
  runner: string;
  evidenceDir: string;
  ledgerPath?: string;
  secretPath?: string;
  keepDeploy: boolean;
  log: (line: string) => void;    // stderr writer — no console.log in lib code
}

export interface StageRecord {
  stage: StageName;
  attempt: number;
  startedAt: string;              // ISO 8601
  endedAt: string;
  outcome: StageOutcome['kind'];
  detail?: string;
}

export interface RunResult {
  ok: boolean;
  exitCode: 0 | 1 | 2 | 3 | 4;
  evidencePath?: string;
  ledgerRowJson?: string;         // echoed from pipeline-stage-emit on success
  stages: StageRecord[];
}
```

Scenario/assertion types live in spec-03; evidence types in spec-04 — both defined in this same `types.ts`.

## repos.ts

```typescript
export function defaultRepoRegistry(): RepoConfig[];
export function loadRepoRegistry(configPath?: string): RepoConfig[];   // JSON override file replaces/extends defaults by key
export function resolveRepo(registry: RepoConfig[], repoArg: string): RepoConfig; // key or path match; throws with known-keys list
```

Default registry = the 5-row table from `01-research.md` §4 (source of truth: `orgs/clearworksai/agents/larry/PIPELINE-STAGING.md` table + larry CLAUDE.md "Repositories Owned"). `verifyCommand` values are exact: clearpath `npm test`; cxportal `npm run check`; nonprofit-hub `npm run check`; auditos `bin/verify.sh`; gws-security `uv run python -m pytest`. Config override validated with a hand-rolled type guard (no zod — not in package.json).

## runner.ts (state machine)

```typescript
export interface StageFns {                 // injected for tests
  preflight(ctx: RunContext): Promise<StageOutcome>;
  apply(ctx: RunContext): Promise<StageOutcome>;
  deploy(ctx: RunContext): Promise<StageOutcome>;    // mutates ctx.stagingUrl
  migrate(ctx: RunContext): Promise<StageOutcome>;
  seed(ctx: RunContext): Promise<StageOutcome>;
  drive(ctx: RunContext): Promise<StageOutcome>;
  readState(ctx: RunContext): Promise<StageOutcome>;
  verify(ctx: RunContext): Promise<StageOutcome>;
  evidence(ctx: RunContext, failure?: { stage: StageName; detail: string }): Promise<string>; // returns evidence path — ALWAYS runs
  emit(ctx: RunContext, evidencePath: string): Promise<{ ok: boolean; rowJson?: string; detail?: string }>;
  teardown(ctx: RunContext): Promise<void>;          // best-effort, never throws
}

export async function runLoop(ctx: RunContext, fns: StageFns): Promise<RunResult>;
```

Semantics:
1. `preflight` runs once. `fatal`/`transient` here → exit 2, no evidence, no teardown.
2. Forward order: apply → deploy → migrate → seed → drive → readState → verify.
3. On `transient` from any of those: if `ctx.attempt < maxAttempts`, increment attempt and rewind to `deploy` (apply is idempotent and not repeated; a fresh deploy is the flake reset). Else exhausted → write failure evidence, exit 3.
4. On `fatal`: write failure evidence (with failing stage + detail), exit 1. No emit ever.
5. All-ok: write success evidence → `emit`; emit failure → exit 4 (evidence kept for manual emit). Emit ok → exit 0.
6. `teardown` runs in `finally` for every path that reached `deploy`, unless `keepDeploy`.
7. Every stage transition appends a `StageRecord`; the full array lands in the evidence file (spec-04).
8. Hard cap: `maxAttempts` clamped to `[1,5]`.

## Error handling
- All flag validation errors print usage (pattern of stage-emit.ts:66-73) to stderr, exit 2.
- Unknown `--repo` lists valid keys. Missing build-output path → exit 2 before any Railway call.
- Never let a thrown exception escape `cli.ts` `main()` — catch, log, map to exit 1.

## Acceptance tests (`tests/unit/pipeline/staging-verify/runner.test.ts`, `repos.test.ts`)
1. All-ok fns → emit called once, exit 0, stages recorded in order, teardown called.
2. `deploy` returns transient twice then ok (maxAttempts 3) → 3 deploy records, exit 0.
3. `drive` transient with maxAttempts 1 → exit 3, evidence(failure) called, emit NOT called.
4. `verify` fatal → exit 1, emit NOT called, teardown called.
5. preflight fatal → exit 2, evidence NOT called.
6. emit returns not-ok → exit 4, evidencePath still returned.
7. `keepDeploy: true` → teardown not called.
8. `resolveRepo('clearpath')` and `resolveRepo('/Users/joshweiss/code/clearpath')` both resolve; unknown key throws listing 5 keys; override config replaces `stagingEnv`.
9. maxAttempts 9 → clamped to 5.
