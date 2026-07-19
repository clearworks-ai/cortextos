# Spec 01 — `src/pipeline/ledger.ts`: worker-dispatch provenance mode

Target file: `/Users/joshweiss/code/cortextos/src/pipeline/ledger.ts`

All changes are additive and backward-compatible. A row with no `provenance_mode` MUST behave
exactly as today (transcript mode), including byte-identical HMAC signatures. Strict TS, no `any`,
no `console.log`, fail-closed.

---

## 1. Type additions

### 1.1 `LedgerRow` — new optional field

Add after `transcript_sha256?: string;`:

```ts
  provenance_mode?: 'transcript' | 'worker-dispatch';
```

Add a small alias near the other types:

```ts
export type ProvenanceMode = 'transcript' | 'worker-dispatch';
```

### 1.2 New parsed-bus-message shape (module-local, not exported)

```ts
interface ParsedBusMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  sig?: string;
  reply_to?: string | null;
}
```

No `any`: parse with `JSON.parse(...) as unknown` then narrow field-by-field with `typeof` guards,
mirroring `parseLedgerLine`.

---

## 2. Constants

Add near `AUTHORED_STAGES`:

```ts
const WORKER_AUTHORS = new Set<string>(['opencode', 'opencoder']);
const PROVENANCE_LINE_RE =
  /PROVENANCE:\s*stage=(plan|specs)\s+slug=([a-z0-9-]+)\s+artifact-sha256=([a-f0-9]{64})\b/;
const BUS_STORE_BUCKETS = ['inbox', 'inflight', 'processed'] as const;
```

---

## 3. `canonicalPayload` — cover the new field

In `canonicalPayload(row)`, append `provenance_mode` **after** `evidence_path` (last, so existing
rows without it produce the identical payload string):

```ts
  if (row.evidence_path) parts.push(row.evidence_path);
  if (row.provenance_mode) parts.push(row.provenance_mode);
```

Update the `Omit<LedgerRow,'sig'>` type sites that build the payload — `verifyRowSignature` already
passes the whole row shape; add `provenance_mode: row.provenance_mode` to the object it constructs so
the field is included when present.

## 4. `parseLedgerLine` — read the field

In the returned object add:

```ts
      provenance_mode:
        value.provenance_mode === 'worker-dispatch' || value.provenance_mode === 'transcript'
          ? value.provenance_mode
          : undefined,
```

(An unknown/garbage value parses to `undefined` ⇒ treated as transcript mode; this is safe because
the row sig was computed with whatever the field actually was — a forged flip is caught by
`verifyRowSignature` since the flipped value changes the canonical payload.)

---

## 5. Bus-signing helpers

### 5.1 `busSignPayload` — MUST byte-match `src/bus/message.ts`

`src/bus/message.ts` signs `signPayload(msgId, from, to, text)`. Reproduce the **exact** payload
join used there. Read `src/bus/message.ts` line ~45 (`signPayload`) and replicate it verbatim; do NOT
guess the separator. Define:

```ts
function busSignPayload(id: string, from: string, to: string, text: string): string {
  // MUST match src/bus/message.ts signPayload exactly.
  return `${id}|${from}|${to}|${text}`;
}
```

(Implementer: confirm the separator/order against `src/bus/message.ts` at implementation time and
match it byte-for-byte. If bus uses a different join, use that. A mismatch silently breaks all
worker-mode verification, so this is the one line to verify against source, not assume.)

### 5.2 `loadBusSigningKey`

```ts
function loadBusSigningKey(ctxRoot: string): string | null {
  try {
    const keyPath = join(resolve(ctxRoot), 'config', 'bus-signing-key');
    const key = readFileSync(keyPath, 'utf-8').trim();
    return key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}
```

### 5.3 `verifyBusMessageSig`

```ts
function verifyBusMessageSig(msg: ParsedBusMessage, busKey: string): boolean {
  if (!msg.sig) return false;
  try {
    const expected = hmacSign(busKey, busSignPayload(msg.id, msg.from, msg.to, msg.text));
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(msg.sig, 'hex'));
  } catch {
    return false;
  }
}
```

### 5.4 `parseBusMessageFile`

```ts
function parseBusMessageFile(path: string): ParsedBusMessage | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.from !== 'string' || typeof v.to !== 'string' || typeof v.text !== 'string') {
    return null;
  }
  return {
    id: v.id,
    from: v.from,
    to: v.to,
    text: v.text,
    sig: typeof v.sig === 'string' ? v.sig : undefined,
    reply_to: typeof v.reply_to === 'string' ? v.reply_to : null,
  };
}
```

---

## 6. Bus-store root allow-listing

Add next to `defaultTranscriptRoot`:

```ts
export function defaultBusStoreRoot(): string {
  return resolve(
    process.env.PIPELINE_BUS_STORE_ROOT_OVERRIDE || join(homedir(), '.cortextos', 'cortextos1'),
  );
}
```

Worker-mode `transcript_path` (which points at a bus message JSON file) MUST resolve inside this root
via the existing `ensureInsideRoot(path, busStoreRoot)` — same fail-closed containment used for
transcript mode.

---

## 7. Dispatch resolver

Locate the larry→opencode dispatch by id across bus buckets. `ctxRoot` = bus store root.

```ts
function findBusMessageById(busStoreRoot: string, id: string): { path: string; msg: ParsedBusMessage } | null {
  // Messages live at <root>/<bucket>/<agent>/<file>.json; the sender-recipient dir layout is
  // <bucket>/<recipient>. A larry->opencode dispatch is under <bucket>/opencode; scan those.
  for (const bucket of BUS_STORE_BUCKETS) {
    const dir = join(busStoreRoot, bucket, 'opencode');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      const msg = parseBusMessageFile(path);
      if (msg && msg.id === id) return { path, msg };
    }
  }
  return null;
}
```

```ts
function resolveDispatchForReply(opts: {
  busStoreRoot: string;
  busKey: string;
  replyToId: string;
  expectedSlug: string;
}): { ok: true } | ProvenanceFailure {
  const found = findBusMessageById(opts.busStoreRoot, opts.replyToId);
  if (!found) {
    return { ok: false, code: 'TRANSCRIPT_MISSING', detail: `Dispatch ${opts.replyToId} not found in bus store` };
  }
  const { msg } = found;
  if (msg.from !== 'larry') {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: `Dispatch ${opts.replyToId} not from larry (from=${msg.from})` };
  }
  if (!verifyBusMessageSig(msg, opts.busKey)) {
    return { ok: false, code: 'TRANSCRIPT_TAMPERED', detail: `Dispatch ${opts.replyToId} bus signature invalid` };
  }
  const slug = msg.text.match(/\bslug=([a-z0-9-]+)/)?.[1];
  const isBuild = /\bGATE:\s*build\b/i.test(msg.text);
  if (!isBuild || slug !== opts.expectedSlug) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: `Dispatch ${opts.replyToId} is not a GATE: build for slug ${opts.expectedSlug}` };
  }
  return { ok: true };
}
```

(Use the local slug regex rather than importing `parseBuildDirective` to avoid a `src/pipeline/build-
gate.ts` → `ledger.ts` → `build-gate.ts` import cycle. The check is intentionally minimal: real build,
matching slug. Full directive validation already happened at dispatch time in the gate.)

---

## 8. `verifyWorkerDispatchAuthorship` — the worker analogue of `verifyTranscriptAuthorship`

Same return type (`ProvenanceResult`). This is the whole trust chain.

```ts
export function verifyWorkerDispatchAuthorship(opts: {
  artifactPath: string;
  messagePath: string;        // the opencode->larry return message file (ledger transcript_path)
  slug: string;
  busStoreRoot?: string;
  busKey?: string | null;
}): ProvenanceResult {
  const busStoreRoot = opts.busStoreRoot || defaultBusStoreRoot();
  const realMsgPath = ensureInsideRoot(resolve(opts.messagePath), busStoreRoot);
  if (!realMsgPath || !existsSync(realMsgPath)) {
    return { ok: false, code: 'TRANSCRIPT_MISSING', detail: `Return message missing or outside bus store: ${opts.messagePath}` };
  }
  const busKey = opts.busKey ?? null;
  if (!busKey) {
    return { ok: false, code: 'NO_PROVENANCE', detail: 'Bus signing key unreadable; cannot verify worker attestation' };
  }
  const msg = parseBusMessageFile(realMsgPath);
  if (!msg) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: `Return message is not a parseable bus message: ${realMsgPath}` };
  }
  // (2) author identity = a known worker, NOT larry
  if (!WORKER_AUTHORS.has(msg.from)) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: `Return message from '${msg.from}' is not a pipeline worker` };
  }
  // (1) return message bus-signed
  if (!verifyBusMessageSig(msg, busKey)) {
    return { ok: false, code: 'TRANSCRIPT_TAMPERED', detail: `Return message bus signature invalid: ${realMsgPath}` };
  }
  // (4) artifact-hash attestation present + parseable, slug matches
  const m = msg.text.match(PROVENANCE_LINE_RE);
  if (!m) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: 'Return message lacks a PROVENANCE stage/slug/artifact-sha256 line' };
  }
  const attestedSlug = m[2];
  const attestedSha = m[3];
  if (attestedSlug !== opts.slug) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: `Attested slug ${attestedSlug} != ${opts.slug}` };
  }
  const artifact = describeArtifact(opts.artifactPath);
  if (artifact.sha256 !== attestedSha) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: `Attested artifact sha ${attestedSha} != on-disk ${artifact.sha256}` };
  }
  // (3) bound to a real signed larry->opencode dispatch for the same slug
  if (!msg.reply_to) {
    return { ok: false, code: 'PROVENANCE_MISMATCH', detail: 'Return message has no reply_to dispatch binding' };
  }
  const dispatch = resolveDispatchForReply({ busStoreRoot, busKey, replyToId: msg.reply_to, expectedSlug: opts.slug });
  if (!dispatch.ok) return dispatch;

  return {
    ok: true,
    transcript_sha256: sha256Hex(readFileSync(realMsgPath, 'utf-8')),
    transcript_realpath: realMsgPath,
  };
}
```

---

## 9. `emitLedgerRow` — accept and route worker mode

Extend the opts:

```ts
  provenanceMode?: ProvenanceMode;
  workerName?: string;         // reserved; author identity is enforced from the message `from`
  busStoreRoot?: string;
  busKeyCtxRoot?: string;      // dir containing config/bus-signing-key
```

Replace the authored-stage block:

```ts
  if (isAuthoredStage(opts.stage)) {
    if (!opts.runner || !opts.sessionId || !opts.transcriptPath) {
      throw new Error(`Authored stage '${opts.stage}' requires --runner, --session, and --transcript`);
    }
    const mode: ProvenanceMode = opts.provenanceMode ?? 'transcript';
    let provenance: ProvenanceResult;
    if (mode === 'worker-dispatch') {
      const busKey = loadBusSigningKey(opts.busKeyCtxRoot || opts.busStoreRoot || defaultBusStoreRoot());
      provenance = verifyWorkerDispatchAuthorship({
        artifactPath: opts.artifactPath,
        messagePath: opts.transcriptPath,
        slug: opts.slug,
        busStoreRoot: opts.busStoreRoot,
        busKey,
      });
    } else {
      provenance = verifyTranscriptAuthorship({
        artifactPath: opts.artifactPath,
        transcriptPath: opts.transcriptPath,
        transcriptRoot: opts.transcriptRoot,
        expectedSessionId: opts.sessionId,
      });
    }
    if (!provenance.ok) {
      throw new Error(`${provenance.code}: ${provenance.detail}`);
    }
    transcriptSha = provenance.transcript_sha256;
    transcriptRealpath = provenance.transcript_realpath;
    provenanceMode = mode; // local var, persisted below
  }
```

Add `provenanceMode` to the `unsigned` object when `worker-dispatch` (omit when transcript, to keep
existing rows byte-identical):

```ts
    ...(provenanceMode === 'worker-dispatch' ? { provenance_mode: provenanceMode } : {}),
```

Note: `config/bus-signing-key` lookup: `loadBusSigningKey` expects a dir that CONTAINS `config/`.
`busKeyCtxRoot` defaults to `busStoreRoot` defaults to `defaultBusStoreRoot()` = `~/.cortextos/
cortextos1`, whose `config/bus-signing-key` is the live key. In tests, pass a temp ctxRoot with a
`config/bus-signing-key` file.

---

## 10. `verifyChainDetailed` — re-verify worker rows at verify time

In the per-row loop (`for (const row of chain.rows)`), after the existing field-presence +
`transcript_sha256` drift + `ensureInsideRoot` checks, branch by mode:

- For `row.provenance_mode === 'worker-dispatch'`:
  - The allowed root is `defaultBusStoreRoot()` (or `opts.busStoreRoot`), NOT the projects transcript
    root. Compute `realTranscript = ensureInsideRoot(row.transcript_path, busStoreRoot)`; on null ⇒
    `TRANSCRIPT_MISSING`.
  - `sha256(bytes) === row.transcript_sha256` check stays (tamper).
  - Additionally call `verifyWorkerDispatchAuthorship({ artifactPath: <resolved artifact>, messagePath:
    row.transcript_path, slug: row.slug, busStoreRoot, busKey: loadBusSigningKey(busStoreRoot) })` and
    map any failure to its code. This re-checks from-identity + dispatch binding + attested-hash-vs-disk
    so a post-emit swap to a different-but-valid-sha bus file is caught.
  - **Resolving the artifact at verify time:** `verifyChainDetailed` does not currently know the
    on-disk artifact path. For OBF the caller runs `verifyOneBigFeatureArtifacts` separately (which
    already re-hashes plan/specs on disk vs the signed row). To keep `verifyChainDetailed` artifact-
    agnostic, the worker re-check here verifies everything EXCEPT the artifact-hash-vs-disk step
    (that is covered by the existing `transcript_sha256` tamper check on the message plus
    `verifyOneBigFeatureArtifacts`' on-disk sha check). Concretely: call a lighter
    `verifyWorkerAttestationMessage({ messagePath, slug, busStoreRoot, busKey })` that does trust-
    chain steps (1)(2)(3) + PROVENANCE-line-parse + slug match, but skips (4) disk-hash (no artifact
    path available). Factor `verifyWorkerDispatchAuthorship` so the message-only checks live in a
    shared helper that both the emit-time (with disk hash) and verify-time (without) paths call.
- For transcript mode (absent or `'transcript'`): existing behavior unchanged, allowed root =
  `opts.transcriptRoot || defaultTranscriptRoot()`.

Add `busStoreRoot?: string;` to `verifyChainDetailed` opts and thread it (default
`defaultBusStoreRoot()`).

### Refactor note (implementer)

Split `verifyWorkerDispatchAuthorship` into:
- `verifyWorkerAttestationMessage(opts)` — steps (1) bus sig, (2) from-identity, (3) dispatch binding,
  PROVENANCE-line parse + slug match. Returns `{ok:true; attestedSha; transcript_sha256;
  transcript_realpath}` or `ProvenanceFailure`.
- `verifyWorkerDispatchAuthorship(opts)` — calls the above, then adds step (4): compares `attestedSha`
  to `describeArtifact(artifactPath).sha256`.

Emit-time uses `verifyWorkerDispatchAuthorship` (has artifact path). Verify-time in
`verifyChainDetailed` uses `verifyWorkerAttestationMessage` (no artifact path; disk drift covered by
`verifyOneBigFeatureArtifacts`).

---

## 11. Exports

Export `verifyWorkerDispatchAuthorship`, `verifyWorkerAttestationMessage`, `defaultBusStoreRoot`,
`type ProvenanceMode`. Keep everything else's exports intact.

## 12. Fail-closed invariants (assert in review)

- No branch returns `ok:true` for worker mode without: valid bus sig, `from ∈ WORKER_AUTHORS`,
  matching PROVENANCE slug, and a resolvable+signed+from-larry dispatch.
- Missing bus key ⇒ `NO_PROVENANCE` (never silent skip, never fall back to transcript mode).
- Unknown `provenance_mode` string on a row ⇒ treated as transcript mode AND the row sig re-check
  fails if the value was tampered (canonical payload includes it), so no bypass.
