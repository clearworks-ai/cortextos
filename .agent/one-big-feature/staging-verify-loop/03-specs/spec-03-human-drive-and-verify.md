# spec-03 — Human-drive + real end-state read + verify command (with retry bounds)

## File targets
- `src/pipeline/staging-verify/drive.ts` — scenario-driven HTTP engine (implements `StageFns.drive`).
- `src/pipeline/staging-verify/state-read.ts` — end-state readers + assertion evaluation (implements `StageFns.readState`).
- `src/pipeline/staging-verify/verify.ts` — real verify-command runner (implements `StageFns.verify`).
- Scenario/assertion interfaces added to `src/pipeline/staging-verify/types.ts`.

## Scenario schema (types.ts)

Scenario file location: `RepoConfig.scenarioPath`, default `<repo.localPath>/.staging-verify/scenario.json`. Absent file → **minimal scenario**: drive = health-JSON GET only, assertions = `[]` (deploy + migrate + verify-cmd still prove the build; recorded in evidence as `scenario: "minimal"`). This is the v1 mode for auditos/gws-security.

```typescript
export interface Scenario {
  name: string;
  auth?: AuthStep;                 // performed first; session cookies persist across all steps
  steps: DriveStep[];              // executed in order
  assertions: StateAssertion[];    // evaluated in READ_STATE after all steps
}

export interface AuthStep {
  kind: 'form-login' | 'json-login';
  path: string;                              // e.g. '/api/login'
  usernameEnv: string;                       // env var NAME holding the staging test username (e.g. STAGING_VERIFY_CLEARPATH_USER)
  passwordEnv: string;                       // env var NAME for the password — values never logged/persisted
  bodyTemplate: Record<string, string>;      // {"email":"$USERNAME","password":"$PASSWORD"} — $USERNAME/$PASSWORD substituted
  successStatus: number[];                   // e.g. [200, 302]
}

export interface DriveStep {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;                              // relative to ctx.stagingUrl
  body?: unknown;                            // JSON body
  contentType?: 'application/json' | 'application/x-www-form-urlencoded';
  headers?: Record<string, string>;          // e.g. webhook signature headers; may reference $ENV:VAR_NAME
  expectStatus: number[];                    // fatal if final status not in list
  captureJson?: Record<string, string>;      // varName -> dot-path into response JSON; vars usable as $var in later paths/bodies
}

export interface StateAssertion {
  name: string;
  source: 'json-api' | 'db';
  // json-api:
  endpoint?: string;                         // GET, authed session, must return application/json
  jsonPath?: string;                         // dot-path, e.g. 'assets.length' or 'count'
  // db:
  queryScript?: string;                      // path RELATIVE TO TARGET REPO of a script printing ONE json line {"value": <number>}
  op: 'eq' | 'gte' | 'lte';
  expected: number;                          // NUMBERS, not vibes — evidence records expected vs actual
}
```

Loader `loadScenario(repo: RepoConfig): Scenario` validates with hand-rolled type guards (no zod); invalid file = `fatal` at drive start with the first offending field named.

## drive.ts

```typescript
export interface FetchLike { (url: string, init?: RequestInit): Promise<Response>; }

export class CookieJar {
  storeFrom(url: string, setCookieHeaders: string[]): void;   // parse name=value; ignore attributes except Path; no external lib
  headerFor(url: string): string | undefined;
}

export async function runDrive(ctx: RunContext, scenario: Scenario, fetchImpl?: FetchLike): Promise<StageOutcome>;
```

Behavior:
- Node 20 global `fetch` with `redirect: 'manual'`; follow up to 5 redirects manually so `set-cookie` on 302 login responses is captured (fetch's auto-follow drops them).
- Auth first: read credentials from `process.env[usernameEnv]` / `[passwordEnv]`; missing env var = `fatal` naming the VAR NAME only (value never appears anywhere). Session cookie (`connect.sid` for the express-session repos) must be present in the jar after auth, else `fatal 'auth produced no session cookie'`.
- Each step: substitute captured `$vars` + `$ENV:` headers, send, check `expectStatus`.
- Per-request timeout 30s (AbortController).
- Transient vs fatal classification (feeds the spec-01 retry rewind):
  - **transient**: network errors (ECONNRESET/ECONNREFUSED/ETIMEDOUT/abort), HTTP 502/503/504, HTTP 500 on the FIRST attempt of a step (cold-start grace — one immediate in-place re-send after 5s before classifying).
  - **fatal**: 4xx anywhere, 500 persisting past the in-place re-send, status not in `expectStatus`, missing capture path, auth failure.
- Never parse HTML for facts. A step response with `content-type: text/html` may only be status-checked (redirect/landing), never captured from.

## state-read.ts

```typescript
export interface AssertionResult {
  name: string; source: 'json-api' | 'db';
  expected: number; actual: number | null; op: 'eq' | 'gte' | 'lte'; pass: boolean;
  detail?: string;                            // endpoint or queryScript path
}

export async function readEndState(
  ctx: RunContext,
  scenario: Scenario,
  deps: { fetchImpl?: FetchLike; jar: CookieJar; railway: RailwayCli; worktree: string },
): Promise<{ outcome: StageOutcome; results: AssertionResult[] }>;
```

- `json-api` assertions: authed GET to `ctx.stagingUrl + endpoint`; require 200 + `application/json`; walk `jsonPath` (supports `.length`); non-number resolution → assertion fails with `actual: null`.
- `db` assertions: `railway.run(worktree, stagingEnv, ['node', queryScript])` (gws-security: script path ending `.py` runs as `['uv','run','python', queryScript]`). The script executes INSIDE the target repo with the target repo's own DB deps and the staging `DATABASE_URL` injected by `railway run` — this is how cortextOS reads the real staging DB with zero new runtime deps. Last stdout line must parse as `{"value": <number>}`; anything else → assertion fails.
- Outcome: all pass → `ok`. Any fail → `fatal` (an end-state mismatch is a real defect, not a flake — retries must not mask it). Railway `run` transport error → `transient`.
- Results array is returned to the runner and lands verbatim in evidence (spec-04).

## verify.ts

```typescript
export async function runVerifyCommand(
  ctx: RunContext,
  deps: { exec: ExecFn; worktree: string },
): Promise<{ outcome: StageOutcome; exitCode: number; command: string; tailOutput: string }>;
```

- Runs `RepoConfig.verifyCommand` EXACTLY as configured (split on whitespace, spawn without shell) with `cwd = worktree`, timeout 900s. Never substitute a smoke ping — the command column is contractual (larry CLAUDE.md "Repositories Owned"; PIPELINE-STAGING.md table).
- `exitCode !== 0` → `fatal`. Timeout → `transient` (one retry cycle may recover a hung test runner).
- `tailOutput` = last 50 lines of combined output, secrets-redacted by the evidence writer (spec-04), stored in evidence for debugging.

## Retry / self-correct bounds (normative summary — implemented in spec-01 runner)
- In-place re-send: max 1 per drive step (cold-start 500 grace only).
- Loop rewind (fresh deploy → drive → read → verify): total attempts = `--max-attempts`, default 3, clamp [1,5].
- `fatal` NEVER retries. Self-correction = re-deploy/re-run for transient causes only; the tool must never loosen an assertion, downgrade an expected status, or skip a failing step to converge. Exhausted retries → exit 3 + failure evidence.

## Acceptance tests (`tests/unit/pipeline/staging-verify/drive.test.ts` + fixture `node:http` server)
1. form-login sets cookie via 302 `set-cookie`; jar replays it on subsequent steps (assert server saw it).
2. Missing `process.env[passwordEnv]` → fatal; error text contains the var NAME and not any value.
3. Step returns 503 → transient; 404 → fatal; 500-then-200 within in-place grace → ok.
4. `captureJson` var substituted into a later step's path.
5. json-api assertion: `{count: 3}` with expected eq 3 → pass; expected eq 4 → readEndState fatal with `actual: 3` recorded.
6. db assertion via fake RailwayCli returning `{"value": 12}` → pass gte 10; garbage stdout → fail with `actual: null`.
7. HTML 200 response to a capture-bearing step → fatal (never captured from HTML).
8. verify: fake exec exit 2 → fatal + exitCode 2 + command string preserved exactly (`npm test` not normalized).
9. Missing scenario file → minimal scenario, drive ok with health GET only.
