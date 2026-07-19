# Spec 02 — CLI (`stage-emit.ts`), bypass-audit, routing doc, and tests

Targets:
- `/Users/joshweiss/code/cortextos/src/pipeline/stage-emit.ts`
- `/Users/joshweiss/code/cortextos/src/pipeline/bypass-audit.ts`
- `/Users/joshweiss/code/cortextos/.claude/workflows/routing-config.json` (doc-comment only)
- `/Users/joshweiss/code/cortextos/tests/unit/pipeline/worker-provenance.test.ts` (new)

Strict TS, no `any`, no `console.log` in library code (CLI uses existing `printAndExit`), fail-closed.

---

## Part A — `src/pipeline/stage-emit.ts`

### A.1 New flags (emit path only)

In the `emitLedgerRow` call inside `main()`, pass through:

```ts
      provenanceMode: (() => {
        const v = stringFlag(flags, 'provenance-mode');
        if (v === 'worker-dispatch' || v === 'transcript') return v;
        if (v !== undefined) throw new Error('Invalid --provenance-mode: expected transcript|worker-dispatch');
        return undefined;
      })(),
      busStoreRoot: stringFlag(flags, 'bus-store-root'),
      busKeyCtxRoot: stringFlag(flags, 'ctx-root') || stringFlag(flags, 'bus-store-root'),
```

- `--provenance-mode <transcript|worker-dispatch>` — default absent ⇒ transcript.
- `--bus-store-root <path>` — test/override for the bus store root.
- `--ctx-root <path>` — dir containing `config/bus-signing-key` (defaults to bus-store-root, then
  `defaultBusStoreRoot()` inside `emitLedgerRow`).
- In worker mode, `--transcript <path>` is the **opencode→larry return message JSON file**;
  `--session <id>` is the return message id (used as the session anchor); `--runner` = `opencode`.

### A.2 `usage()` — add worker-mode line

Append to the emit usage:

```
  pipeline-stage-emit --slug <slug> --stage <plan|specs> --artifact <path> --provenance-mode worker-dispatch --runner opencode --session <return-msg-id> --transcript <return-msg.json> [--bus-store-root <path>] [--ctx-root <path>]
```

### A.3 Error mapping

No new codes. `mapEmitError` already routes `NO_PROVENANCE` / `TRANSCRIPT_*` / `PROVENANCE_MISMATCH`
to exit 6. Confirm the new `Invalid --provenance-mode` message hits the `Invalid ` branch ⇒ exit 5.

### A.4 Verify path

`--verify` needs no new flags for the gate to work (the gate calls `--verify --through specs`).
`verifyChainDetailed` reads `provenance_mode` off each row and self-selects the root. Add an optional
`--bus-store-root` pass-through into the `verifyChainDetailed` call for test determinism:

```ts
      busStoreRoot: stringFlag(flags, 'bus-store-root'),
```

---

## Part B — `src/pipeline/bypass-audit.ts`

The nightly auditor MUST still catch an unbacked opencode dispatch and must not false-positive on a
legitimate worker-mode row.

### B.1 Import

Add `verifyWorkerDispatchAuthorship` (and `defaultBusStoreRoot`) to the `./ledger.js` import.

### B.2 `hole3` deep-authorship pass — branch by mode

Currently the pass unconditionally calls `verifyTranscriptAuthorship` and then
`checkTranscriptStructure`. Change the per-`row` block:

```ts
const mode = row.provenance_mode === 'worker-dispatch' ? 'worker-dispatch' : 'transcript';

let provenance;
if (mode === 'worker-dispatch') {
  provenance = verifyWorkerDispatchAuthorship({
    artifactPath,
    messagePath: row.transcript_path || '',
    slug: row.slug,
    busStoreRoot: defaultBusStoreRoot(),
    busKey: loadBusSigningKeyForAudit(), // see B.4
  });
} else {
  provenance = verifyTranscriptAuthorship({
    artifactPath,
    transcriptPath: row.transcript_path || '',
    transcriptRoot,
    expectedSessionId: row.session_id,
  });
}
if (!provenance.ok) {
  bypasses.push(pushBypass('hole3-deep-authorship', provenance.detail, [...rowEvidence, artifactPath], row.slug, provenance.code));
  continue;
}
```

- Keep the `row.transcript_sha256 !== provenance.transcript_sha256` drift check for BOTH modes
  (unchanged block).
- `checkTranscriptStructure(row)`: call it ONLY when `mode === 'transcript'`. A bus message is not a
  Claude jsonl (no `isSidechain`, no assistant `tool_use` turns), so the structure assertions would
  false-positive. For worker-dispatch rows, `verifyWorkerDispatchAuthorship` already enforces the
  worker-specific structural guarantees (bus sig, from-identity, dispatch binding, hash match), so
  skip `checkTranscriptStructure`.
- `hole3-hand-authoring` (larry parent transcript wrote the planning bytes): **KEEP for both modes**.
  Rationale in master-plan security analysis — the legitimate worker flow never has larry write the
  bytes, so this staying on is correct defense-in-depth, not a false positive.

### B.3 `dispatch-no-chain` path — unchanged

The dispatch loop already flags any opencode `GATE: build` whose slug fails `--through specs`
verification. Worker-mode rows verify through that same `verifyChainDetailed` (now mode-aware), so an
unbacked worker dispatch still produces `dispatch-no-chain`. No change needed; add a regression test.

### B.4 Bus key for audit

Add a small helper (audit runs from the ctxRoot passed on CLI):

```ts
function loadBusSigningKeyForAudit(ctxRoot: string): string | null {
  try {
    return readFileSync(join(resolve(ctxRoot), 'config', 'bus-signing-key'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
```

Thread `opts.ctxRoot` into the `hole3` loop so the worker branch can load the key. `runBypassAudit`
already receives `ctxRoot`. If the key is unreadable, `verifyWorkerDispatchAuthorship` returns
`NO_PROVENANCE` ⇒ the row is flagged `hole3-deep-authorship` (fail-closed, loud) rather than silently
passing.

---

## Part C — `routing-config.json` doc-comment

Change only the `$comment` to note the bridge (no functional/behavioral change):

```json
  "$comment": "Per-stage model routing for dynamic-pipeline. provider ∈ anthropic|openrouter|codex. Fable is opt-in at plan only; when not explicitly confirmed, plan falls back to opus. plan.engines.kimi-k3 dispatches to the opencode bus worker; its plan/specs are provenance-signed via provenance_mode=worker-dispatch (see src/pipeline/ledger.ts verifyWorkerDispatchAuthorship).",
```

(If `plan.engines` is not present in this file, add the comment text only; do not invent an engines
block — K3 engine wiring is out of scope per research.)

---

## Part D — Tests: `tests/unit/pipeline/worker-provenance.test.ts` (new)

Use vitest, matching `tests/unit/pipeline/ledger.test.ts` conventions (tmpdir fixtures, no mocks of
the ledger itself). Fixtures build REAL signed bus messages so the sig path is exercised end-to-end.

### D.1 Fixture helpers

```ts
import { createHmac } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// MUST match busSignPayload in ledger.ts AND src/bus/message.ts.
function busSign(key: string, id: string, from: string, to: string, text: string): string {
  return createHmac('sha256', key).update(`${id}|${from}|${to}|${text}`).digest('hex');
}

function writeBusMessage(dir: string, msg: {
  id: string; from: string; to: string; text: string; reply_to?: string | null; busKey?: string; sig?: string;
}): string {
  mkdirSync(dir, { recursive: true });
  const sig = msg.sig ?? (msg.busKey ? busSign(msg.busKey, msg.id, msg.from, msg.to, msg.text) : undefined);
  const path = join(dir, `2-${msg.id}.json`);
  writeFileSync(path, JSON.stringify({
    id: msg.id, from: msg.from, to: msg.to, priority: 'normal',
    timestamp: new Date().toISOString(), text: msg.text,
    reply_to: msg.reply_to ?? null, ...(sig ? { sig } : {}),
  }), 'utf-8');
  return path;
}
```

### D.2 Common setup (per test)

- `busStoreRoot = mkdtemp(...)`; write `config/bus-signing-key` = `'bk'.repeat(20)`.
- `pipelineSecret` at `.pipeline-secret` = `'ab'.repeat(32)`.
- OBF repo tree: `<repo>/.agent/one-big-feature/<slug>/{01-research.md,02-master-plan.md,03-specs/01-x.md}`.
- Compute `planSha = describeArtifact(planPath).sha256`.
- Larry dispatch: `writeBusMessage(<busStoreRoot>/processed/opencode, {id:'D1', from:'larry',
  to:'opencode', text:'GATE: build framework=one-big-feature slug=<slug> repo=<repo> scope-sha=...',
  busKey})`.
- Opencode return: `writeBusMessage(<busStoreRoot>/processed/larry, {id:'R1', from:'opencode',
  to:'larry', reply_to:'D1', text:'done\nPROVENANCE: stage=plan slug=<slug> artifact-sha256=<planSha>',
  busKey})` → returns `returnMsgPath`.

### D.3 Required test cases (both directions)

1. **PASS — worker-authored plan+specs verify --through specs (framework one-big-feature).**
   - Emit research (unauthored), then plan and specs in `worker-dispatch` mode
     (`provenanceMode:'worker-dispatch'`, `runner:'opencode'`, `sessionId:'R1'`,
     `transcriptPath:returnMsgPath`, `busStoreRoot`, `busKeyCtxRoot:busStoreRoot`).
   - `verifyChainDetailed({slug, throughStage:'specs', scopeSha:describeArtifact(specsDir).sha256,
     busStoreRoot, ...})` ⇒ `ok:true`.
   - `verifyOneBigFeatureArtifacts` ⇒ `ok:true`.
   - Assert emitted rows carry `provenance_mode:'worker-dispatch'`.

2. **FAIL — larry-forged identity.** Return message with `from:'larry'` (still bus-signed correctly).
   `emitLedgerRow` throws `/PROVENANCE_MISMATCH/` (not a pipeline worker).

3. **FAIL — bus-sig tamper.** Return message with `from:'opencode'` but a wrong/edited `sig` (write
   with `sig:'00'.repeat(32)`). Emit throws `/TRANSCRIPT_TAMPERED/`.

4. **FAIL — from spoofed without re-sign.** Write the return message signed as `larry` but overwrite
   the `from` field to `opencode` in the JSON (sig computed over `from:larry`). Emit throws
   `/TRANSCRIPT_TAMPERED/` (sig no longer matches `opencode` payload).

5. **FAIL — artifact hash drift.** Valid attestation for `planSha`, then overwrite `planPath` with
   new bytes before emit. Emit throws `/PROVENANCE_MISMATCH/` (attested sha != on-disk).

6. **FAIL — dispatch slug mismatch.** Return attests `slug=<X>` but `reply_to` dispatch D1 has
   `slug=<Y>`. Emit throws `/PROVENANCE_MISMATCH/`.

7. **FAIL — missing dispatch.** `reply_to:'NOPE'` (no such message). Emit throws
   `/TRANSCRIPT_MISSING|PROVENANCE_MISMATCH/`.

8. **FAIL — no PROVENANCE line.** Return text is prose only. Emit throws `/PROVENANCE_MISMATCH/`.

9. **FAIL — bus key unreadable.** No `config/bus-signing-key` file. Emit throws `/NO_PROVENANCE/`.

10. **FAIL — message outside bus store root.** `transcriptPath` pointing at a file outside
    `busStoreRoot`. Emit throws `/TRANSCRIPT_MISSING/`.

11. **Regression — transcript mode unaffected.** A transcript-mode plan (Claude jsonl fixture like
    ledger.test.ts) still emits+verifies with no `provenance_mode` on the row, byte-identical sig.

12. **Verify-time tamper.** After a PASS emit (case 1), overwrite the return message file with
    different-but-valid-JSON (breaking its sha). `verifyChainDetailed` ⇒ `TRANSCRIPT_TAMPERED`.

### D.4 bypass-audit worker cases (extend existing bypass-audit test file if present, else new)

- **Unbacked worker dispatch flagged:** an opencode `GATE: build` dispatch in the parent transcript
  fixture with NO ledger chain ⇒ report contains a `dispatch-no-chain` finding for that slug.
- **Worker-mode row with tampered return message ⇒ `hole3-deep-authorship` / `TRANSCRIPT_TAMPERED`.**
- **Legitimate worker-mode row does NOT trip `hole3-structure`** (structure check skipped for worker
  mode) — assert no `hole3-structure` finding for the valid slug.

---

## Acceptance (this spec)

- `npm run build` clean (strict TS, no `any`).
- `npm test` green including the new `worker-provenance.test.ts`.
- Cases 1 (PASS) and 2–10,12 (FAIL) all present and green — proves both directions.
- No `console.log` added to `src/pipeline/*`.
- `gate-codexer-planning.sh` unchanged and clears a worker-authored fixture slug when run against a
  test bus store (manual staging step, documented in the PR, not a unit test).
