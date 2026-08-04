# Independent Pipeline Review — PR #286 `scoping-mandatory-gates`

**Reviewer:** larry (independent; did NOT build this)
**PR:** #286 · branch `scoping-mandatory-gates` · slug `scoping-mandatory-gates`
**Repo:** clearworks-ai/cortextos · base `main`
**Files:** `src/pipeline/scoping-gate.ts` (+326), `tests/unit/pipeline/scoping-gate.test.ts` (+239), `tsup.config.ts` (+1)
**Spec:** `knowledge-sync/raw/areas/clearworks/project-scoping-plan.md`

## Verdict: PASS

Adversarial review + full local execution in an isolated worktree. The gate genuinely
BLOCKS (non-zero exit) on an unmet mandatory gate, fails SAFE, and matches the
`phase-lock.ts` sibling pattern. No forgery of upstream provenance — see Ledger note.

## What was checked (with evidence)

### 1. Gate genuinely BLOCKS (non-zero exit)
CLI smoke, live rebuild `dist/pipeline/scoping-gate.js`:
- live-API Worker w/o integration-engineer → `INTEGRATION_ENGINEER_MISSING`, **exit 1**.
- both gates cleared → `{"ok":true,...}`, **exit 0**.
- deal-room with `exemplarGroundingPass2:false` → `EXEMPLAR_GROUNDING_MISSING`, **exit 1**.
`printAndExit(..., 1)` on a failed gate; a scoping run treating exit≠0 as a hard block
is correctly wired.

### 2. Fail-SAFE on the touchesLiveExternalSystem flag
`sanitizeWorker`: `touchesLiveExternalSystem: obj.touchesLiveExternalSystem !== false`.
A Worker missing the flag (typo/omission) is treated as **live** and cannot slip past
gate #1. Verified via CLI smoke 3: `{"id":"typo-worker",...}` (no flag) → exit 1.

### 3. Chain-order correct (integration checked BEFORE grounding at complexity)
`checkScopingGate` runs `workersMissingIntegrationEngineer` first, returns
`INTEGRATION_ENGINEER_MISSING` before the grounding block. Smoke EDGE A: both missing →
IE reported first. Matches Kadre-proven order (grounding#1 → complexity → IE → grounding#2
→ pricing); the integration gate correctly sits before a complexity lock a price rests on.

### 4. Pure function never throws
`readScopingManifest` wraps parse in try/catch, returns empty manifest on any failure
(missing/unreadable/unparseable/non-object/malformed-workers). `checkScopingGate` does no
I/O and only reads sanitized fields. Test "returns empty manifest on unparseable JSON
(never throws)" + "drops malformed worker entries" both pass.

### 5. Matches phase-lock.ts conventions
Same `node:fs`/`node:path` imports, `defaultScopingManifestPath(ledgerPath)` mirrors
`defaultPhaseLockPath` (manifest sits next to ledger so `--ledger` override relocates it),
same sanitize-and-fail-safe read, same discriminated-union `{ok:true}|{ok:false,code,detail}`
result shape, same CLI arg-parse/printAndExit skeleton as the pipeline CLIs.

### 6. Scope-locked
`solutions-engineer` / `pricing-analyst` / `deal-room-producer` remain on-demand — the gate
only refuses to FINALIZE past a gate point; it does not make any skill proactive. Confirmed
in the module doc + code (no dispatch/invoke logic present).

### 7. Exit-code hygiene
0 = pass / help; 1 = gate blocked; 5 = arg error (no `--check`, invalid `--action`).
Distinct and correct (EDGE B/C).

## Test result (quoted)
```
 Test Files  1 passed (1)
      Tests  17 passed (17)
   Duration  124ms
```

## Build
`npm run build` → `Build success in 86ms`; `dist/pipeline/scoping-gate.js` emitted
(tsup entry `pipeline/scoping-gate` wired in `tsup.config.ts`).

## Notes / minor (non-blocking)
- **Fail-OPEN on absent manifest** (smoke 4: missing file → exit 0). Consistent with
  `phase-lock.ts` fail-open-on-absent-file. The gate blocks only when a manifest exists and
  records an unmet condition; the caller must write `scoping-manifest.json`. This is a
  skill-chain checklist gate, not an orchestrator hook — acceptable and documented, but the
  scoping flow MUST actually write the manifest for the gate to bite. Design-consistent, noted.

## Ledger / provenance
This is an INDEPENDENT review. I did not author research/plan/specs/implement rows for this
slug, and none exist in `state/pipeline-ledger.jsonl`. Emitting `review` directly would
CHAIN_BREAK (`review` prevStages = specs+implement). Per instruction "no forge", the receipt
is emitted as an `exempt` GENESIS-anchored row (same pattern as `pr277-review-receipt` /
`pr279-review-receipt`) recording this independent review, committed durably to branch
`receipt/scoping-mandatory-gates` and pushed.
