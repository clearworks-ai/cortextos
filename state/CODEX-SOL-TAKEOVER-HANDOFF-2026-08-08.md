# Codex → Sol takeover handoff — 2026-08-08

## Superseding status — 2026-08-08 18:02 PT

The bounded R5 proof has now been completed directly in the exact Larry worktree
`/private/tmp/larry-seiu-multi-order-178606/typescript` after the Codexer process stopped:

- source-only candidate aggregate: `e919f3895e971a6f58d5a97ac9bc21481f2d0be084b773cef8314c141d2ce378`;
- serialized disposable-PostgreSQL SEIU matrix: 9 files, 81/81 pass, 0 skips;
- matchBilling: 11 files, 97/97 pass;
- deterministic non-live suite: 145 files, 1,585 pass, 16 expected credentialed/PostgreSQL skips;
- typecheck, web build, and diff-check: pass.

The first unconstrained integration invocation exposed concurrent PostgreSQL teardown races;
the two affected R5-07 cases pass individually and the complete matrix passes with
`--no-file-parallelism --sequence.concurrent=false`. This is a test-isolation constraint,
not a production failure.

The worktree is still not authorized for production apply or deployment. Remaining hard gates
are a real addressable Egnyte sandbox version/checksum/read-back receipt, rebinding the new
candidate digest into a fresh plan/packet, and fresh independent signed zero-Critical/High
reviews for that exact digest. Existing R4 reports are FAIL. No provider/production write,
push, PR, merge, or deploy was performed from this candidate.

## Purpose

This is a takeover of the live 521 repair investigation. The previous session lost the
implementation loop by confusing passing scaffolding tests with a real end-to-end run.
Continue from live evidence, not from the prototype's green unit tests.

## Live runtime evidence

- Active Codexer app-server: PID 12954, `gpt-5.6-luna`, `xhigh`, context request `1050000`.
  CWD/state: `/Users/joshweiss/.cortextos/cortextos1/state/codexer`.
- Active Sol app-server: PID 74092, `gpt-5.6-sol`, `medium`, context request `1050000`.
  CWD/state: `/Users/joshweiss/.cortextos/cortextos1/state/larry-codex`.
- Codexer is actively processing signed bus messages from `larry-codex`; it is not idle.

## Active 521 task

Codexer is working in:

`/private/tmp/larry-seiu-multi-order-178606/typescript`

Dispatch:

`GATE: build framework=m2c1 slug=seiu-521-live-repair-goal scope-sha=b0a3befbe941e3c01a54d8402d55519a642801bb2bd32a65c55702c8bfcb360e`

Current bounded follow-up from Larry:

1. R5-07: real disposable-PostgreSQL interleaving test through registered `matchBilling`,
   proving both legal promotion orderings and exactly one repair-owned event.
2. R5-08: disposable-PostgreSQL failure injection through `applyApprovedLiveRepair`, proving
   deterministic terminal `operator_review` versus resumable `provider_unavailable`.
3. Rebind corrected runtime candidate digest into manifest/evidence.
4. Produce a genuinely zero-failure deterministic non-live suite receipt.

Provider/live/apply/approval/push/PR/merge/deploy actions are explicitly prohibited for this gate.

Latest Codexer receipt (15:36 PDT): implementation checkpoint had focused proof green but
aggregate suite interference and missing real Egnyte sandbox proof; Larry then authorized only
the R5-07/R5-08 proof follow-up. The latest message says: “Continue uninterrupted and return only
the complete proof receipt or one exact blocker.”

Inspect live receipts here:

- `/Users/joshweiss/.cortextos/cortextos1/processed/larry-codex/`
- `/Users/joshweiss/.cortextos/cortextos1/processed/codexer/`

## What this session got wrong

The new cortextOS files `src/daemon/pipeline-run-store.ts` and
`src/daemon/pipeline-supervisor.ts` are prototype scaffolding. They are not the live 521 loop:

- no production code creates a `PipelineRun`;
- no bus reply/transcript listener calls supervisor completion;
- no signed `pipeline-stage-emit` ledger row is emitted;
- no staging/true-verify stage is invoked;
- `GoalRunner.processTick()` is called once from `/goal`, not from a durable daemon tick after
  handoff/restart.

Do not use those files as evidence that the 521 job is complete. Do not send a duplicate live
dispatch or modify the active Codexer worktree.

## 521 provenance and staging facts

- The 521 merged main includes `1efbb8d` (`preserve multi-order identity`, 30-file change) and
  then `6538ef0` (auth parser). The last staging-proven baseline predates `1efbb8d`.
- The canonical runbook is
  `orgs/clearworksai/agents/larry-codex/PIPELINE-STAGING.md`.
- Required staging sequence is deploy exact artifact → run the real repository verification →
  write non-empty evidence JSON → emit a signed `staging-verify` row. Unit tests are not a
  substitute.
- The original failure was scope drift: this session investigated new goal infrastructure while
  Larry/Codexer was already executing the real SEIU-521 repair loop.

## Takeover instructions

1. Read the latest Codexer/Larry receipts above and the active R5 spec before touching anything.
2. Let Codexer finish the explicitly authorized R5-07/R5-08 proof-only follow-up.
3. Verify the exact changed worktree, receipt, digest, and deterministic suite result.
4. Only after Larry authorizes it, run the canonical staging/true-verify path for the exact 521
   merged artifact. Never infer staging success from local tests.
5. Keep this handoff updated with timestamped evidence; if blocked, record the exact blocker and
   preserve the active worktree.

## Acceptance rule

Do not say “done” unless there is a real worker receipt, a signed ledger row, and reproducible
staging/true-verify evidence for the exact artifact under review.
