# 02 — Master Plan: Kimi K3 → provenance bridge

Framework: one-big-feature. Repo: `/Users/joshweiss/code/cortextos`. Slug: `kimi-k3-provenance-bridge`.

## Objective

Let a kimi-k3-planned build — whose `plan` and `specs` artifacts are authored by the **Opencoder
bus worker** (not a Claude Agent-tool subagent) — be provenance-signed into the pipeline ledger and
clear the dispatch gate (`gate-codexer-planning.sh` → `pipeline-stage-emit --verify --through specs`),
**without weakening the anti-hand-authoring guarantee** the gate exists to enforce.

The gate today only knows one way to prove authorship of an authored stage (`synthesize|plan|specs|
review`): replay a Claude `jsonl` transcript's `Write`/`Edit` tool ops and reconstruct the artifact
bytes (`verifyTranscriptAuthorship` → `parseTranscriptOps` → `reconstructFile`). Opencode does not
produce such a transcript, so a K3-authored artifact can never satisfy it. PR #119 wired the routing
choice and never built this bridge; the routing config already treats K3 as first-class
(`dispatch:'opencode'`, `fallback:'opus'`, `on429:'opus'`).

## Chosen design — Direction 3 (Hybrid: K3 plans, provenance binds the dispatch), with a hard
## authorship anchor

### Why not Direction 1 (worker-transcript byte-replay)

**Ruled out by observed fact.** `~/.cortextos/cortextos1/state/opencode/conversation-buffer.jsonl`
records only outbound Telegram lines: `{ts, sender, via, content, chat_id}`. It contains **no
file-write tool ops and no post-write file contents**. There is no opencode artifact anywhere under
`state/opencode/` containing `tool_use` / `file_path` / `Write` records (grep returned nothing).
Byte reconstruction is therefore impossible — Direction 1 cannot be built against the real worker,
only against a hypothetical future transcript format. Rejected.

### Why not Direction 2 (worker self-signed emit with a worker secret)

Introduces a **second signing authority** (a worker-scoped secret) into a system whose whole trust
model is one HMAC secret at `~/.pipeline-secret`, readable only by the signer. A worker secret means
another key to provision, rotate, and protect, and it moves the authorship claim to "whoever holds
the worker secret" rather than to a daemon-attributed identity. More attack surface, no extra
guarantee over Direction 3. Rejected.

### Chosen: Direction 3 — bind to the opencode→larry **signed bus return message**

The authorship anchor already exists and is unforgeable by Larry: the **bus message store**. Every
bus message is HMAC-signed with the shared bus key (`config/bus-signing-key`) over
`signPayload(id, from, to, text)` (`src/bus/message.ts`). The `from` field is set by the **sending
agent's own daemon process** — Larry's process signs `from:larry`, opencode's process signs
`from:opencode`. Larry **cannot** mint a message signed `from:opencode`; that is exactly the H10
guarantee bus signing was built for.

So when opencode finishes authoring the plan/specs on disk, it sends larry a normal signed bus reply
(`from:opencode`, `to:larry`, `reply_to:<larry's GATE: build dispatch id>`) whose text carries the
**sha256 of the artifact it just wrote**. That reply is a cryptographically opencode-attributed
statement: "I, opencode, authored the artifact with this hash, in response to this dispatch." The
bridge binds the ledger row to that reply.

**Provenance for a worker-authored stage = verify a signed bus artifact-attestation, not replay a
keystroke transcript.** The ledger's existing "transcript" slot is reused to point at the return
message file; a new `provenance_mode` discriminates the two verification paths.

## Trust chain (what makes this un-forgeable)

For an opencode-authored `plan`/`specs` row to verify, ALL must hold:

1. **Return message exists and is bus-signed.** The file at `transcript_path` parses as a bus
   message and its `sig` verifies under the bus signing key over `signPayload(id, from, to, text)`.
   A tampered or hand-written file fails the bus-sig check (`TRANSCRIPT_TAMPERED`).
2. **Author identity = opencode.** `msg.from === 'opencode'` (worker set, configurable via allowed
   worker set). Larry cannot produce this signature → Larry cannot self-author. This is the core of
   the anti-drafting guarantee.
3. **Bound to a real dispatch.** `msg.reply_to` resolves to a larry→opencode message whose text is a
   parseable `GATE: build` directive (`parseBuildDirective`) for the **same slug**, and that dispatch
   message ALSO bus-verifies (`from:larry`). No free-floating attestation; it must answer a real,
   signed build dispatch.
4. **Artifact-hash attestation matches disk.** The return text carries `artifact-sha256=<64hex>`
   which equals `describeArtifact(artifactPath).sha256`. If Larry edits the artifact after opencode
   attested it, the hash diverges → `PROVENANCE_MISMATCH`. This is the byte-integrity check that
   replaces reconstruction.
5. **Existing chain invariants still apply.** HMAC row sig, prev-sha linkage, stage ordering,
   staleness, scope-sha binding, and (for OBF) `verifyOneBigFeatureArtifacts` mtime+sha checks are
   unchanged and run on top of the above.

Because (2) is daemon-attributed and (4) is content-bound, there is **no path** for any actor other
than opencode to produce a passing worker-mode row, and no path for opencode's attested bytes to
drift from disk without detection.

## Data / format model

### New provenance mode on the ledger row

Add an optional `provenance_mode?: 'transcript' | 'worker-dispatch'` field to `LedgerRow`
(default/absent ⇒ `'transcript'`, fully backward-compatible). It participates in `canonicalPayload`
(appended only when present, mirroring the existing optional-field pattern) so it is covered by the
row HMAC and cannot be flipped post-signing.

### Worker return-message format (opencode → larry)

A normal signed bus message. Its `text` MUST contain a machine-parseable attestation line:

```
PROVENANCE: stage=<plan|specs> slug=<slug> artifact-sha256=<64-hex-lowercase>
```

(Free prose may surround it.) The message's own `id`, `from`, `to`, `text`, `sig`, `reply_to` are the
signed bus fields already produced by `bus send-message`. `transcript_path` on the ledger row points
at this message's on-disk JSON file (in `inbox/larry/` or `processed/larry/`); `transcript_sha256` is
the sha256 of that file's bytes (reused verbatim by the existing verify-time tamper check).

### Bus store as the dispatch index

`reply_to` → the larry→opencode dispatch message. Resolution scans the bus store dirs
(`inbox|inflight|processed` × `{larry-outbound to opencode}`) by id, exactly as `bypass-audit`
already reads the store (`readBusDispatches`). No new persistence; both messages are already durable.

## File-by-file change list

1. **`src/pipeline/ledger.ts`** (core)
   - Add `provenance_mode?: 'transcript' | 'worker-dispatch'` to `LedgerRow`; thread it through
     `parseLedgerLine`, `canonicalPayload` (append when present), `verifyRowSignature`.
   - Add `ProvenanceFailureCode` members already exist (`PROVENANCE_MISMATCH`, `TRANSCRIPT_MISSING`,
     `TRANSCRIPT_TAMPERED`, `NO_PROVENANCE`) — reuse, no new codes needed.
   - New pure fn `verifyBusMessageSig(msg, busKey): boolean` (HMAC over `signPayload`-equivalent).
     Import/duplicate the canonical `signPayload(id,from,to,text)` shape from bus to avoid a runtime
     dep cycle — define a local `busSignPayload` matching `src/bus/message.ts` exactly.
   - New fn `loadBusSigningKey(ctxRoot): string | null` (reads `config/bus-signing-key`; same shape
     as bus loader; returns null if absent → fail-closed at call site).
   - New fn `resolveDispatchForReply(opts): {ok:true; directive} | {ok:false; code; detail}` — given
     a `reply_to` id + ctxRoot + slug, locate the larry→opencode message by id across bus store
     buckets, verify its bus sig + `from:larry`, `parseBuildDirective(text)`, and assert
     `directive.slug === slug`.
   - New fn `verifyWorkerDispatchAuthorship(opts): ProvenanceResult` — the worker-mode analogue of
     `verifyTranscriptAuthorship`. Steps = trust chain (1)–(4) above. On success returns
     `{ok:true, transcript_sha256: sha256(messageFileBytes), transcript_realpath: messageFilePath}`.
   - `emitLedgerRow`: extend opts with `provenanceMode?`, `workerName?`, `busKeyPath?`/`ctxRoot?`.
     When `isAuthoredStage` AND `provenanceMode==='worker-dispatch'`, require `runner`,
     `sessionId` (the dispatch/return message id used as session anchor), and `transcriptPath` (the
     return-message file), then call `verifyWorkerDispatchAuthorship` instead of
     `verifyTranscriptAuthorship`. Persist `provenance_mode` on the row. `transcript` mode unchanged.
   - `verifyChainDetailed`: in the per-row provenance re-check loop, branch on `row.provenance_mode`.
     For `'worker-dispatch'`, keep the existing field-presence + tamper checks
     (`transcript_path` exists, `sha256(bytes)===transcript_sha256`) — those already suffice because
     the return-message file is what `transcript_path` points at — AND additionally re-verify the bus
     sig + `from:opencode` + `reply_to` dispatch binding via `verifyWorkerDispatchAuthorship` so a
     post-hoc swap of the message file for a different-but-valid-sha file is caught. Bound by
     `ensureInsideRoot(transcript_path, busStoreRoot)` (new allowed root for worker mode; see below).

2. **`src/pipeline/ledger.ts` — root allow-listing**
   - `defaultTranscriptRoot()` stays `~/.claude/projects` for transcript mode.
   - New `defaultBusStoreRoot()` = `resolve(process.env.PIPELINE_BUS_STORE_ROOT_OVERRIDE ||
     join(homedir(), '.cortextos', 'cortextos1'))`. Worker-mode `transcript_path` must resolve inside
     this root (via the existing `ensureInsideRoot`), not the projects root — a fail-closed path
     containment check identical in spirit to the transcript-mode one.

3. **`src/pipeline/stage-emit.ts`** (CLI)
   - New flags: `--provenance-mode <transcript|worker-dispatch>` (default `transcript`),
     `--worker <name>` (default `opencode`), `--reply-to <bus-msg-id>` (optional convenience; may be
     derived from the return-message file), `--bus-store-root <path>` (test override), `--ctx-root
     <path>` (locates `config/bus-signing-key`). Thread into `emitLedgerRow`.
   - `mapEmitError`: no new codes; `PROVENANCE_MISMATCH` / `TRANSCRIPT_*` / `NO_PROVENANCE` already
     map to exit 6.
   - Update `usage()` string.

4. **`src/pipeline/bypass-audit.ts`** (nightly auditor — must still catch an unbacked worker dispatch)
   - The existing dispatch loop already flags any `GATE: build` opencode dispatch whose slug lacks a
     valid `--through specs` chain (`dispatch-no-chain`). That path is unchanged and still fires for a
     worker dispatch with no signed row.
   - The `hole3-*` deep-authorship pass currently calls `verifyTranscriptAuthorship` unconditionally.
     Branch it on `row.provenance_mode`: for `'worker-dispatch'` rows call
     `verifyWorkerDispatchAuthorship` (same signature-shaped `ProvenanceResult`) and keep the
     `transcript_sha256` drift check. Keep `checkTranscriptStructure` **only** for transcript-mode
     rows (a bus message is not a Claude jsonl and would fail the sidechain/tool_use structure
     assertions) — for worker-dispatch rows, replace structure-check with a worker-attestation check:
     `from:opencode` + `reply_to` dispatch exists + attested sha matches on-disk artifact.
   - `hole3-hand-authoring`: KEEP as-is. Larry directly writing the plan/specs bytes in his parent
     transcript still trips this for a worker-mode row too — which is correct: even if opencode later
     attests the same bytes, larry's parent-transcript write is a hand-authoring signal worth
     flagging. (Discussed in Security analysis: this is defense-in-depth, not a false positive,
     because the legitimate worker flow has larry dispatch + opencode author, never larry write.)

5. **`routing-config.json`** — no functional change. Add a `$comment` note that `plan.engines.kimi-k3`
   dispatches to opencode and its provenance is bound via `provenance_mode=worker-dispatch` (doc only;
   the routing-policy resolution is out of scope per research).

6. **Tests** — `tests/unit/pipeline/worker-provenance.test.ts` (new), plus additions to the bypass-
   audit test surface. See spec 03-specs/02.

No product code outside `src/pipeline/*` and `routing-config.json` doc-comment. `gate-codexer-
planning.sh` needs **no change**: it already calls `pipeline-stage-emit --verify --through specs`,
which now transparently verifies worker-mode rows via `verifyChainDetailed`.

## Security analysis — how the anti-drafting guarantee is preserved

**Guarantee restated:** the specs handed to a build worker are the exact bytes a *tracked runner*
produced in-session, NOT hand-authored drafts Larry slipped onto disk.

- **Larry cannot self-author a worker-mode row.** Passing worker-mode provenance requires a bus
  message signed `from:opencode`. The `from` field is bound by the sending daemon's identity and
  signed with the bus key; Larry's process signs `from:larry`. Larry has no way to emit a
  `from:opencode` signature → cannot forge the attestation. (Same H10 property already trusted by the
  live bus.)
- **A stolen/replayed attestation is slug- and dispatch-bound.** The return message must `reply_to` a
  real, bus-signed larry→opencode `GATE: build` dispatch for the *same slug*. An opencode attestation
  for slug A cannot be reused to sign slug B; the `reply_to` dispatch's parsed slug must match.
- **Artifact bytes cannot drift.** The attested `artifact-sha256` must equal
  `describeArtifact(artifactPath).sha256` at emit time, and `verifyChainDetailed` re-runs the full
  worker-authorship check (not just a file-hash) at every verify, so swapping the artifact or the
  message file after the fact fails `PROVENANCE_MISMATCH` / `TRANSCRIPT_TAMPERED`.
- **No new unbacked path.** `emitLedgerRow` still refuses any authored stage without runner + session
  + transcript; worker mode adds *more* required checks (bus sig, from-identity, dispatch binding,
  hash match), never fewer. There is no branch that emits an authored row without a verifiable
  binding.
- **bypass-audit still catches an unbacked opencode dispatch.** An opencode `GATE: build` with no
  signed specs chain trips `dispatch-no-chain` unchanged. A worker-mode row that somehow lands in the
  ledger without a valid attestation trips `hole3-deep-authorship` (worker branch) or the tamper/hash
  drift checks. `hole3-hand-authoring` still fires if Larry wrote the bytes in his own transcript.
- **Fail-closed, loud.** Missing bus key ⇒ treat as `NO_PROVENANCE`/unreadable and throw (never
  silently downgrade to transcript mode or skip the check). Missing/מalformed return message ⇒
  `TRANSCRIPT_MISSING`. Wrong `from` ⇒ `PROVENANCE_MISMATCH`. Every failure is a thrown error / typed
  failure with a code, never a warn-and-continue.

## Test plan (both directions proven — required by acceptance)

1. **PASS (worker-authored):** fixture bus dispatch (larry→opencode, `GATE: build slug=X`, bus-
   signed) + fixture return message (opencode→larry, `reply_to` the dispatch, `PROVENANCE: stage=plan
   slug=X artifact-sha256=<sha of plan bytes>`, bus-signed) + on-disk plan/specs matching the sha.
   `emitLedgerRow` in `worker-dispatch` mode succeeds; `verifyChainDetailed --through specs` PASSES;
   `verifyOneBigFeatureArtifacts` PASSES. Round-trips the full `--verify --through specs --framework
   one-big-feature` path the gate uses.
2. **FAIL — larry-forged identity:** same artifact, but the "return message" is signed `from:larry`
   (or the `from` field is edited to `opencode` without re-signing under the bus key). Emit throws
   `PROVENANCE_MISMATCH` (wrong from) or `TRANSCRIPT_TAMPERED` (sig mismatch). Anti-drafting holds.
3. **FAIL — hand-authored / hash drift:** valid opencode attestation for sha S, but the on-disk
   artifact is edited after attestation (sha ≠ S). Emit/verify throws `PROVENANCE_MISMATCH`.
4. **FAIL — dispatch slug mismatch:** return message attests slug X but `reply_to` points at a
   dispatch for slug Y. Fails dispatch-binding (`PROVENANCE_MISMATCH`).
5. **FAIL — no dispatch:** `reply_to` id not found in the bus store. `TRANSCRIPT_MISSING` /
   `PROVENANCE_MISMATCH`.
6. **bypass-audit — unbacked worker dispatch:** an opencode `GATE: build` dispatch with no ledger
   chain still produces a `dispatch-no-chain` finding. A worker-mode row with a tampered return
   message produces `hole3-deep-authorship` / `TRANSCRIPT_TAMPERED`.
7. **Regression — transcript mode untouched:** existing `ledger.test.ts` suite passes unchanged
   (absent `provenance_mode` ⇒ transcript path, identical behavior and signatures).

## Acceptance criteria

- A real/fixture **opencode-authored** plan + specs artifact is provenance-signed and PASSES
  `pipeline-stage-emit --verify --through specs ... --framework one-big-feature` (test 1).
- A **tampered / larry-authored** artifact for the same slug still FAILS provenance
  (`NO_PROVENANCE` / `PROVENANCE_MISMATCH` / `TRANSCRIPT_TAMPERED`) — tests 2–5.
- `bypass-audit` still flags an opencode build dispatch with no valid chain (test 6).
- Both pass and fail directions have tests. No `any`, no `console.log` in `src/`, strict TS compiles
  clean (`npm run build`), `npm test` green.
- `gate-codexer-planning.sh` requires no edit and now clears a worker-authored slug end-to-end.

## Out of scope (v1)

- Actually re-planning any real feature with K3 (future run once this lands).
- Multi-worker generalization beyond opencode (the allowed-worker set is a single-entry constant;
  widening it is a follow-up).
- 429/rate-limit fallback (already handled by `routing-policy` `on429:opus`).
- Changing `routing-policy.js` resolution or the K3 dispatch mechanics (research fixed this as
  config/dispatch-pattern, not new resolution code).
- Any change to the bus signing scheme itself.

## Constraints (binding on the implementer)

- Strict TypeScript; **no `any`** (use discriminated unions / `unknown` + narrowing for parsed JSON).
- **No `console.log`** in `src/` (CLI user-facing output stays via the existing `printAndExit`).
- **Fail-closed, loud:** every provenance failure is a typed failure/thrown error with a code; never
  warn-and-continue, never silently fall back from worker mode to transcript mode.
- **No new path** that lets any actor emit an authored-stage row without a verifiable binding.
- Backward compatible: absent `provenance_mode` ⇒ existing transcript behavior, byte-identical row
  signatures for existing rows.
