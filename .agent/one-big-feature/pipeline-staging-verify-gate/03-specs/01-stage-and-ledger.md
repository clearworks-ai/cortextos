# Spec 01 — Stage vocabulary + signed-ledger support for `staging-verify` (P1 + P2)

**Files:** `src/pipeline/ledger.ts`, `src/pipeline/stage-emit.ts`, `src/pipeline/bypass-audit.ts` (no-change confirm)
**Verify:** `npm run build && npm test`

## Edit 1 — `src/pipeline/ledger.ts` STAGES (lines 15-24)
Insert `'staging-verify'` between `'review'` and `'true-verify'`:
```ts
export const STAGES = [
  'research',
  'synthesize',
  'plan',
  'specs',
  'implement',
  'review',
  'staging-verify',
  'true-verify',
  'exempt',
] as const;
```
`Stage` type (line 26) derives automatically. No change to signing/HMAC.

## Edit 2 — `stageRank` (lines 323-334)
Add the `staging-verify` case and renumber the two stages after it so rank is contiguous and strictly increasing (buildChain at lines 978-984 enforces strictly-decreasing rank walking backward):
```ts
function stageRank(stage: Stage): number {
  switch (stage) {
    case 'research': return 0;
    case 'synthesize': return 1;
    case 'plan': return 2;
    case 'specs': return 3;
    case 'implement': return 4;
    case 'review': return 5;
    case 'staging-verify': return 6;
    case 'true-verify': return 7;
    case 'exempt': return 8;
  }
}
```

## Edit 3 — `allowedPreviousStages` (lines 336-347) — DESIGN DECISION #1
`staging-verify` follows `review`; `true-verify` accepts EITHER `review` (existing chains) OR `staging-verify` (backward-compatible, staging is optional):
```ts
function allowedPreviousStages(stage: Stage): Stage[] {
  switch (stage) {
    case 'research': return [];
    case 'synthesize': return ['research'];
    case 'plan': return ['research', 'synthesize'];
    case 'specs': return ['plan'];
    case 'implement': return ['specs'];
    case 'review': return ['specs', 'implement'];
    case 'staging-verify': return ['review'];
    case 'true-verify': return ['review', 'staging-verify'];
    case 'exempt': return [];
  }
}
```
Rationale: every pre-existing `review → true-verify` chain stays valid; new `review → staging-verify → true-verify` also valid. buildChain's `allowedPreviousStages(cursor.stage).includes(prev.stage)` check (line 998) passes for both shapes.

## Edit 4 — evidence-required at emit (`emitLedgerRow`, line 868)
`staging-verify` is evidence-bearing like `true-verify`. Extend the guard:
```ts
  if (opts.stage === 'true-verify' || opts.stage === 'staging-verify') {
    if (!opts.evidencePath || !existsSync(opts.evidencePath) || statSync(opts.evidencePath).size === 0) {
      throw new Error('Artifact/evidence missing or empty for staging-verify');
    }
  }
```
(Keep the true-verify message wording generic or branch it; the emit-error mapper in `stage-emit.ts:84` keys on the substring `Artifact/evidence missing`, so the message MUST keep that exact substring to map to exit code 4.)

`staging-verify` is NOT authored (`AUTHORED_STAGES` line 133 unchanged), so `emitLedgerRow` skips the transcript-provenance branch (line 880) and only requires `--artifact` + `--evidence`. `prevSha` logic (lines 920-926): `staging-verify` is neither `research` nor `exempt`, so it requires a prior `review` row — correct.

## The staging-verify emit evidence shape (P2)
The `--evidence` file passed to emit is a JSON/text artifact the runbook (spec 03) writes, containing at minimum:
- `repo` — target prod repo (e.g. `~/code/clearpath`)
- `staging_url` — the Railway staging URL exercised
- `verify_command` + `exit_code` — the repo's real verify command (`npm test` / `npm run check` / `bin/verify.sh`) and its exit status (must be 0)
- `build_output_sha256` — sha of the codexer/opencoder build output that was deployed to staging (ties the staged bytes to the reviewed artifact)
This file's non-empty existence is what `gate-pr-push.sh` (spec 02) asserts via `evidence_path`.

## Edit 5 — `src/pipeline/stage-emit.ts` (confirm-only)
`parseStage` (line 59) validates `value` against `STAGES`, so `--stage staging-verify` and `--through staging-verify` work with zero edits after Edit 1. The `usage()` string (lines 66-73) does NOT enumerate stages inline, so no edit needed. No code change expected here — confirm the build passes.

## `src/pipeline/bypass-audit.ts` (confirm no-change)
- `AUTHORED_STAGES` (line 25) — do NOT add `staging-verify`.
- The `throughStage` union `'specs' | 'true-verify' | 'exempt'` (line 632) is not used to target staging-verify in the audit; no edit required.
- stageRank/ordering flows from `ledger.ts`, so audit ordering updates automatically.

## Verify-through behavior
`verifyChainDetailed({ slug, throughStage: 'staging-verify', maxAgeSeconds })` (ledger.ts:1029) filters candidates where `stage === 'staging-verify'` (line 1065) and buildChain walks back `staging-verify → review → ... → research`. Succeeds independently of whether a `true-verify` row exists yet. `evidence_path` is returned on the terminal row.

## Tests to write (`tests/unit/pipeline/ledger.test.ts` — mirror existing `signRow`/`emitLedgerRow` helpers at lines 69-88, 128-195)
1. **`STAGES` shape:** `expect(STAGES).toContain('staging-verify')` and its index is `STAGES.indexOf('review') + 1` and `STAGES.indexOf('true-verify') - 1`.
2. **Emit + verify a staging chain:** emit `research → synthesize?/plan → specs → implement → review → staging-verify` (or the minimal `research → ... → review → staging-verify`), each via `emitLedgerRow` with ascending `nowSeconds`; then `verifyChainDetailed({ throughStage: 'staging-verify', maxAgeSeconds: 100000, nowSeconds: <after> })` → `ok: true`, terminal `stage === 'staging-verify'`, `evidence_path` set. Use an evidence temp file with content (non-empty) for the staging-verify emit.
3. **Evidence required:** `emitLedgerRow({ stage: 'staging-verify', ... })` with no `--evidence` (or an empty evidence file) throws matching `/Artifact\/evidence missing/`.
4. **Backward compat:** a `review → true-verify` chain (NO staging-verify row) still verifies `--through true-verify` → `ok: true` (proves decision #1 didn't break existing chains).
5. **Optional-insert:** a `review → staging-verify → true-verify` chain verifies `--through true-verify` → `ok: true`.
6. **Not authored:** confirm no NO_PROVENANCE failure is raised for a staging-verify row lacking runner/session/transcript (it is evidence-only, not authored).

## No-gos
- No change to HMAC/secret handling, `provenance_mode`, or transcript-tamper detection.
- No reordering of existing stage constants (append-in-place only, between review and true-verify).
- Do NOT add `staging-verify` to `AUTHORED_STAGES` in either file.
