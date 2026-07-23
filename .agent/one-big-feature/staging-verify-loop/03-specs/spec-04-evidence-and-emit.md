# spec-04 — Evidence file schema + signed staging-verify emit

## File targets
- `src/pipeline/staging-verify/evidence.ts` — schema, redaction, atomic write (implements `StageFns.evidence`).
- `src/pipeline/staging-verify/emit.ts` — preflight chain check + emit + self-verify (implements `StageFns.emit` and part of preflight).
- Evidence interfaces in `src/pipeline/staging-verify/types.ts`.

## Evidence schema (types.ts)

Superset of the hand-written shape in `orgs/clearworksai/agents/larry/PIPELINE-STAGING.md` step 4 and `.agent/one-big-feature/pipeline-staging-verify-gate/03-specs/03-staging-envs-runbook.md` lines 22–31 — every field the manual runbook required is present with the same names, so existing consumers/readers of old evidence files stay compatible.

```typescript
export interface StagingVerifyEvidence {
  schema: 'staging-verify-evidence/v1';
  slug: string;
  ok: boolean;                                // false variant written on failed runs (debug artifact; never emitted)
  // --- required by the feature contract (numbers, not vibes) ---
  repo: string;                               // RepoConfig.localPath, e.g. /Users/joshweiss/code/clearpath
  staging_url: string;                        // assigned-at-deploy URL ('' only in failure variant before deploy)
  verify_command: string;                     // exact command run, e.g. 'npm test'
  exit_code: number;                          // verify command exit code
  build_output_sha256: string;                // sha256 of the build output (git ref → sha256 of `git rev-parse` sha string + describeArtifact-style digest of tracked tree; recorded method in build_output_kind)
  assertions: AssertionResult[];              // spec-03 shape: name, source, expected, actual, op, pass
  // --- run provenance ---
  build_output_kind: 'git-ref';
  applied_git_sha: string;
  railway_project: string;
  staging_env: string;
  attempts: number;                           // attempts consumed (1..5)
  max_attempts: number;
  scenario: string;                           // scenario.name or 'minimal'
  stages: StageRecord[];                      // full spec-01 stage timeline
  verify_output_tail: string;                 // last 50 lines, redacted
  failure?: { stage: StageName; detail: string };  // failure variant only
  started_at: string;                         // ISO 8601
  finished_at: string;
  runner: string;
  tool_version: string;                       // cortextos package.json version
}
```

## evidence.ts

```typescript
export function redact(text: string): string;
// Masks: values of process.env vars whose NAME matches /(TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL)/i and are >= 8 chars;
// postgres:// / mysql:// URLs; 'Bearer <token>' sequences. Applied to verify_output_tail and every StageOutcome.detail.

export function evidencePath(ctx: RunContext): string;
// `${ctx.evidenceDir}/${ctx.slug}.json`
// Default evidenceDir: $CTX_AGENT_DIR ? `$CTX_AGENT_DIR/state/staging-verify` : `<cwd>/state/staging-verify`
// (matches the manual convention orgs/clearworksai/agents/larry/state/staging-verify/<slug>.json when run as larry).

export function writeEvidence(ctx: RunContext, evidence: StagingVerifyEvidence): string;
// mkdir -p, write to `${path}.tmp`, fs.renameSync into place (atomic — the gate does a `-s` existence check,
// gate-pr-push.sh:56, and must never observe a half-written file). Returns absolute path.
// Throws if the serialized file would be empty (belt-and-braces vs the gate's -s assert and ledger.ts:872 size check).
```

Failure variant: same schema, `ok:false`, `failure` populated, `exit_code:-1` if verify never ran, `staging_url:''` if deploy never succeeded. Written to `${slug}.failed.json` — a DIFFERENT filename so a stale failure artifact can never be picked up as `--evidence` for an emit.

## emit.ts

```typescript
export interface EmitDeps { exec: ExecFn; pipelineEmitBin: string /* default <cortextosRoot>/bin/pipeline-stage-emit */ }

export async function preflightReviewRow(ctx: RunContext, deps: EmitDeps): Promise<StageOutcome>;
// Runs: pipeline-stage-emit --verify --slug <slug> --through review --max-age 86400 [--ledger --secret]
// Non-zero → fatal: "no signed review row for <slug> — staging-verify chains off review
// (src/pipeline/ledger.ts:346); run the review stage first". Called from spec-01 PREFLIGHT so we
// fail in seconds instead of after a full deploy (emitLedgerRow would throw CHAIN_BREAK, ledger.ts:927-929).

export async function emitStagingVerify(
  ctx: RunContext, evidenceFile: string, deps: EmitDeps,
): Promise<{ ok: boolean; rowJson?: string; detail?: string }>;
```

`emitStagingVerify` behavior:
1. Guard: refuse (`ok:false`) if the evidence file's parsed `ok !== true` or `exit_code !== 0` or any `assertions[].pass === false` — the emitter re-validates rather than trusting the runner ordering.
2. Spawn:
   ```
   <pipelineEmitBin> --slug <slug> --stage staging-verify \
     --artifact <ctx.buildOutputPath resolved artifact (the worktree checkout path)> \
     --evidence <evidenceFile> --runner <ctx.runner> \
     [--ledger <ctx.ledgerPath>] [--secret <ctx.secretPath>]
   ```
   staging-verify is NON-authored (`AUTHORED_STAGES`, ledger.ts:134 — excludes it), so NO `--session/--transcript` args; `emitLedgerRow` requires only the non-empty evidence file (ledger.ts:871-875) and the review predecessor (ledger.ts:346).
3. Map failures using stage-emit's exit codes (src/pipeline/stage-emit.ts:80-88): 2 = signing secret unreadable (`~/.pipeline-secret`, ledger.ts:423); 3 = CHAIN_BREAK; 4 = evidence missing/empty. Surface the code + stderr in `detail`.
4. **Self-verify** with the gate's EXACT invocation (gate-pr-push.sh:48):
   ```
   <pipelineEmitBin> --verify --slug <slug> --through staging-verify --max-age 86400 [--ledger --secret]
   ```
   Must exit 0; parse stdout JSON; assert `evidence_path` is non-empty and the file passes an `-s`-equivalent stat (mirrors gate-pr-push.sh:54-56). Only then `ok:true` with `rowJson` = the emitted row line. This closes the loop: success means the gate WILL pass for this slug within 24h.

## How this satisfies gate-pr-push.sh (traceability)
| Gate requirement | Where satisfied |
|---|---|
| signed staging-verify row, valid chain to research (gate:48 → verifyChainDetailed ledger.ts:1032) | emit via pipeline-stage-emit, review-preflight guarantees chain |
| < 86400s old (ledger.ts:1158-1165) | row is emitted seconds after the run; self-verify uses the same max-age |
| `evidence_path` non-empty in row JSON (gate:54-55) | `--evidence` always passed; canonicalPayload signs it (ledger.ts:274) |
| evidence file non-empty on disk (gate:56) | atomic write + non-empty throw + self-verify stat |
| required content fields (repo, staging_url, verify_command, exit_code, build_output_sha256, numeric assertions) | schema above; emitter guard re-validates |

## Acceptance tests
Unit (`tests/unit/pipeline/staging-verify/evidence.test.ts`, `emit.test.ts`):
1. `writeEvidence` output parses; contains the 5 contract fields + assertions with numeric expected/actual; tmp file gone after rename.
2. `redact` masks a `DATABASE_URL=postgres://user:pw@host/db` value and `Bearer abc12345678` in verify_output_tail; leaves command names intact.
3. Failure variant lands at `<slug>.failed.json`; success at `<slug>.json`.
4. `emitStagingVerify` refuses when `assertions` contains a `pass:false` (fake exec never called).
5. Emit arg construction: fake exec receives `--stage staging-verify`, `--evidence`, `--runner`, and NO `--transcript/--session`.
6. Exit-code mapping: fake exec exit 3 → detail contains `CHAIN_BREAK`.
7. `preflightReviewRow` non-zero → fatal message cites the review-first requirement.

Integration (`tests/integration/staging-verify-loop.test.ts`):
8. Temp ledger + temp secret; seed a real research→…→review chain via `emitLedgerRow` (pattern of `tests/unit/pipeline/hook-gates.test.ts`); run the full loop against the fixture app + fake railway; then `verifyChainDetailed({slug, throughStage:'staging-verify', maxAgeSeconds:86400, ledgerPath, secretPath})` returns `ok:true` with `terminal.evidence_path` = the written file, non-empty.
9. Same setup without a review row → CLI exits 2 in preflight; ledger untouched; no deploy call recorded by the fake railway.
10. Gate-compat: pipe a synthetic `gh pr create` payload through the gate's verify command line against the temp ledger and assert exit 0 (proves the produced row satisfies the exact consumer).
