# 06 — Adversarial Review: kimi-k3-provenance-bridge

## VERDICT: PASS-WITH-NITS

The diff implements Direction 3 faithfully, the busSignPayload byte layout is **exact**, the anti-forge
trust chain holds against every bypass I attempted, worker mode adds-only (transcript path byte-identical),
`npm run build` + `tsc --noEmit` clean (exit 0), and all 33 tests across the three touched pipeline suites
pass. The only findings are nits + one inherited architectural caveat that is *not* a regression but must be
named because the whole bridge rests on it. No blocker.

Proof run:
- `npm run build` → Build success.
- `npx tsc --noEmit` → TSC_EXIT=0 (strict, clean).
- `npx vitest run worker-provenance.test.ts bypass-audit.test.ts ledger.test.ts` → **3 files, 33 tests, all passed.**

---

## Checklist

### 1. Scope match — PASS
Files changed (diff `diff --git` headers): `routing-config.json` (doc `$comment` only, lines 5-8),
`src/pipeline/bypass-audit.ts`, `src/pipeline/ledger.ts`, `src/pipeline/stage-emit.ts`,
`tests/unit/pipeline/bypass-audit.test.ts`, `tests/unit/pipeline/ledger.test.ts`, and new
`tests/unit/pipeline/worker-provenance.test.ts`. Exactly the spec-declared set (spec 02 Targets +
spec 01 target). `routing-config.json` change is doc-comment only (no `plan.engines` block invented —
spec 02 Part C honored). No out-of-scope file. **PASS.**

### 2. CRITICAL — busSignPayload byte layout — PASS (exact match)
Source of truth, `src/bus/message.ts:45-47`:
```ts
function signPayload(msgId: string, from: string, to: string, text: string): string {
  return `${msgId}:${from}:${to}:${text}`;   // colon-separated
}
```
signed via `hmacSign` = `createHmac('sha256', key).update(payload).digest('hex')` (message.ts:32-34).

Diff's reproduction, `src/pipeline/ledger.ts` (diff lines 275-277):
```ts
function busSignPayload(id: string, from: string, to: string, text: string): string {
  return `${id}:${from}:${to}:${text}`;   // colon-separated — IDENTICAL
}
```
verified via `ledger.ts:474`: `hmacSign(busKey, busSignPayload(...))`, and ledger's `hmacSign`
(`ledger.ts:157-159`) is byte-identical to bus's: `createHmac('sha256', secret).update(payload).digest('hex')`.

Field order (`id,from,to,text`), separator (`:`), algorithm (HMAC-SHA256), and encoding (hex) all match
byte-for-byte. **This is the #1 risk and it is clean.**

Note on the spec: spec 01 §5.1 *illustrated* the helper with a `|` separator but explicitly instructed
"confirm the separator/order against src/bus/message.ts ... A mismatch silently breaks all worker-mode
verification, so this is the one line to verify against source, not assume." The implementer correctly
ignored the placeholder and used the real `:`. Both test helpers also use `:`
(`worker-provenance.test.ts:41-43`, `bypass-audit.test.ts:49-51`), so the tests exercise the real sig path
end-to-end (not a self-consistent-but-wrong shadow layout). Had the tests used `|` to match the spec, they'd
have passed against a broken impl — they don't. Correct on both sides.

### 3. Anti-forge guarantee — PASS (all four bindings enforced; bypasses blocked)
`verifyWorkerAttestationMessage` (ledger.ts diff 396-503) requires, in order, all of:
- (a) message resolves inside bus store via `ensureInsideRoot` (which uses `realpathSync`, so symlink
  path-escape is blocked — ledger.ts:374-386) — else `TRANSCRIPT_MISSING` (diff 407-413).
- (b) bus key present — else `NO_PROVENANCE` (diff 416-422).
- (c) `WORKER_AUTHORS.has(msg.from)` i.e. `from ∈ {opencode,opencoder}` — else `PROVENANCE_MISMATCH`
  (diff 440-446).
- (d) `verifyBusMessageSig` (HMAC over the exact layout) — else `TRANSCRIPT_TAMPERED` (diff 447-453).
- (e) PROVENANCE line parses AND `attestedStage===stage` AND `attestedSlug===slug` (diff 455-480).
- (f) `msg.reply_to` present AND `resolveDispatchForReply` → dispatch found, `from==='larry'`, dispatch
  bus-sig valid, text is `GATE: build`, dispatch slug === opts.slug (diff 481-495, 534-393).

Only after all six does emit add the (g) `attested_sha256 === describeArtifact(artifactPath).sha256`
disk-hash check (`verifyWorkerDispatchAuthorship`, diff 524-531).

**Bypass attempts (all failed to break it):**
- *Replay opencode attestation for slug A onto slug B*: text says `slug=A`; caller passes `slug=B`;
  `attestedSlug !== opts.slug` → `PROVENANCE_MISMATCH` (diff 474-480). Also the reply_to dispatch slug must
  == B (diff 385). Blocked twice. Tested by `worker-provenance.test.ts` "reply_to dispatch slug mismatches".
- *Free-floating attestation (no dispatch)*: `reply_to` missing → mismatch (diff 481-487); `reply_to` to a
  non-existent id → `TRANSCRIPT_MISSING` (diff 360-364). Tested "reply_to dispatch is missing".
- *reply_to points at a non-larry or unsigned dispatch*: `from!=='larry'` → mismatch; bad sig →
  `TRANSCRIPT_TAMPERED` (diff 368-381).
- *Spoof `from:opencode` by editing the JSON without re-signing*: sig was computed over `from:larry`;
  `verifyBusMessageSig` recomputes over the on-file `from:opencode` and fails → `TRANSCRIPT_TAMPERED`.
  Tested "from field is spoofed without re-signing" (`worker-provenance.test.ts:246-255`).
- *Larry authors bytes, opencode attests the same sha later*: still passes provenance (by design), BUT
  bypass-audit `hole3-hand-authoring` stays ON for worker mode (kept, diff did not gate it by mode) — Larry
  writing planning bytes in his own parent transcript trips it regardless. Defense-in-depth intact.

**PASS.**

### 4. Fail-closed — PASS
Missing/short bus key → `loadBusSigningKey` returns null (ledger.ts diff 279-287; `<16` chars → null), and
every entry point treats null as `NO_PROVENANCE` and throws/returns loud (emit path: diff 594-596 throws
`${code}: ${detail}`; attestation: diff 416-422). No silent downgrade to transcript mode anywhere. Verified
by test "bus signing key is unreadable" → throws `/NO_PROVENANCE/`. **PASS.**

### 5. Adds-only — PASS
Transcript-mode branch is untouched: `mode = opts.provenanceMode ?? 'transcript'` and the `else` calls the
original `verifyTranscriptAuthorship` verbatim (emit: diff 586-593; bypass-audit: diff 120-125;
verifyChainDetailed: worker branch is an *additional* block after the existing tamper check, diff 1127-1152).
`canonicalPayload` appends `provenance_mode` only when present (diff 235), and `emitLedgerRow` writes the
field only for worker-dispatch (diff 607) — so existing transcript rows produce byte-identical HMAC sigs.
Confirmed by the passing regression test "keeps transcript-mode rows unchanged when provenance_mode is
absent" and the whole pre-existing `ledger.test.ts` suite still green (it added only the one
`provenance_mode` line to its `signRow` helper, diff 1038, which is inert for absent values). **PASS.**

### 6. bypass-audit — PASS
- `dispatch-no-chain` path unchanged; test "flags an unbacked worker dispatch with dispatch-no-chain"
  proves an opencode `GATE: build` with no signed chain still fires `NO_ROWS`/`dispatch-no-chain`.
- hole3 authorship pass branches on `row.provenance_mode` to `verifyWorkerDispatchAuthorship` for worker
  rows (diff 865-873) while the tamper/hash-drift check upstream is shared. `checkTranscriptStructure` is
  correctly gated to `mode === 'transcript'` only (diff 142-153) — a bus message would fail the Claude-jsonl
  structure assertions, so skipping it for worker mode is right, and the worker verifier enforces the
  worker-specific structure instead. Test "accepts a valid worker-dispatch row without hole3-structure
  findings" + "flags worker-dispatch return-message tampering as hole3-deep-authorship / TRANSCRIPT_TAMPERED"
  prove both directions. **PASS.**

### 7. Code quality — PASS
New code uses discriminated unions + `unknown`-then-narrow (`parseBusMessageFile` uses `let value: unknown`,
ledger.ts:429; field-by-field `typeof` guards). The `let value: any` at ledger.ts:430 and the three
`console.log`s (bypass-audit.ts:1014/1035, stage-emit.ts:76) are **pre-existing** (confirmed absent from the
diff hunks) — not introduced here. Every provenance failure is a typed `ProvenanceFailure` with a code or a
thrown `Error(\`${code}: ${detail}\`)`; no warn-and-continue. Strict `tsc --noEmit` exits 0. **PASS.**

### 8. Tests — PASS (11 fail-direction cases, both directions)
`worker-provenance.test.ts` (new, 412 lines) — 1 happy-path emit+verify+OBF, plus **fail cases**:
larry-forged from (2), bus-sig tamper (3), from-spoof-no-resign (4), artifact hash drift (5), dispatch slug
mismatch (6), missing dispatch (7), no PROVENANCE line (8), unreadable key (9), message outside bus root
(10), verify-time tamper (12) — plus a transcript-mode regression (11). That is **10 explicit fail-direction
assertions + 1 regression**, covering every trust-chain edge including the verify-time (not just emit-time)
tamper path. bypass-audit.test.ts adds the unbacked-dispatch, valid-worker-row, and tamper→hole3 cases.
Far beyond happy-path-only. **PASS.**

---

## Bypass attempts summary (what I tried, and the result)

| Attack | Path exercised | Result |
|---|---|---|
| Replay slug-A attestation as slug-B | attestedSlug + dispatch-slug both bound to caller slug | BLOCKED (`PROVENANCE_MISMATCH`) |
| Free-floating attestation, no dispatch | `reply_to` required + resolved | BLOCKED (`PROVENANCE_MISMATCH`/`TRANSCRIPT_MISSING`) |
| Edit `from` to opencode without re-sign | sig recomputed over on-file fields | BLOCKED (`TRANSCRIPT_TAMPERED`) |
| Swap message file post-emit for valid-sha-different-content | verifyChainDetailed re-runs full attestation, not just file hash | BLOCKED (`TRANSCRIPT_TAMPERED`, test 12) |
| Symlink `transcript_path` out of bus store | `ensureInsideRoot` uses `realpathSync` | BLOCKED (`TRANSCRIPT_MISSING`) |
| Point reply_to at unsigned/non-larry dispatch | `from==='larry'` + dispatch sig verified | BLOCKED |
| Larry hand-writes bytes, opencode attests same sha | provenance passes, but hole3-hand-authoring still fires on parent-transcript write | FLAGGED (defense-in-depth intact) |

---

## Caveat worth naming (NOT a blocker, NOT introduced by this diff)

The entire anti-forge guarantee ultimately rests on a **single shared symmetric HMAC key**
(`~/.cortextos/cortextos1/config/bus-signing-key`, `0600 joshweiss:staff`). The claim "Larry cannot mint a
`from:opencode` signature" is true **only under process isolation** — the H10 model where each agent's daemon
signs with its own identity but the *same key*. Cryptographically, any actor with read access to that key can
compute a valid `from:opencode` signature; there is no per-agent asymmetric identity. This diff inherits that
model verbatim (and the master-plan explicitly chose it over Direction 2's second key to avoid new key
surface — a defensible call). So it's not a regression and not a reason to hold this PR. But the guarantee is
"as strong as bus H10," not stronger — worth stating plainly so no one over-trusts the bridge as
cryptographic authorship separation. If the bus ever moves to per-agent keypairs, this bridge upgrades for
free.

## Nits (non-blocking)
- `verifyWorkerAttestationMessage` reads the file twice (`readFileSync` at diff 424 for `raw`, then
  `parseBusMessageFile` re-reads at 425). Harmless, minor I/O. Could pass `raw` in.
- `expectedMessageId` is optional and only enforced when provided; at verify time it's fed `row.session_id`
  (diff 1141) so it *is* bound there — fine — but at emit time a caller omitting sessionId would skip the id
  match. `emitLedgerRow` already hard-requires `sessionId` for authored stages (diff 559-561), so this is
  covered in practice. No action needed.

---
Reviewed against: 04-review-packet.diff; src/bus/message.ts; live src/pipeline/{ledger,stage-emit,bypass-audit}.ts; 02-master-plan.md; 03-specs/01,02.
