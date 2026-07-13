import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import {
  defaultLedgerPath,
  defaultSecretPath,
  defaultTranscriptRoot,
  describeArtifact,
  readLedgerRows,
  verifyChainDetailed,
  verifyOneBigFeatureArtifacts,
  verifyTranscriptAuthorship,
  type LedgerRow,
} from './ledger.js';
import { parseBuildDirective, type BuildDirective } from './build-gate.js';

const AUTHORED_STAGES = new Set(['synthesize', 'plan', 'specs', 'review']);
const WORKERS = new Set(['codexer', 'opencode', 'opencoder']);
const MAIN_PUSH_RE = /(^|[;&|(`])\s*git\s+push\b.*\bmain\b/i;

export interface AuditWindow {
  start_ms: number;
  end_ms: number;
}

export interface AuditFinding {
  kind:
    | 'dispatch-no-chain'
    | 'dispatch-no-slug'
    | 'pr-no-chain'
    | 'pr-no-slug'
    | 'push-no-chain'
    | 'push-no-slug'
    | 'bus-store-bypass'
    | 'hole3-no-spawn'
    | 'hole3-no-artifact'
    | 'hole3-deep-authorship'
    | 'hole3-structure'
    | 'hole3-hand-authoring';
  slug?: string;
  code?: string;
  detail: string;
  evidence: string[];
}

export interface AuditAdvisory {
  kind: 'gate-mtime' | 'exempt-threshold';
  detail: string;
  evidence: string[];
}

export interface AuditReport {
  window: AuditWindow;
  dispatches_found: number;
  prs_found: number;
  chains_verified: number;
  provenance_rows_checked: number;
  bypasses: AuditFinding[];
  advisories: AuditAdvisory[];
  exempt_count_7d: number;
}

export interface RunAuditOptions {
  agentName?: string;
  ctxRoot: string;
  projectRoot: string;
  parentTranscriptRoot: string;
  ledgerPath?: string;
  secretPath?: string;
  transcriptRoot?: string;
  outputPath?: string;
  nowMs?: number;
  windowHours?: number;
}

interface TranscriptEventBase {
  tsMs: number;
  transcriptPath: string;
  line: number;
  sessionId?: string;
  toolUseId?: string;
}

interface DispatchEvent extends TranscriptEventBase {
  kind: 'dispatch';
  worker: string;
  command: string;
  directive?: BuildDirective;
}

interface PrEvent extends TranscriptEventBase {
  kind: 'pr';
  command: string;
}

interface PushEvent extends TranscriptEventBase {
  kind: 'push';
  command: string;
}

interface SpawnEvent extends TranscriptEventBase {
  kind: 'spawn';
  runner: string;
  subject: string;
  completedAtMs?: number;
}

interface PlanningWriteEvent extends TranscriptEventBase {
  kind: 'planning-write';
  filePath: string;
  slug?: string;
}

interface ToolResultEvent {
  tsMs: number;
  toolUseId: string;
  transcriptPath: string;
  line: number;
  contentText: string;
}

interface BusDispatchRecord {
  id: string;
  tsMs: number;
  worker: string;
  text: string;
  path: string;
  directive?: BuildDirective;
}

interface ParsedTimeline {
  dispatches: DispatchEvent[];
  prs: PrEvent[];
  pushes: PushEvent[];
  spawns: SpawnEvent[];
  planningWrites: PlanningWriteEvent[];
}

function usage(): string {
  return [
    'Usage:',
    '  bypass-audit --ctx-root <path> --project-root <path> --parent-transcript-root <path> [--agent <name>] [--ledger <path>] [--secret <path>] [--transcript-root <path>] [--window-hours <n>] [--output <path>]',
  ].join('\n');
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function listJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'subagents') continue;
        visit(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(abs);
      }
    }
  };
  visit(resolve(root));
  return out;
}

function flattenToolResultContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseTsMs(record: Record<string, unknown>): number | null {
  const raw = typeof record.timestamp === 'string'
    ? record.timestamp
    : typeof record.ts === 'string'
      ? record.ts
      : null;
  if (!raw) return null;
  const tsMs = Date.parse(raw);
  return Number.isFinite(tsMs) ? tsMs : null;
}

function extractSlug(value: string): string | undefined {
  return value.match(/\bslug=([a-z0-9-]+)\b/)?.[1]
    || value.match(/\/one-big-feature\/([a-z0-9-]+)\//)?.[1]
    || value.match(/\/m2c1\/([a-z0-9-]+)\//)?.[1];
}

function subjectMentionsSlug(subject: string, slug: string): boolean {
  const haystack = subject.toLowerCase();
  return haystack.includes(slug.toLowerCase())
    || haystack.includes(`/one-big-feature/${slug}/`)
    || haystack.includes(`/m2c1/${slug}/`);
}

function extractPlanningWriteSlug(filePath: string): string | undefined {
  const normalized = normalizePath(filePath);
  return normalized.match(/\/one-big-feature\/([a-z0-9-]+)\/(?:02-master-plan\.md|03-specs\/)/)?.[1]
    || normalized.match(/\/m2c1\/([a-z0-9-]+)\//)?.[1];
}

function scanParentTranscripts(root: string, window: AuditWindow): ParsedTimeline {
  const dispatches: DispatchEvent[] = [];
  const prs: PrEvent[] = [];
  const pushes: PushEvent[] = [];
  const spawns: SpawnEvent[] = [];
  const planningWrites: PlanningWriteEvent[] = [];
  const results = new Map<string, ToolResultEvent>();

  const files = listJsonlFiles(root);
  for (const transcriptPath of files) {
    const raw = readFileSync(transcriptPath, 'utf-8');
    if (!raw.trim()) continue;
    const lines = raw.split('\n');

    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tsMs = parseTsMs(record);
      if (tsMs === null || tsMs < window.start_ms || tsMs > window.end_ms) continue;
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;

      const message = record.message;
      const content = message && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : undefined;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const entry = block as Record<string, unknown>;
        const blockType = typeof entry.type === 'string' ? entry.type : '';

        if (blockType === 'tool_result' && typeof entry.tool_use_id === 'string') {
          results.set(entry.tool_use_id, {
            tsMs,
            toolUseId: entry.tool_use_id,
            transcriptPath,
            line: index + 1,
            contentText: flattenToolResultContent(entry.content),
          });
          continue;
        }

        if (blockType !== 'tool_use' || typeof entry.name !== 'string') continue;
        const toolUseId = typeof entry.id === 'string' ? entry.id : undefined;
        const input = entry.input && typeof entry.input === 'object'
          ? entry.input as Record<string, unknown>
          : {};

        if (entry.name === 'Bash' && typeof input.command === 'string') {
          const command = input.command;
          const sendMatch = command.match(/\bbus\s+send-message\s+(codexer|opencode|opencoder)\b/i);
          if (sendMatch) {
            let directive: BuildDirective | undefined;
            try {
              directive = parseBuildDirective(command) || undefined;
            } catch {
              directive = undefined;
            }
            dispatches.push({
              kind: 'dispatch',
              worker: sendMatch[1].toLowerCase(),
              command,
              directive,
              tsMs,
              transcriptPath,
              line: index + 1,
              sessionId,
              toolUseId,
            });
          }
          if (/\bgh\s+pr\s+create\b/i.test(command)) {
            prs.push({
              kind: 'pr',
              command,
              tsMs,
              transcriptPath,
              line: index + 1,
              sessionId,
              toolUseId,
            });
          }
          if (MAIN_PUSH_RE.test(command)) {
            pushes.push({
              kind: 'push',
              command,
              tsMs,
              transcriptPath,
              line: index + 1,
              sessionId,
              toolUseId,
            });
          }
          continue;
        }

        if ((entry.name === 'Agent' || entry.name === 'Task')
          && (typeof input.prompt === 'string' || typeof input.description === 'string')) {
          const subject = `${typeof input.description === 'string' ? input.description : ''}\n${typeof input.prompt === 'string' ? input.prompt : ''}`.trim();
          spawns.push({
            kind: 'spawn',
            runner: typeof input.subagent_type === 'string' ? input.subagent_type : entry.name,
            subject,
            completedAtMs: toolUseId ? results.get(toolUseId)?.tsMs : undefined,
            tsMs,
            transcriptPath,
            line: index + 1,
            sessionId,
            toolUseId,
          });
          continue;
        }

        if ((entry.name === 'Write' || entry.name === 'Edit') && typeof input.file_path === 'string') {
          const slug = extractPlanningWriteSlug(input.file_path);
          if (!slug) continue;
          planningWrites.push({
            kind: 'planning-write',
            filePath: resolve(input.file_path),
            slug,
            tsMs,
            transcriptPath,
            line: index + 1,
            sessionId,
            toolUseId,
          });
        }
      }
    }
  }

  for (const spawn of spawns) {
    if (!spawn.toolUseId) continue;
    spawn.completedAtMs = results.get(spawn.toolUseId)?.tsMs;
  }

  return { dispatches, prs, pushes, spawns, planningWrites };
}

function readBusDispatches(ctxRoot: string, window: AuditWindow): BusDispatchRecord[] {
  const seen = new Set<string>();
  const out: BusDispatchRecord[] = [];

  for (const bucket of ['inbox', 'inflight', 'processed']) {
    for (const worker of WORKERS) {
      const dir = join(resolve(ctxRoot), bucket, worker);
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
      for (const name of entries) {
        const path = join(dir, name);
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = typeof record.id === 'string' ? record.id : '';
        if (!id || seen.has(id)) continue;
        const text = typeof record.text === 'string' ? record.text : '';
        const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
        const tsMs = Date.parse(timestamp);
        if (!Number.isFinite(tsMs) || tsMs < window.start_ms || tsMs > window.end_ms) continue;
        if (!/\bGATE:\s*build\b/i.test(text)) continue;
        seen.add(id);
        let directive: BuildDirective | undefined;
        try {
          directive = parseBuildDirective(text) || undefined;
        } catch {
          directive = undefined;
        }
        out.push({
          id,
          tsMs,
          worker,
          text,
          path,
          directive,
        });
      }
    }
  }

  return out.sort((a, b) => a.tsMs - b.tsMs);
}

function findTranscriptMatch(busDispatch: BusDispatchRecord, dispatches: DispatchEvent[]): DispatchEvent | null {
  const targetSlug = busDispatch.directive?.slug;
  const targetRepo = busDispatch.directive?.repo;
  return dispatches.find((dispatch) => {
    if (dispatch.worker !== busDispatch.worker) return false;
    if (targetSlug && dispatch.directive?.slug !== targetSlug) return false;
    if (targetRepo && dispatch.directive?.repo !== targetRepo) return false;
    return Math.abs(dispatch.tsMs - busDispatch.tsMs) <= 5 * 60 * 1000;
  }) ?? null;
}

function readTranscriptFileLines(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function checkTranscriptStructure(row: LedgerRow): string | null {
  if (!row.transcript_path || !existsSync(row.transcript_path)) {
    return 'Transcript missing for structure check';
  }
  const lines = readTranscriptFileLines(row.transcript_path);
  if (lines.length < 2) {
    return 'Transcript has fewer than two JSONL records';
  }

  let sawSidechain = false;
  let sawAssistantToolUse = false;
  let sawUserTurn = false;
  const sessionIds = new Set<string>();
  let latestTsMs = 0;

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return 'Transcript contains malformed JSON';
    }

    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    if (sessionId) sessionIds.add(sessionId);
    if (record.isSidechain === true) sawSidechain = true;

    const tsMs = parseTsMs(record);
    if (tsMs !== null) latestTsMs = Math.max(latestTsMs, tsMs);

    const message = record.message;
    const content = message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : undefined;
    if (!Array.isArray(content)) continue;

    if (record.type === 'assistant') {
      if (content.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_use')) {
        sawAssistantToolUse = true;
      }
    }
    if (record.type === 'user') {
      sawUserTurn = true;
    }
  }

  if (row.session_id && sessionIds.size > 0 && !sessionIds.has(row.session_id)) {
    return `Transcript sessionIds ${[...sessionIds].join(', ')} do not include ${row.session_id}`;
  }
  if (!sawSidechain) return 'Transcript never marks isSidechain=true';
  if (!sawAssistantToolUse) return 'Transcript lacks assistant tool_use blocks';
  if (!sawUserTurn) return 'Transcript lacks any user/tool_result turn';
  if (latestTsMs > 0 && latestTsMs > (row.ts * 1000) + (5 * 60 * 1000)) {
    return `Transcript timestamp ${new Date(latestTsMs).toISOString()} exceeds row ts ${new Date(row.ts * 1000).toISOString()}`;
  }
  return null;
}

function findRepoForSlug(projectRoot: string, slug: string, dispatches: DispatchEvent[]): string {
  const fromDispatch = [...dispatches]
    .reverse()
    .find((dispatch) => dispatch.directive?.slug === slug && dispatch.directive.repo);
  return resolve(fromDispatch?.directive?.repo || projectRoot);
}

function walkAgentArtifacts(root: string, slug: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const visit = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (normalizePath(abs).includes(`/${slug}`)) out.push(abs);
        visit(abs);
        continue;
      }
      if (entry.isFile() && normalizePath(abs).includes(`/${slug}`)) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return [...new Set(out)].sort((a, b) => a.length - b.length);
}

function resolveArtifactPath(projectRoot: string, slug: string, row: LedgerRow): string | null {
  const obfRoot = join(projectRoot, '.agent', 'one-big-feature', slug);
  const directCandidates = row.stage === 'plan'
    ? [join(obfRoot, '02-master-plan.md')]
    : row.stage === 'specs'
      ? [join(obfRoot, '03-specs')]
      : [];

  for (const candidate of directCandidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (describeArtifact(candidate).sha256 === row.artifact_sha256) {
        return candidate;
      }
    } catch {
      // Keep searching; malformed candidate is not authoritative.
    }
  }

  const agentRoot = join(projectRoot, '.agent');
  for (const candidate of walkAgentArtifacts(agentRoot, slug)) {
    try {
      if (describeArtifact(candidate).sha256 === row.artifact_sha256) {
        return candidate;
      }
    } catch {
      // Ignore unreadable candidates and keep scanning.
    }
  }

  return null;
}

function ensureOutputDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function collectGateMtimeAdvisories(projectRoot: string, window: AuditWindow): AuditAdvisory[] {
  const exactPaths = [
    join(projectRoot, 'orgs/clearworksai/agents/larry/.claude/settings.json'),
    join(projectRoot, 'bin/pipeline-stage-emit'),
    join(projectRoot, 'bin/pipeline-provision-secret'),
    join(projectRoot, 'src/bus/message.ts'),
  ];
  const dirPaths = [
    join(projectRoot, 'orgs/clearworksai/agents/larry/.claude/hooks'),
    join(projectRoot, 'src/pipeline'),
  ];
  const changed: string[] = [];

  for (const path of exactPaths) {
    if (!existsSync(path)) continue;
    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs >= window.start_ms && mtimeMs <= window.end_ms) {
      changed.push(`${path} mtime=${new Date(mtimeMs).toISOString()}`);
    }
  }

  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      const mtimeMs = statSync(abs).mtimeMs;
      if (mtimeMs >= window.start_ms && mtimeMs <= window.end_ms) {
        changed.push(`${abs} mtime=${new Date(mtimeMs).toISOString()}`);
      }
    }
  };

  for (const dir of dirPaths) visit(dir);

  if (changed.length === 0) return [];
  return [{
    kind: 'gate-mtime',
    detail: 'Gate machinery changed inside the audit window',
    evidence: changed.sort(),
  }];
}

function countSignedExempts(ledgerPath: string, windowStartMs: number): number {
  return readLedgerRows(ledgerPath)
    .filter((row) => row.stage === 'exempt' && (row.ts * 1000) >= windowStartMs)
    .length;
}

function parseBranchSlug(command: string): string | undefined {
  return command.match(/(?:^|[\s'"])(?:feature\/|fix\/|chore\/|hotfix\/)?([a-z0-9-]+)(?:[\s'"]|$)/)?.[1];
}

function pushBypass(kind: AuditFinding['kind'], detail: string, evidence: string[], slug?: string, code?: string): AuditFinding {
  return {
    kind,
    slug,
    code,
    detail,
    evidence,
  };
}

function verifyDispatchLikeRecord(
  slug: string | undefined,
  throughStage: 'specs' | 'true-verify' | 'exempt',
  codePrefix: 'dispatch' | 'pr' | 'push',
  evidence: string[],
  projectRoot: string,
  ledgerPath: string,
  secretPath: string,
  transcriptRoot: string,
  nowSeconds: number,
  scopeSha?: string,
): { finding?: AuditFinding; verified?: boolean } {
  if (!slug) {
    return {
      finding: pushBypass(
        `${codePrefix}-no-slug`,
        `${codePrefix.toUpperCase()} event has no derivable slug`,
        evidence,
      ),
    };
  }

  const result = verifyChainDetailed({
    slug,
    throughStage,
    maxAgeSeconds: 86_400,
    scopeSha,
    ledgerPath,
    secretPath,
    transcriptRoot,
    nowSeconds,
  });
  if (!result.ok) {
    return {
      finding: pushBypass(
        `${codePrefix}-no-chain`,
        result.detail,
        evidence,
        slug,
        result.code,
      ),
    };
  }

  if (throughStage === 'specs') {
    const repoRoot = findRepoForSlug(projectRoot, slug, []);
    const artifactCheck = verifyOneBigFeatureArtifacts({
      projectRoot: repoRoot,
      slug,
      rows: result.rows,
    });
    if (!artifactCheck.ok) {
      return {
        finding: pushBypass(
          `${codePrefix}-no-chain`,
          artifactCheck.detail,
          evidence,
          slug,
          artifactCheck.code,
        ),
      };
    }
  }

  return { verified: true };
}

export function formatBatchedPage(report: AuditReport): string {
  const lines = [
    `Pipeline bypass audit found ${report.bypasses.length} issue(s) in the last 24h.`,
  ];
  for (const finding of report.bypasses) {
    const slug = finding.slug ? ` [${finding.slug}]` : '';
    const code = finding.code ? ` ${finding.code}` : '';
    lines.push(`- ${finding.kind}${slug}${code}: ${finding.detail}`);
  }
  if (report.advisories.length > 0) {
    lines.push(`Advisories: ${report.advisories.length}.`);
  }
  return lines.join('\n');
}

export function runBypassAudit(opts: RunAuditOptions): AuditReport {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? 24;
  const window: AuditWindow = {
    start_ms: nowMs - (windowHours * 60 * 60 * 1000),
    end_ms: nowMs,
  };

  const ledgerPath = resolve(opts.ledgerPath || defaultLedgerPath(opts.projectRoot));
  const secretPath = resolve(opts.secretPath || defaultSecretPath());
  const transcriptRoot = resolve(opts.transcriptRoot || defaultTranscriptRoot());
  const projectRoot = resolve(opts.projectRoot);
  const timeline = scanParentTranscripts(resolve(opts.parentTranscriptRoot), window);
  const busDispatches = readBusDispatches(resolve(opts.ctxRoot), window);
  const bypasses: AuditFinding[] = [];
  const advisories: AuditAdvisory[] = collectGateMtimeAdvisories(projectRoot, window);
  let chainsVerified = 0;

  for (const dispatch of timeline.dispatches) {
    const evidence = [`${dispatch.transcriptPath}:${dispatch.line}`];
    if (!dispatch.directive?.slug) {
      bypasses.push(pushBypass('dispatch-no-slug', 'Dispatch command lacked a parseable GATE: build slug', evidence));
      continue;
    }
    const result = verifyChainDetailed({
      slug: dispatch.directive.slug,
      throughStage: dispatch.directive.exempt ? 'exempt' : 'specs',
      maxAgeSeconds: 86_400,
      scopeSha: dispatch.directive.exempt ? undefined : dispatch.directive.scopeSha,
      ledgerPath,
      secretPath,
      transcriptRoot,
      nowSeconds: Math.floor(nowMs / 1000),
    });
    if (!result.ok) {
      bypasses.push(pushBypass('dispatch-no-chain', result.detail, evidence, dispatch.directive.slug, result.code));
      continue;
    }

    if (dispatch.directive.framework === 'one-big-feature') {
      const artifactCheck = verifyOneBigFeatureArtifacts({
        projectRoot: resolve(dispatch.directive.repo),
        slug: dispatch.directive.slug,
        rows: result.rows,
      });
      if (!artifactCheck.ok) {
        bypasses.push(pushBypass('dispatch-no-chain', artifactCheck.detail, evidence, dispatch.directive.slug, artifactCheck.code));
        continue;
      }
    }

    chainsVerified += 1;
  }

  for (const busDispatch of busDispatches) {
    const match = findTranscriptMatch(busDispatch, timeline.dispatches);
    if (!match) {
      bypasses.push(pushBypass(
        'bus-store-bypass',
        'Bus-store dispatch has no matching transcript Bash tool_use',
        [`${busDispatch.path} @ ${new Date(busDispatch.tsMs).toISOString()}`],
        busDispatch.directive?.slug,
      ));
    }
  }

  for (const pr of timeline.prs) {
    const slug = parseBranchSlug(pr.command);
    const result = verifyDispatchLikeRecord(
      slug,
      'true-verify',
      'pr',
      [`${pr.transcriptPath}:${pr.line}`],
      projectRoot,
      ledgerPath,
      secretPath,
      transcriptRoot,
      Math.floor(nowMs / 1000),
    );
    if (result.finding) {
      bypasses.push(result.finding);
      continue;
    }
    chainsVerified += 1;
  }

  for (const push of timeline.pushes) {
    const slug = parseBranchSlug(push.command);
    const result = verifyDispatchLikeRecord(
      slug,
      'true-verify',
      'push',
      [`${push.transcriptPath}:${push.line}`],
      projectRoot,
      ledgerPath,
      secretPath,
      transcriptRoot,
      Math.floor(nowMs / 1000),
    );
    if (result.finding) {
      bypasses.push(result.finding);
      continue;
    }
    chainsVerified += 1;
  }

  const authoredRows = readLedgerRows(ledgerPath)
    .filter((row) => AUTHORED_STAGES.has(row.stage) && (row.ts * 1000) >= window.start_ms && (row.ts * 1000) <= window.end_ms);

  for (const row of authoredRows) {
    const rowEvidence = [`ledger:${row.slug}:${row.stage}:${row.ts}`];

    const spawn = timeline.spawns
      .filter((event) => event.tsMs <= row.ts * 1000 && subjectMentionsSlug(event.subject, row.slug))
      .sort((a, b) => b.tsMs - a.tsMs)[0];
    if (!spawn) {
      bypasses.push(pushBypass(
        'hole3-no-spawn',
        `No parent Agent/Task spawn record brackets ${row.slug}:${row.stage}`,
        rowEvidence,
        row.slug,
      ));
      continue;
    }
    if (spawn.completedAtMs && spawn.completedAtMs > row.ts * 1000) {
      bypasses.push(pushBypass(
        'hole3-no-spawn',
        `Parent spawn completed after emit for ${row.slug}:${row.stage}`,
        [...rowEvidence, `${spawn.transcriptPath}:${spawn.line}`],
        row.slug,
      ));
      continue;
    }

    const repoRoot = findRepoForSlug(projectRoot, row.slug, timeline.dispatches);
    const artifactPath = resolveArtifactPath(repoRoot, row.slug, row);
    if (!artifactPath) {
      bypasses.push(pushBypass(
        'hole3-no-artifact',
        `Could not resolve on-disk artifact for ${row.slug}:${row.stage} by signed sha`,
        [...rowEvidence, repoRoot],
        row.slug,
      ));
      continue;
    }

    const provenance = verifyTranscriptAuthorship({
      artifactPath,
      transcriptPath: row.transcript_path || '',
      transcriptRoot,
      expectedSessionId: row.session_id,
    });
    if (!provenance.ok) {
      bypasses.push(pushBypass(
        'hole3-deep-authorship',
        provenance.detail,
        [...rowEvidence, artifactPath],
        row.slug,
        provenance.code,
      ));
      continue;
    }
    if (row.transcript_sha256 && provenance.transcript_sha256 !== row.transcript_sha256) {
      bypasses.push(pushBypass(
        'hole3-deep-authorship',
        `Transcript hash drift for ${row.slug}:${row.stage}`,
        [...rowEvidence, row.transcript_path || ''],
        row.slug,
        'TRANSCRIPT_TAMPERED',
      ));
      continue;
    }

    const structureFailure = checkTranscriptStructure(row);
    if (structureFailure) {
      bypasses.push(pushBypass(
        'hole3-structure',
        structureFailure,
        [...rowEvidence, row.transcript_path || ''],
        row.slug,
      ));
      continue;
    }

    const handWrites = timeline.planningWrites.filter((event) => event.slug === row.slug && event.tsMs <= row.ts * 1000);
    if (handWrites.length > 0) {
      bypasses.push(pushBypass(
        'hole3-hand-authoring',
        `Larry parent transcript directly wrote planning bytes for ${row.slug} before provenance row ${row.stage}`,
        [...rowEvidence, ...handWrites.map((event) => `${event.transcriptPath}:${event.line}`)],
        row.slug,
      ));
      continue;
    }

    chainsVerified += 1;
  }

  const exemptCount = countSignedExempts(ledgerPath, nowMs - (7 * 24 * 60 * 60 * 1000));
  if (exemptCount > 10) {
    advisories.push({
      kind: 'exempt-threshold',
      detail: `Signed exempt rows exceeded threshold in trailing 7d: ${exemptCount}`,
      evidence: [`ledger:${basename(ledgerPath)}`],
    });
  }

  const report: AuditReport = {
    window,
    dispatches_found: timeline.dispatches.length + busDispatches.length,
    prs_found: timeline.prs.length,
    chains_verified: chainsVerified,
    provenance_rows_checked: authoredRows.length,
    bypasses,
    advisories,
    exempt_count_7d: exemptCount,
  };

  if (opts.outputPath) {
    const outputPath = resolve(opts.outputPath);
    ensureOutputDir(outputPath);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }

  return report;
}

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      flags.help = 'true';
      continue;
    }
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    if (!rawKey) continue;
    if (inline !== undefined) {
      flags[rawKey] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[rawKey] = 'true';
      continue;
    }
    flags[rawKey] = next;
    i += 1;
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value || value === 'true') {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function defaultParentTranscriptRoot(projectRoot: string, agentName: string): string {
  const absAgentDir = resolve(projectRoot, 'orgs', 'clearworksai', 'agents', agentName);
  return join(homedir(), '.claude', 'projects', absAgentDir.replace(/\//g, '-'));
}

function defaultOutputPath(projectRoot: string, agentName: string, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return join(projectRoot, 'orgs', 'clearworksai', 'agents', agentName, 'state', 'bypass-audit', `${date}.json`);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const flags = parseArgs(argv);
  if (flags.help === 'true') {
    console.log(usage());
    process.exit(0);
  }

  try {
    const projectRoot = resolve(requireFlag(flags, 'project-root'));
    const ctxRoot = resolve(requireFlag(flags, 'ctx-root'));
    const agentName = flags.agent || 'larry';
    const nowMs = Date.now();
    const report = runBypassAudit({
      agentName,
      projectRoot,
      ctxRoot,
      parentTranscriptRoot: resolve(flags['parent-transcript-root'] || defaultParentTranscriptRoot(projectRoot, agentName)),
      ledgerPath: flags.ledger,
      secretPath: flags.secret,
      transcriptRoot: flags['transcript-root'],
      windowHours: flags['window-hours'] ? Number.parseInt(flags['window-hours'], 10) : 24,
      outputPath: flags.output || defaultOutputPath(projectRoot, agentName, nowMs),
      nowMs,
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
