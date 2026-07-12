import { createHash, createHmac, timingSafeEqual } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { withFileLockSync } from '../utils/lock.js';

export const STAGES = [
  'research',
  'synthesize',
  'plan',
  'specs',
  'implement',
  'review',
  'true-verify',
  'exempt',
] as const;

export type Stage = (typeof STAGES)[number];

export interface LedgerRow {
  slug: string;
  stage: Stage;
  ts: number;
  artifact_sha256: string;
  prev_sha256: string;
  runner?: string;
  session_id?: string;
  transcript_path?: string;
  transcript_sha256?: string;
  reason?: string;
  evidence_path?: string;
  sig: string;
}

export interface LedgerVerifySuccess {
  ok: true;
  terminal: LedgerRow;
  rows: LedgerRow[];
}

export type VerifyFailure =
  | 'NO_ROWS'
  | 'BAD_SIG'
  | 'CHAIN_BREAK'
  | 'OUT_OF_ORDER'
  | 'STALE'
  | 'SCOPE_SHA_MISMATCH'
  | 'SECRET_UNREADABLE'
  | 'NO_PROVENANCE'
  | 'TRANSCRIPT_MISSING'
  | 'TRANSCRIPT_TAMPERED';

export interface LedgerVerifyFailure {
  ok: false;
  code: VerifyFailure;
  detail: string;
}

export type LedgerVerifyResult = LedgerVerifySuccess | LedgerVerifyFailure;

export type ProvenanceFailureCode =
  | 'NO_PROVENANCE'
  | 'TRANSCRIPT_MISSING'
  | 'TRANSCRIPT_TAMPERED'
  | 'PROVENANCE_MISMATCH';

export interface ProvenanceFailure {
  ok: false;
  code: ProvenanceFailureCode;
  detail: string;
}

export interface ProvenanceSuccess {
  ok: true;
  transcript_sha256: string;
  transcript_realpath: string;
}

export type ProvenanceResult = ProvenanceSuccess | ProvenanceFailure;

export interface ArtifactDescription {
  path: string;
  kind: 'file' | 'directory';
  sha256: string;
  files: ArtifactFile[];
}

export interface ArtifactFile {
  absPath: string;
  relPath: string;
  content: string;
  sha256: string;
}

export interface TranscriptOp {
  kind: 'Write' | 'Edit';
  filePath: string;
  line: number;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
}

const GENESIS = 'GENESIS';
const AUTHORED_STAGES = new Set<Stage>(['synthesize', 'plan', 'specs', 'review']);
const SHA_HEX_RE = /^[a-f0-9]{64}$/;
const SLUG_RE = /^[a-z0-9-]+$/;

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

function isAuthoredStage(stage: Stage): boolean {
  return AUTHORED_STAGES.has(stage);
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmacSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function hmacVerify(secret: string, payload: string, sig: string): boolean {
  try {
    const expected = hmacSign(secret, payload);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

function normalizePathPart(pathPart: string): string {
  return pathPart.replace(/\\/g, '/');
}

function ensureSha(value: string, field: string): void {
  if (!SHA_HEX_RE.test(value)) {
    throw new Error(`Invalid ${field}: expected 64 lowercase hex chars`);
  }
}

function ensureSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug '${slug}'. Expected lowercase kebab-case.`);
  }
}

function readSecret(secretPath: string): string | null {
  try {
    const secret = readFileSync(secretPath, 'utf-8').trim();
    if (!/^[a-f0-9]{32,}$/i.test(secret)) return null;
    return secret.toLowerCase();
  } catch {
    return null;
  }
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (entry.isFile()) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

export function describeArtifact(artifactPath: string): ArtifactDescription {
  const absPath = resolve(artifactPath);
  const stat = statSync(absPath);
  if (stat.isFile()) {
    const content = readFileSync(absPath, 'utf-8');
    return {
      path: absPath,
      kind: 'file',
      sha256: sha256Hex(content),
      files: [{
        absPath,
        relPath: normalizePathPart(relative(dirname(absPath), absPath) || absPath.split(/[\\/]/).pop() || absPath),
        content,
        sha256: sha256Hex(content),
      }],
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`Artifact path is neither file nor directory: ${absPath}`);
  }

  const files = listFilesRecursive(absPath).map((filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    return {
      absPath: filePath,
      relPath: normalizePathPart(relative(absPath, filePath)),
      content,
      sha256: sha256Hex(content),
    };
  });
  const digestInput = files
    .map((file) => `${file.sha256}  ${file.relPath}`)
    .join('\n');

  return {
    path: absPath,
    kind: 'directory',
    sha256: sha256Hex(digestInput),
    files,
  };
}

function canonicalPayload(row: Omit<LedgerRow, 'sig'>): string {
  const parts = [
    row.slug,
    row.stage,
    String(row.ts),
    row.artifact_sha256,
    row.prev_sha256,
  ];

  if (row.runner) parts.push(row.runner);
  if (row.session_id) parts.push(row.session_id);
  if (row.transcript_path) parts.push(row.transcript_path);
  if (row.transcript_sha256) parts.push(row.transcript_sha256);
  if (row.reason) parts.push(row.reason);
  if (row.evidence_path) parts.push(row.evidence_path);

  return parts.join('|');
}

function parseLedgerLine(line: string): LedgerRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Partial<LedgerRow>;
    if (!value || typeof value !== 'object') return null;
    if (typeof value.slug !== 'string' || !isStage(String(value.stage))) return null;
    if (typeof value.ts !== 'number') return null;
    if (typeof value.artifact_sha256 !== 'string' || typeof value.prev_sha256 !== 'string' || typeof value.sig !== 'string') {
      return null;
    }
    return {
      slug: value.slug,
      stage: String(value.stage) as Stage,
      ts: value.ts,
      artifact_sha256: value.artifact_sha256,
      prev_sha256: value.prev_sha256,
      runner: value.runner,
      session_id: value.session_id,
      transcript_path: value.transcript_path,
      transcript_sha256: value.transcript_sha256,
      reason: value.reason,
      evidence_path: value.evidence_path,
      sig: value.sig,
    };
  } catch {
    return null;
  }
}

export function readLedgerRows(ledgerPath: string): LedgerRow[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, 'utf-8');
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .map(parseLedgerLine)
    .filter((row): row is LedgerRow => row !== null);
}

function stageRank(stage: Stage): number {
  switch (stage) {
    case 'research': return 0;
    case 'synthesize': return 1;
    case 'plan': return 2;
    case 'specs': return 3;
    case 'implement': return 4;
    case 'review': return 5;
    case 'true-verify': return 6;
    case 'exempt': return 7;
  }
}

function allowedPreviousStages(stage: Stage): Stage[] {
  switch (stage) {
    case 'research': return [];
    case 'synthesize': return ['research'];
    case 'plan': return ['research', 'synthesize'];
    case 'specs': return ['plan'];
    case 'implement': return ['specs'];
    case 'review': return ['specs', 'implement'];
    case 'true-verify': return ['review'];
    case 'exempt': return [];
  }
}

function latestPreviousRow(rows: LedgerRow[], slug: string, stage: Stage, secret: string): LedgerRow | null {
  const allowed = new Set(allowedPreviousStages(stage));
  if (allowed.size === 0) return null;
  return [...rows]
    .filter((row) => row.slug === slug && allowed.has(row.stage) && verifyRowSignature(row, secret))
    .sort((a, b) => b.ts - a.ts)[0] ?? null;
}

function verifyRowSignature(row: LedgerRow, secret: string): boolean {
  return hmacVerify(secret, canonicalPayload({
    slug: row.slug,
    stage: row.stage,
    ts: row.ts,
    artifact_sha256: row.artifact_sha256,
    prev_sha256: row.prev_sha256,
    runner: row.runner,
    session_id: row.session_id,
    transcript_path: row.transcript_path,
    transcript_sha256: row.transcript_sha256,
    reason: row.reason,
    evidence_path: row.evidence_path,
  }), row.sig);
}

function ensureInsideRoot(pathToCheck: string, root: string): string | null {
  try {
    const realPath = realpathSync(pathToCheck);
    const realRoot = realpathSync(root);
    const rel = relative(realRoot, realPath);
    if (rel.startsWith('..') || rel === '' && realPath !== realRoot) {
      return null;
    }
    return realPath;
  } catch {
    return null;
  }
}

export function defaultTranscriptRoot(): string {
  return resolve(process.env.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE || join(homedir(), '.claude', 'projects'));
}

export function defaultPipelineProjectRoot(explicitRoot?: string): string {
  return resolve(
    explicitRoot ||
    process.env.CTX_PROJECT_ROOT ||
    process.env.CTX_FRAMEWORK_ROOT ||
    process.cwd(),
  );
}

function resolveLedgerPath(ledgerPath?: string): string {
  return ledgerPath ? resolve(ledgerPath) : defaultLedgerPath();
}

function resolveSecretPath(secretPath?: string): string {
  return secretPath ? resolve(secretPath) : defaultSecretPath();
}

export function defaultLedgerPath(projectRoot?: string): string {
  return join(defaultPipelineProjectRoot(projectRoot), 'state', 'pipeline-ledger.jsonl');
}

export function defaultSecretPath(secretPath?: string): string {
  return resolve(secretPath || process.env.PIPELINE_SECRET_PATH || join(homedir(), '.pipeline-secret'));
}

function parseTranscriptOps(transcriptPath: string): TranscriptOp[] {
  const raw = readFileSync(transcriptPath, 'utf-8');
  const ops: TranscriptOp[] = [];

  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: any;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content = value?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      if (block.name !== 'Write' && block.name !== 'Edit') continue;
      if (typeof block.input?.file_path !== 'string') continue;
      ops.push({
        kind: block.name,
        filePath: resolve(block.input.file_path),
        line: index + 1,
        content: typeof block.input.content === 'string' ? block.input.content : undefined,
        oldString: typeof block.input.old_string === 'string' ? block.input.old_string : undefined,
        newString: typeof block.input.new_string === 'string' ? block.input.new_string : undefined,
        replaceAll: Boolean(block.input.replace_all),
      });
    }
  }

  return ops;
}

function applyEdit(content: string, op: TranscriptOp): string | null {
  const oldString = op.oldString ?? '';
  const newString = op.newString ?? '';
  if (oldString.length === 0) return null;
  if (op.replaceAll) {
    if (!content.includes(oldString)) return null;
    return content.split(oldString).join(newString);
  }
  const index = content.indexOf(oldString);
  if (index === -1) return null;
  return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
}

function reconstructFile(file: ArtifactFile, ops: TranscriptOp[]): ProvenanceFailure | null {
  let current: string | undefined;
  let touched = false;

  for (const op of ops) {
    if (resolve(op.filePath) !== file.absPath) continue;
    touched = true;
    if (op.kind === 'Write') {
      current = op.content ?? '';
      continue;
    }
    if (current === undefined) {
      return {
        ok: false,
        code: 'PROVENANCE_MISMATCH',
        detail: `Edit before Write for ${file.relPath} at transcript line ${op.line}`,
      };
    }
    const next = applyEdit(current, op);
    if (next === null) {
      return {
        ok: false,
        code: 'PROVENANCE_MISMATCH',
        detail: `Edit could not be replayed for ${file.relPath} at transcript line ${op.line}`,
      };
    }
    current = next;
  }

  if (!touched || current === undefined) {
    return {
      ok: false,
      code: 'PROVENANCE_MISMATCH',
      detail: `Transcript did not author ${file.relPath}`,
    };
  }

  if (current !== file.content) {
    return {
      ok: false,
      code: 'PROVENANCE_MISMATCH',
      detail: `Transcript reconstruction mismatch for ${file.relPath}`,
    };
  }

  return null;
}

export function verifyTranscriptAuthorship(opts: {
  artifactPath: string;
  transcriptPath: string;
  transcriptRoot?: string;
  expectedSessionId?: string;
}): ProvenanceResult {
  const transcriptRoot = opts.transcriptRoot || defaultTranscriptRoot();
  const transcriptPath = resolve(opts.transcriptPath);
  const realTranscript = ensureInsideRoot(transcriptPath, transcriptRoot);
  if (!realTranscript || !existsSync(realTranscript)) {
    return {
      ok: false,
      code: 'TRANSCRIPT_MISSING',
      detail: `Transcript missing or outside projects root: ${transcriptPath}`,
    };
  }

  const raw = readFileSync(realTranscript, 'utf-8');
  if (!raw.trim()) {
    return {
      ok: false,
      code: 'PROVENANCE_MISMATCH',
      detail: `Transcript is empty: ${realTranscript}`,
    };
  }

  if (opts.expectedSessionId) {
    const firstLine = raw.split('\n').find((line) => line.trim());
    if (firstLine) {
      try {
        const first = JSON.parse(firstLine) as { sessionId?: string };
        if (first.sessionId && first.sessionId !== opts.expectedSessionId) {
          return {
            ok: false,
            code: 'PROVENANCE_MISMATCH',
            detail: `Transcript sessionId ${first.sessionId} does not match expected ${opts.expectedSessionId}`,
          };
        }
      } catch {
        // Ignore malformed first line here; the replay below will fail if needed.
      }
    }
  }

  const artifact = describeArtifact(opts.artifactPath);
  const ops = parseTranscriptOps(realTranscript);
  for (const file of artifact.files) {
    const failure = reconstructFile(file, ops);
    if (failure) return failure;
  }

  return {
    ok: true,
    transcript_sha256: sha256Hex(raw),
    transcript_realpath: realTranscript,
  };
}

export function emitLedgerRow(opts: {
  slug: string;
  stage: Stage;
  artifactPath: string;
  runner?: string;
  sessionId?: string;
  transcriptPath?: string;
  evidencePath?: string;
  reason?: string;
  ledgerPath?: string;
  secretPath?: string;
  nowSeconds?: number;
  transcriptRoot?: string;
}): LedgerRow {
  ensureSlug(opts.slug);
  const ledgerPath = resolveLedgerPath(opts.ledgerPath);
  const secretPath = resolveSecretPath(opts.secretPath);
  const secret = readSecret(secretPath);
  if (!secret) {
    throw new Error(`SECRET_UNREADABLE: signing secret unreadable at ${secretPath}`);
  }

  const artifact = describeArtifact(opts.artifactPath);
  if (opts.stage === 'true-verify') {
    if (!opts.evidencePath || !existsSync(opts.evidencePath) || statSync(opts.evidencePath).size === 0) {
      throw new Error('Artifact/evidence missing or empty for true-verify');
    }
  }
  if (opts.stage === 'exempt' && !opts.reason) {
    throw new Error('Exempt rows require --reason');
  }

  let transcriptSha: string | undefined;
  let transcriptRealpath: string | undefined;
  if (isAuthoredStage(opts.stage)) {
    if (!opts.runner || !opts.sessionId || !opts.transcriptPath) {
      throw new Error(`Authored stage '${opts.stage}' requires --runner, --session, and --transcript`);
    }
    const provenance = verifyTranscriptAuthorship({
      artifactPath: opts.artifactPath,
      transcriptPath: opts.transcriptPath,
      transcriptRoot: opts.transcriptRoot,
      expectedSessionId: opts.sessionId,
    });
    if (!provenance.ok) {
      throw new Error(`${provenance.code}: ${provenance.detail}`);
    }
    transcriptSha = provenance.transcript_sha256;
    transcriptRealpath = provenance.transcript_realpath;
  }

  mkdirSync(dirname(ledgerPath), { recursive: true });
  const existingRows = readLedgerRows(ledgerPath);
  const prevRow = latestPreviousRow(existingRows, opts.slug, opts.stage, secret);
  const prevSha = opts.stage === 'research' || opts.stage === 'exempt'
    ? GENESIS
    : prevRow?.artifact_sha256;

  if (opts.stage !== 'research' && opts.stage !== 'exempt' && !prevSha) {
    throw new Error(`CHAIN_BREAK: missing prior-stage row for ${opts.slug}:${opts.stage}`);
  }

  const unsigned: Omit<LedgerRow, 'sig'> = {
    slug: opts.slug,
    stage: opts.stage,
    ts: opts.nowSeconds ?? Math.floor(Date.now() / 1000),
    artifact_sha256: artifact.sha256,
    prev_sha256: prevSha || GENESIS,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(transcriptRealpath ? { transcript_path: transcriptRealpath } : {}),
    ...(transcriptSha ? { transcript_sha256: transcriptSha } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.evidencePath ? { evidence_path: resolve(opts.evidencePath) } : {}),
  };
  const row: LedgerRow = {
    ...unsigned,
    sig: hmacSign(secret, canonicalPayload(unsigned)),
  };

  const lockDir = join(dirname(ledgerPath), '.locks', 'pipeline-ledger');
  mkdirSync(lockDir, { recursive: true });
  withFileLockSync(lockDir, () => {
    appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, 'utf-8');
  });

  return row;
}

function buildChain(rows: LedgerRow[], terminal: LedgerRow, secret: string): LedgerVerifyResult {
  const byArtifact = new Map(rows.map((row) => [row.artifact_sha256, row]));
  const chain: LedgerRow[] = [];
  let cursor: LedgerRow | undefined = terminal;
  let lastRank = Number.POSITIVE_INFINITY;
  let lastTs = Number.POSITIVE_INFINITY;

  while (cursor) {
    if (!verifyRowSignature(cursor, secret)) {
      return {
        ok: false,
        code: 'BAD_SIG',
        detail: `Invalid signature on ${cursor.slug}:${cursor.stage}`,
      };
    }
    if (cursor.ts >= lastTs) {
      return {
        ok: false,
        code: 'OUT_OF_ORDER',
        detail: `Non-increasing timestamps in ${cursor.slug} chain`,
      };
    }
    if (stageRank(cursor.stage) >= lastRank) {
      return {
        ok: false,
        code: 'OUT_OF_ORDER',
        detail: `Stage order regression at ${cursor.slug}:${cursor.stage}`,
      };
    }
    chain.unshift(cursor);
    lastRank = stageRank(cursor.stage);
    lastTs = cursor.ts;

    if (cursor.prev_sha256 === GENESIS) break;
    const prev = byArtifact.get(cursor.prev_sha256);
    if (!prev) {
      return {
        ok: false,
        code: 'CHAIN_BREAK',
        detail: `Missing previous row ${cursor.prev_sha256} for ${cursor.slug}:${cursor.stage}`,
      };
    }
    if (!allowedPreviousStages(cursor.stage).includes(prev.stage)) {
      return {
        ok: false,
        code: 'OUT_OF_ORDER',
        detail: `Invalid ${prev.stage} -> ${cursor.stage} transition for ${cursor.slug}`,
      };
    }
    cursor = prev;
  }

  if (chain.length === 0) {
    return { ok: false, code: 'NO_ROWS', detail: `No rows for ${terminal.slug}` };
  }
  if (terminal.stage !== 'exempt' && chain[0]?.stage !== 'research') {
    return {
      ok: false,
      code: 'CHAIN_BREAK',
      detail: `Chain for ${terminal.slug} does not start at research`,
    };
  }
  if (terminal.stage === 'exempt' && chain[0]?.stage !== 'exempt') {
    return {
      ok: false,
      code: 'CHAIN_BREAK',
      detail: `Exempt chain for ${terminal.slug} is malformed`,
    };
  }

  return { ok: true, terminal, rows: chain };
}

export function verifyChainDetailed(opts: {
  ledgerPath?: string;
  secretPath?: string;
  slug: string;
  throughStage: Stage;
  maxAgeSeconds: number;
  scopeSha?: string;
  transcriptRoot?: string;
  nowSeconds?: number;
}): LedgerVerifyResult {
  ensureSlug(opts.slug);
  if (opts.scopeSha) ensureSha(opts.scopeSha, 'scopeSha');

  const ledgerPath = resolveLedgerPath(opts.ledgerPath);
  const secretPath = resolveSecretPath(opts.secretPath);
  const secret = readSecret(secretPath);
  if (!secret) {
    return {
      ok: false,
      code: 'SECRET_UNREADABLE',
      detail: `Signing secret unreadable at ${secretPath}`,
    };
  }

  const rows = readLedgerRows(ledgerPath)
    .filter((row) => row.slug === opts.slug)
    .sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) {
    return {
      ok: false,
      code: 'NO_ROWS',
      detail: `No ledger rows for slug '${opts.slug}'`,
    };
  }

  const candidates = rows.filter((row) => row.stage === opts.throughStage).sort((a, b) => b.ts - a.ts);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'NO_ROWS',
      detail: `No terminal row for ${opts.slug}:${opts.throughStage}`,
    };
  }

  let bestFailure: LedgerVerifyFailure | null = null;
  for (const candidate of candidates) {
    const chain = buildChain(rows, candidate, secret);
    if (!chain.ok) {
      bestFailure = chain;
      continue;
    }

    for (const row of chain.rows) {
      if (!isAuthoredStage(row.stage)) continue;
      if (!row.runner || !row.session_id || !row.transcript_path || !row.transcript_sha256) {
        return {
          ok: false,
          code: 'NO_PROVENANCE',
          detail: `Missing provenance fields on ${row.slug}:${row.stage}`,
        };
      }
      if (!existsSync(row.transcript_path)) {
        return {
          ok: false,
          code: 'TRANSCRIPT_MISSING',
          detail: `Transcript missing for ${row.slug}:${row.stage}: ${row.transcript_path}`,
        };
      }
      const realTranscript = ensureInsideRoot(row.transcript_path, opts.transcriptRoot || defaultTranscriptRoot());
      if (!realTranscript) {
        return {
          ok: false,
          code: 'TRANSCRIPT_MISSING',
          detail: `Transcript outside allowed root for ${row.slug}:${row.stage}: ${row.transcript_path}`,
        };
      }
      const transcriptSha = sha256Hex(readFileSync(realTranscript, 'utf-8'));
      if (transcriptSha !== row.transcript_sha256) {
        return {
          ok: false,
          code: 'TRANSCRIPT_TAMPERED',
          detail: `Transcript hash mismatch for ${row.slug}:${row.stage}`,
        };
      }
    }

    const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (nowSeconds - chain.terminal.ts > opts.maxAgeSeconds) {
      return {
        ok: false,
        code: 'STALE',
        detail: `${opts.slug}:${opts.throughStage} is older than ${opts.maxAgeSeconds}s`,
      };
    }
    if (opts.scopeSha && chain.terminal.artifact_sha256 !== opts.scopeSha) {
      return {
        ok: false,
        code: 'SCOPE_SHA_MISMATCH',
        detail: `Scope sha ${opts.scopeSha} does not match signed artifact ${chain.terminal.artifact_sha256}`,
      };
    }

    return chain;
  }

  return bestFailure ?? {
    ok: false,
    code: 'CHAIN_BREAK',
    detail: `Unable to build valid chain for ${opts.slug}:${opts.throughStage}`,
  };
}

export function verifyChain(opts: {
  ledgerPath?: string;
  secretPath?: string;
  slug: string;
  throughStage: Stage;
  maxAgeSeconds: number;
  scopeSha?: string;
  transcriptRoot?: string;
  nowSeconds?: number;
}): { ok: true; terminal: LedgerRow } | LedgerVerifyFailure {
  const result = verifyChainDetailed(opts);
  if (!result.ok) return result;
  return { ok: true, terminal: result.terminal };
}

export function verifyOneBigFeatureArtifacts(opts: {
  projectRoot: string;
  slug: string;
  rows: LedgerRow[];
}): { ok: true; researchPath: string; planPath: string; specsPath: string } | {
  ok: false;
  code: 'ORDERING' | 'SCOPE_SHA_MISMATCH';
  detail: string;
} {
  const obfDir = join(resolve(opts.projectRoot), '.agent', 'one-big-feature', opts.slug);
  const researchPath = join(obfDir, '01-research.md');
  const planPath = join(obfDir, '02-master-plan.md');
  const specsPath = join(obfDir, '03-specs');

  if (!existsSync(researchPath) || !existsSync(planPath) || !existsSync(specsPath)) {
    return {
      ok: false,
      code: 'ORDERING',
      detail: `Missing required one-big-feature artifacts for ${opts.slug}`,
    };
  }

  const researchMtime = statSync(researchPath).mtimeMs;
  const planMtime = statSync(planPath).mtimeMs;
  if (planMtime < researchMtime) {
    return {
      ok: false,
      code: 'ORDERING',
      detail: `Plan predates research for ${opts.slug}`,
    };
  }

  const researchRow = opts.rows.find((row) => row.stage === 'research');
  const planRow = opts.rows.find((row) => row.stage === 'plan');
  const specsRow = opts.rows.find((row) => row.stage === 'specs');
  if (!researchRow || !planRow || !specsRow) {
    return {
      ok: false,
      code: 'ORDERING',
      detail: `Missing signed research/plan/specs rows for ${opts.slug}`,
    };
  }

  if (describeArtifact(researchPath).sha256 !== researchRow.artifact_sha256) {
    return {
      ok: false,
      code: 'ORDERING',
      detail: `Research artifact drifted from signed row for ${opts.slug}`,
    };
  }
  if (describeArtifact(planPath).sha256 !== planRow.artifact_sha256) {
    return {
      ok: false,
      code: 'ORDERING',
      detail: `Plan artifact drifted from signed row for ${opts.slug}`,
    };
  }
  if (describeArtifact(specsPath).sha256 !== specsRow.artifact_sha256) {
    return {
      ok: false,
      code: 'SCOPE_SHA_MISMATCH',
      detail: `Specs artifact drifted from signed row for ${opts.slug}`,
    };
  }

  return { ok: true, researchPath, planPath, specsPath };
}
