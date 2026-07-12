# Spec 01 — Signed Stage Ledger (`bin/pipeline-stage-emit` + `verifyChain` + authorship provenance)

> Source design: `../01-research.md` §Proposed real fix, Mechanisms A + C, hardened by
> `../04-verify-round1-hardening.md` (rounds 1+2) and HOLE 3 (authorship provenance — this rerun).
> Language: **Node/TypeScript** (matches repo — `src/` compiled to `dist/`, TS strict, no new
> runtime deps; `node:crypto` + `node:fs` only).
> Regenerated 2026-07-12Z by the pipeline PLAN stage-runner.

## Purpose

`bin/pipeline-stage-emit` is the **only** writer of `state/pipeline-ledger.jsonl`. It reads a signing secret the agent cannot read, computes an HMAC-signed row for a completed pipeline stage, chains it to the prior stage's row, and appends. For AUTHORED stages it additionally verifies — before signing — that a distinct subagent stage-runner actually wrote the artifact (HOLE 3). Gates verify chains via the shared `verifyChain`; the agent cannot forge rows (no secret) and cannot launder hand-authored planning artifacts into signed rows (no matching transcript authorship).

## Files

| File | Role |
|------|------|
| `src/pipeline/ledger.ts` (NEW) | Row schema, canonical serialization, `verifyChain` — shared by emitter, bash gates (via `--verify`), and the `src/bus/message.ts` sink. |
| `src/pipeline/stage-emit.ts` (NEW) | Emitter implementation (CLI entry), incl. the transcript-authorship check. |
| `bin/pipeline-stage-emit` (NEW, tracked) | Thin shim → `dist/pipeline/stage-emit.js`. Executable. |
| `state/pipeline-ledger.jsonl` (runtime) | Append-only ledger. Agent read-allowed, write-denied (Spec 02 §3). |
| `~/.pipeline-secret` (runtime, NOT tracked) | 32+ random bytes, hex, `chmod 600`. Read-denied to the agent via hooks (Spec 02 §3). Provisioned once by Josh or a setup script outside agent policy. |

## Row schema

One JSON object per line, keys in this exact order (canonical form — signing depends on it):

```json
{"slug":"<kebab-slug>","stage":"<stage>","ts":1752300000,"artifact_sha256":"<64-hex>","prev_sha256":"<64-hex|GENESIS>","runner":"<agent-type|OMITTED>","session_id":"<id|OMITTED>","transcript_path":"<abs-path|OMITTED>","transcript_sha256":"<64-hex|OMITTED>","sig":"<64-hex>"}
```

- `slug` — pipeline run identifier; `[a-z0-9-]+`.
- `stage` — enum: `research | synthesize | plan | specs | implement | review | true-verify | exempt`. `exempt` rows additionally carry `"reason":"<string>"` (signed). `true-verify` rows carry `"evidence_path":"<path>"` (signed).
- `ts` — unix seconds, emitter-set. Callers cannot supply it.
- `artifact_sha256` — SHA-256 of the stage artifact. For a directory (e.g. `03-specs/`): SHA-256 of the sorted `sha256(file) + "  " + relpath` lines of every file in it.
- `prev_sha256` — `artifact_sha256` of the prior required stage row for the same slug; literal `GENESIS` for `research` (and standalone `exempt`).
- **Provenance fields (HOLE 3 — REQUIRED for `synthesize`, `plan`, `specs`, `review`; omitted for other stages):**
  - `runner` — the stage-runner agent type/model that authored the artifact (e.g. `fable-lean`, `architect`, `opus-review`).
  - `session_id` — the subagent session id.
  - `transcript_path` — absolute path to the subagent's session `.jsonl` (must resolve under the real Claude projects dir, `~/.claude/projects/`).
  - `transcript_sha256` — SHA-256 of the transcript file at emit time (freezes the evidence: a later transcript edit is detectable).
- `sig` — `HMAC-SHA256(secret, slug|stage|ts|artifact_sha256|prev_sha256[|runner|session_id|transcript_path|transcript_sha256][|reason][|evidence_path])`, lowercase hex. Provenance fields are INSIDE the signed payload — they cannot be added, removed, or swapped after signing.

Required forward order per slug: `research → plan → specs` minimum for a dispatch-gate pass (`synthesize` optional, recorded with provenance if run), then `review → true-verify` for the PR gate. `exempt` is a standalone single-row chain.

**Why `research` is chained but NOT provenance-required:** research is frequently multi-tool/multi-session (grounded web search, external APIs) with no single authoring transcript. The gate's trust object is the dispatched scope — `plan` + `specs` — and those ARE provenance-required; the ordering invariant plus the plan-stage provenance already force a real forward run (a hand-authored research file cannot conjure a provenance-valid plan row on top of it without a real plan subagent actually running).

## CLI shape

```
pipeline-stage-emit --slug <slug> --stage <stage> --artifact <path>
                    [--runner <type> --session <id> --transcript <path>]   # REQUIRED for synthesize|plan|specs|review
                    [--evidence <path>]                                    # REQUIRED for true-verify
                    [--reason "<text>"]                                    # REQUIRED for exempt
                    [--ledger <path>] [--secret <path>]
```

Behavior:
1. Load secret; trim; require ≥32 hex chars (else exit 2).
2. Resolve `prev_sha256`: latest valid-sig row of the same slug at the immediately-preceding required stage; missing/invalid → exit 3, unless stage is `research`/`exempt` (→ `GENESIS`).
3. Hash artifact (file or directory rule above).
4. **Authorship check (HOLE 3 — authored stages only, all mandatory, any failure → exit 6, NO row):**
   a. `--runner`, `--session`, `--transcript` all present; transcript exists, non-empty, resolves under `~/.claude/projects/` (realpath — no symlink escape).
   b. Parse the transcript `.jsonl` (Claude session shape: `type:"assistant"` entries → `message.content[]` blocks of `type:"tool_use"`). Collect every `Write`/`Edit` tool_use targeting the artifact path(s), in order, and **reconstruct the final content** of each artifact file from those calls (Write = full content; Edit = apply old→new replacement to the running content).
   c. Require: reconstructed final content sha == the on-disk sha for every artifact file. For a directory artifact, EVERY file in the directory must be covered by transcript writes. Uncovered file, sha divergence, or zero matching writes → `PROVENANCE_MISMATCH`, exit 6.
   d. Compute `transcript_sha256` over the transcript file as-is.
   This is what makes the row mean "*a distinct stage-runner wrote these exact bytes*", not merely "these bytes have a sha." A Larry-hand-authored artifact has no transcript containing its writes → no row is ever signed for it. Re-pointing at an OLD real transcript fails (c) the moment the artifact is hand-edited (sha diverges). The check binds to transcript CONTENT, so it holds even if the emitter is invoked manually rather than by the pipeline runner.
5. Build canonical row, sign, **append atomically** (one `O_APPEND` write of one line + `\n`, guarded by an exclusive lockfile `state/pipeline-ledger.lock` — `src/utils/atomic.ts` only if it preserves append semantics).
6. Print the appended row to stdout. Exit 0.

**Invocation contract (Spec: `LARRY/PIPELINE.md` change):** the pipeline runner invokes the emitter at subagent completion, passing the completed Task's session id + transcript path. The emitter does not trust the invoker — step 4 is what enforces; the contract just makes the honest path automatic.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Row appended. |
| 2 | Secret missing/unreadable/too short. |
| 3 | Chain break — no valid prior-stage row for slug. |
| 4 | Artifact/evidence missing, unreadable, or empty. |
| 5 | Bad arguments (unknown stage, missing required flag incl. missing provenance flags on an authored stage, bad slug charset). |
| 6 | **Provenance failure** — transcript missing/outside projects dir/empty, or authorship reconstruction does not match the on-disk artifact (`PROVENANCE_MISMATCH`). |

Never exit 0 without appending. No partial lines.

## Chain-verify function (shared, used by gates AND the sink)

In `src/pipeline/ledger.ts`:

```typescript
export type Stage = "research" | "synthesize" | "plan" | "specs"
                  | "implement" | "review" | "true-verify" | "exempt";

export interface LedgerRow {
  slug: string; stage: Stage; ts: number;
  artifact_sha256: string; prev_sha256: string; sig: string;
  runner?: string; session_id?: string;
  transcript_path?: string; transcript_sha256?: string;
  reason?: string; evidence_path?: string;
}

export type VerifyFailure =
  | "NO_ROWS" | "BAD_SIG" | "CHAIN_BREAK" | "OUT_OF_ORDER" | "STALE"
  | "SCOPE_SHA_MISMATCH" | "SECRET_UNREADABLE"
  | "NO_PROVENANCE" | "TRANSCRIPT_MISSING" | "TRANSCRIPT_TAMPERED";

/**
 * Verifies the ledger contains a fully signed, correctly chained, forward-ordered
 * run for `slug` reaching at least `throughStage`, with the terminal row's ts within
 * `maxAgeSeconds` of now, optional content-binding via `scopeSha`, and — for every
 * authored-stage row in the chain — valid subagent-authorship provenance.
 * Returns the terminal row on success (gates use its artifact_sha256 for
 * content-binding) or a typed failure.
 */
export function verifyChain(opts: {
  ledgerPath: string;
  secretPath: string;
  slug: string;
  throughStage: Stage;
  maxAgeSeconds: number;   // 86400 (24h) for the dispatch gate — verify round 1
  scopeSha?: string;       // content-binding: terminal.artifact_sha256 must equal it, else SCOPE_SHA_MISMATCH
}): { ok: true; terminal: LedgerRow }
 | { ok: false; code: VerifyFailure; detail: string };
```

Verification rules, in order:
1. Every row for the slug up to `throughStage` has a valid `sig` recomputed from the secret (payload includes provenance fields) — else `BAD_SIG`.
2. `prev_sha256` chains correctly — else `CHAIN_BREAK`.
3. Strictly increasing `ts` in required-stage order — else `OUT_OF_ORDER`.
4. **Provenance (HOLE 3):** every `synthesize|plan|specs|review` row in the chain must carry all four provenance fields — else `NO_PROVENANCE`. Its `transcript_path` must exist — else `TRANSCRIPT_MISSING` — and hash to `transcript_sha256` — else `TRANSCRIPT_TAMPERED`. (The expensive authorship reconstruction ran once at emit time and is frozen by the signed `transcript_sha256`; verify-time only re-checks the freeze. The nightly audit independently re-runs the deep check — Spec 03.)
5. Terminal row age ≤ `maxAgeSeconds` — else `STALE`.
6. If `scopeSha` set: `terminal.artifact_sha256 === scopeSha` — else `SCOPE_SHA_MISMATCH`.

CLI wrapper for the bash gates: `pipeline-stage-emit --verify --slug <slug> --through <stage> --max-age <s> [--scope-sha <64-hex>]` — exit 0 + terminal row on stdout, or exit 1 + failure code on stderr. Gates need no inline node.

Note: the bash-hook `--verify` path executes as a hook subprocess (outside the agent's Read/Write tool policy); the sink calls `verifyChain` directly inside the daemon process. Both may read the secret; the agent's TOOL calls may not (Spec 02 §3 denies). If in implementation the hook subprocess turns out to be policy-covered, verify-via-emitter-binary remains the shape.

## Unit tests (`tests/pipeline-ledger.test.ts`)

Required cases:
1. Emit `research` → `prev_sha256 = GENESIS`, sig verifies.
2. Full chain `research→plan→specs` (with fixture transcripts) → `verifyChain(throughStage:"specs")` ok; terminal sha matches specs-dir hash.
3. **Forged sig:** hand-appended row, self-computed sig with wrong secret → `BAD_SIG`.
4. **Chain break:** emit `specs` with no `plan` row → exit 3; `verifyChain` → `CHAIN_BREAK`.
5. **Out of order:** crafted fixture with `plan.ts < research.ts` → `OUT_OF_ORDER`.
6. **Stale:** valid chain, terminal ts > `maxAgeSeconds` → `STALE`.
7. **Tampered artifact:** specs dir modified after emit → dispatch-time recomputed sha ≠ terminal `artifact_sha256` (content-binding; exercised by Spec 02, hash helper unit-tested here).
8. `exempt`: requires `--reason`; standalone verify ok; hand-written unsigned exempt JSON fails.
9. `true-verify` with empty evidence → exit 4.
10. Concurrent append race → both lines intact (lockfile test).
11. **HOLE 3 — missing provenance flags:** `--stage plan` without `--transcript` → exit 5, no row.
12. **HOLE 3 — hand-authored artifact:** artifact on disk NOT produced by the fixture transcript's writes → exit 6 `PROVENANCE_MISMATCH`, no row.
13. **HOLE 3 — real authorship passes:** fixture transcript whose Write blocks reconstruct the exact artifact bytes (incl. an Edit-after-Write sequence) → row appended with all four provenance fields, sig verifies.
14. **HOLE 3 — stale transcript reuse:** valid transcript, then artifact hand-edited → exit 6.
15. **HOLE 3 — verify-time freeze:** valid chain, then transcript file modified → `verifyChain` → `TRANSCRIPT_TAMPERED`; transcript deleted → `TRANSCRIPT_MISSING`; row with provenance fields stripped (re-signed impossible) → `BAD_SIG`; crafted unsigned-field-drop fixture → `NO_PROVENANCE`.
16. **HOLE 3 — directory coverage:** `03-specs/` with one file not written by the transcript → exit 6.

Tests never touch the real `~/.pipeline-secret` or real project transcripts; tmpdir secret + ledger + fixture transcripts via `--secret`/`--ledger` (path-under-projects-dir check overridable in tests via an env-guarded test hook, default strict).
