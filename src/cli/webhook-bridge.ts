import { Command } from 'commander';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { homedir } from 'os';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { listAgents } from '../bus/agents.js';
import { sendMessage } from '../bus/message.js';
import { loadEnvFileInto } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { validateOrgName } from '../utils/validate.js';
import type { BusPaths } from '../types/index.js';
import { resolveInstanceId } from './resolve-instance-id.js';
import { planWorkerSpawn, trySpawnWorkerForEvent, type WorkerSpawnTemplate } from '../daemon/worker-spawn-plan.js';
import {
  ZOOM_OFFICEHOURS_MEETING_ID,
  ZOOM_MAILCHIMP_LIST_ID,
  buildCrcResponse,
  verifyZoomSignature,
  processRegistrant,
  mirrorToMailchimp,
  type ZoomRegistrant,
} from './zoom-officehours-crm.js';
import { handleProviderShadowIngress, type CalendarShadowOptions, type GmailShadowOptions, type ProviderIngressDependencies, type ProviderRateBuckets } from './provider-shadow-ingress.js';

export const DEFAULT_PORT = 20242;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PLIST_LABEL = 'com.cortextos.webhook-bridge';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const SOURCE_NAME = 'webhook-hub';
const ALLOWED_INTEGRATIONS = ['zoom-officehours', 'fireflies', 'ops-check-lead'] as const;

interface BridgeConfig {
  port?: number;
  createdAt?: string;
}

interface BridgeRuntimeContext {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  org?: string;
  bridgeSecret: string;
  firefliesWebhookSecret?: string;
  zoomWebhookSecretToken?: string;
  mailchimpApiKey?: string;
}

export interface BridgeServerOptions {
  instanceId?: string;
  ctxRoot: string;
  frameworkRoot: string;
  org?: string;
  bridgeSecret: string;
  firefliesWebhookSecret?: string;
  zoomWebhookSecretToken?: string;
  mailchimpApiKey?: string;
  // Test seams (only consulted when zoom mode is active).
  zoomContactsPath?: string;
  zoomStateDir?: string;
  fetchImpl?: typeof fetch;
  allowedIntegrations?: readonly string[];
  now?: () => number;
  providerShadowStateDir?: string;
  providerConfigDir?: string;
  gmailShadow?: GmailShadowOptions;
  calendarShadow?: CalendarShadowOptions;
  providerIngressDependencies?: ProviderIngressDependencies;
}

interface RelayEnvelope {
  integration?: unknown;
  target?: unknown;
  event?: unknown;
  meeting_id?: unknown;
  registrant?: unknown;
  meetingId?: unknown;
  eventType?: unknown;
  [key: string]: unknown;
}

// Fireflies' dashboard webhook sends {"meetingId": "...", "eventType": "Transcription completed"}
// — camelCase, no integration field, and no way to configure otherwise. Normalize that native
// shape into the internal envelope before validation. Internal-shape fields always win; native
// fields only fill gaps, so existing internal-envelope senders are unaffected.
function normalizeFirefliesEnvelope(envelope: RelayEnvelope): RelayEnvelope {
  const normalized: RelayEnvelope = { ...envelope };
  if (normalized.integration === undefined) {
    normalized.integration = 'fireflies';
  }
  if (normalized.event === undefined && typeof normalized.eventType === 'string') {
    normalized.event = normalized.eventType;
  }
  if (normalized.meeting_id === undefined && normalized.meetingId !== undefined) {
    normalized.meeting_id = normalized.meetingId;
  }
  return normalized;
}

function jsonResponse(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bridgeSecretMatches(headerValue: string, bridgeSecret: string): boolean {
  return timingSafeEqual(sha256Digest(headerValue), sha256Digest(bridgeSecret));
}

function hmacSignatureMatches(rawBody: string, providedHeader: string, secret: string): boolean {
  const prefix = 'sha256=';
  const providedHex = providedHeader.startsWith(prefix) ? providedHeader.slice(prefix.length) : providedHeader;
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(sha256Digest(providedHex), sha256Digest(expectedHex));
}

/**
 * List the org names under `<frameworkRoot>/orgs` (directories only). Used to
 * resolve a single-org default so the generated launchd plist can pin CTX_ORG
 * going forward.
 */
export function listOrgDirs(frameworkRoot: string): string[] {
  try {
    return readdirSync(join(frameworkRoot, 'orgs'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function selectFrameworkOrg(
  orgDirs: string[],
  envFromFiles: Record<string, string>,
  orgOverride?: string,
): string {
  const org = orgOverride
    || process.env.CTX_ORG
    || envFromFiles.CTX_ORG
    || (orgDirs.length === 1 ? orgDirs[0] : '');
  if (org) validateOrgName(org);
  return org;
}

export function readFrameworkEnv(frameworkRoot: string, orgOverride?: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (!frameworkRoot) return resolved;
  loadEnvFileInto(join(frameworkRoot, '.cortextos-env'), resolved);
  loadEnvFileInto(join(frameworkRoot, '.env'), resolved);
  const orgDirs = listOrgDirs(frameworkRoot);
  const org = selectFrameworkOrg(orgDirs, resolved, orgOverride);
  if (org) {
    loadEnvFileInto(join(frameworkRoot, 'orgs', org, 'secrets.env'), resolved);
    // Do not let a secrets file redirect the resolved org after its path was chosen.
    resolved.CTX_ORG = org;
  }
  return resolved;
}

function getCliEntryPath(): string {
  return resolvePath(process.argv[1] || join(process.cwd(), 'dist', 'cli.js'));
}

function findFrameworkRoot(): string {
  const cliDirCandidate = join(dirname(getCliEntryPath()), '..');
  const candidates = [
    process.env.CTX_FRAMEWORK_ROOT,
    process.env.CORTEXTOS_DIR,
    process.env.CTX_PROJECT_ROOT,
    cliDirCandidate,
    process.cwd(),
    join(homedir(), 'cortextos'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const packagePath = join(candidate, 'package.json');
    if (!existsSync(packagePath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: string };
      if (pkg.name === 'cortextos' || pkg.name === 'ascendops') {
        return candidate;
      }
    } catch {
      // Ignore malformed package.json and continue searching.
    }
  }

  return cliDirCandidate;
}

export function resolveBridgeRuntimeContext(instanceId: string, orgOverride?: string): BridgeRuntimeContext {
  const frameworkRoot = findFrameworkRoot();
  const envFromFiles = readFrameworkEnv(frameworkRoot, orgOverride);
  // Resolve org from env, then fall back to the sole org dir when unambiguous, so the
  // generated plist pins CTX_ORG and future starts load that org's secrets directly.
  const orgDirs = listOrgDirs(frameworkRoot);
  const org = selectFrameworkOrg(orgDirs, envFromFiles, orgOverride);
  const ctxRoot = process.env.CTX_ROOT || envFromFiles.CTX_ROOT || join(homedir(), '.cortextos', instanceId);
  const bridgeSecret = process.env.WEBHOOK_BRIDGE_SECRET || envFromFiles.WEBHOOK_BRIDGE_SECRET || '';
  const firefliesWebhookSecret = process.env.FIREFLIES_WEBHOOK_SECRET || envFromFiles.FIREFLIES_WEBHOOK_SECRET || undefined;
  const zoomWebhookSecretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || envFromFiles.ZOOM_WEBHOOK_SECRET_TOKEN || undefined;
  const mailchimpApiKey = process.env.MAILCHIMP_API_KEY || envFromFiles.MAILCHIMP_API_KEY || undefined;

  if (!org && orgDirs.length > 1) {
    throw new Error(
      `Organization is required because ${orgDirs.length} orgs exist (${orgDirs.join(', ')}). Pass --org <id> or set CTX_ORG.`,
    );
  }
  if (org && !orgDirs.includes(org)) {
    throw new Error(`Unknown organization "${org}". Expected one of: ${orgDirs.join(', ') || '(none)'}.`);
  }
  if (!bridgeSecret) {
    throw new Error(
      'WEBHOOK_BRIDGE_SECRET is required. Set it in the environment, .cortextos-env, or orgs/<org>/secrets.env before starting webhook-bridge.',
    );
  }

  return {
    instanceId,
    ctxRoot,
    frameworkRoot,
    org: org || undefined,
    bridgeSecret,
    firefliesWebhookSecret,
    zoomWebhookSecretToken,
    mailchimpApiKey,
  };
}

function parsePort(value: string, optionName: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${optionName} must be a valid TCP port (1-65535).`);
  }
  return port;
}

function readRequestBody(request: IncomingMessage, response: ServerResponse): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    request.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bufferChunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        jsonResponse(response, 413, { error: 'body_too_large', tier: 'body' });
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(bufferChunk);
    });

    request.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    request.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function withRegistryEnv<T>(frameworkRoot: string, fn: () => T): T {
  const savedFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const savedProjectRoot = process.env.CTX_PROJECT_ROOT;

  if (frameworkRoot) {
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    process.env.CTX_PROJECT_ROOT = frameworkRoot;
  }

  try {
    return fn();
  } finally {
    if (savedFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = savedFrameworkRoot;

    if (savedProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = savedProjectRoot;
  }
}

function isKnownAgent(target: string, ctxRoot: string, frameworkRoot: string, org?: string): boolean {
  return withRegistryEnv(frameworkRoot, () => listAgents(ctxRoot, org).some((agent) => agent.name === target));
}

function resolveActiveTarget(target: string, ctxRoot: string, frameworkRoot: string, org?: string): string {
  const agents = withRegistryEnv(frameworkRoot, () => listAgents(ctxRoot, org));
  const resolvedTarget = agents.find((agent) => agent.name === target);
  if (resolvedTarget?.last_heartbeat && resolvedTarget.running) return target;

  const codexTarget = agents.find((agent) => agent.name === `${target}-codex`);
  return codexTarget?.running ? codexTarget.name : target;
}

function resolveBusPaths(ctxRoot: string, target: string, instanceId: string, org?: string): BusPaths {
  const resolved = resolvePaths(target, instanceId, org);
  const orgRoot = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  return {
    ...resolved,
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', target),
    inflight: join(ctxRoot, 'inflight', target),
    processed: join(ctxRoot, 'processed', target),
    logDir: join(ctxRoot, 'logs', target),
    stateDir: join(ctxRoot, 'state', target),
    taskDir: join(orgRoot, 'tasks'),
    approvalDir: join(orgRoot, 'approvals'),
    analyticsDir: join(orgRoot, 'analytics'),
    deliverablesDir: join(orgRoot, 'deliverables'),
  };
}

function wakeFastChecker(ctxRoot: string, target: string): void {
  const pidFile = join(ctxRoot, 'state', target, '.fast-checker.pid');
  if (!existsSync(pidFile)) return;

  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid > 0) {
      process.kill(pid, 'SIGUSR1');
    }
  } catch {
    // Fast-checker may not be running; relay success does not depend on wake.
  }
}

function appendInboundLog(ctxRoot: string, target: string, messageId: string, text: string): void {
  const logDir = join(ctxRoot, 'logs', target);
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'inbound-messages.jsonl');
  const logEntry = JSON.stringify({
    id: messageId,
    timestamp: new Date().toISOString(),
    agent: target,
    direction: 'inbound',
    type: 'integration',
    text,
    from_name: SOURCE_NAME,
    source: 'webhook-bridge',
  });
  appendFileSync(logFile, logEntry + '\n');
}

export function extractMeetingId(envelope: RelayEnvelope): string {
  return envelope.meeting_id === undefined || envelope.meeting_id === null
    ? ''
    : String(envelope.meeting_id).trim();
}

/**
 * The fireflies meeting-writeback lane, expressed as a generic worker-spawn
 * template (FR-E1). This is the working reference every other event lane clones;
 * the spawn mechanics live in `daemon/worker-spawn-plan.ts`. The prompt and env
 * are byte-for-byte what the fireflies path emitted before the extraction, so
 * `planMeetingWritebackSpawn` remains a behavior-preserving thin wrapper.
 */
function firefliesWritebackTemplate(args: {
  frameworkRoot: string;
  org?: string;
  target: string;
  skillExists?: (path: string) => boolean;
}): WorkerSpawnTemplate {
  return {
    frameworkRoot: args.frameworkRoot,
    org: args.org,
    target: args.target,
    workerNamePrefix: 'meeting-writeback',
    skillRelativePaths: [
      join('..', '..', 'skills', 'meeting-writeback-worker', 'SKILL.md'),
      join('plugins', 'cortextos-agent-skills', 'skills', 'meeting-writeback-worker', 'SKILL.md'),
      join('.claude', 'skills', 'meeting-writeback-worker', 'SKILL.md'),
      join('plugins', 'meeting-writeback-worker', 'SKILL.md'),
    ],
    buildPrompt: ({ skillRelativePath, eventId }) =>
      [
        'You are the meeting-writeback worker (short-lived session).',
        `FF_MEETING_ID=${eventId} is set in your environment.`,
        `Read ${skillRelativePath} and execute every bash block in order,`,
        'then output DONE. Do nothing else — no heartbeat, no daily memory, no Telegram.',
      ].join(' '),
    buildEnv: (eventId) => ({ FF_MEETING_ID: eventId }),
    skillExists: args.skillExists,
  };
}

/**
 * Pure planner for a deterministic meeting-writeback spawn. Behavior-preserving
 * wrapper over the generic `planWorkerSpawn` backbone (FR-E1): resolves the worker
 * name (lowercased/sanitized to satisfy the daemon's WORKER_NAME_REGEX), the agent
 * dir (dynamic — from framework root/org, never a hardcoded absolute), and the
 * prompt. Returns null when the inputs can't produce a valid, filed-capable spawn
 * (missing org, empty id after sanitization, or the target has no writeback skill),
 * so the caller falls back to the NL relay. No IPC here — kept pure for testing.
 */
export function planMeetingWritebackSpawn(args: {
  frameworkRoot: string;
  org?: string;
  target: string;
  meetingId: string;
  skillExists?: (dir: string) => boolean;
}): { workerName: string; dir: string; prompt: string } | null {
  const plan = planWorkerSpawn(firefliesWritebackTemplate(args), args.meetingId);
  if (!plan) return null;
  return { workerName: plan.workerName, dir: plan.dir, prompt: plan.prompt };
}

/**
 * Deterministic meeting-writeback: spawn the writeback worker directly via the
 * daemon (IPC spawn-worker) for a fireflies meeting event, resolving the target
 * agent's dir dynamically from the framework root/org (no hardcoded absolute path).
 * FF_MEETING_ID is injected into the worker env so the skill's single-meeting fast
 * path runs. Returns ok:false on any failure so the caller can fall back to the
 * NL inbox relay (no regression if the daemon is unreachable).
 */
async function trySpawnMeetingWriteback(args: {
  instanceId?: string;
  frameworkRoot: string;
  org?: string;
  target: string;
  meetingId: string;
}): Promise<{ ok: true; workerName: string } | { ok: false }> {
  const result = await trySpawnWorkerForEvent(
    'fireflies',
    () => planWorkerSpawn(firefliesWritebackTemplate(args), args.meetingId),
    { instanceId: args.instanceId, parent: args.target },
  );
  return result.ok ? { ok: true, workerName: result.workerName } : { ok: false };
}

function buildRelayMessage(integration: string, event: string, envelope: RelayEnvelope, target = 'pa'): string {
  const meetingId = extractMeetingId(envelope);

  if (integration === 'fireflies' && meetingId) {
    return `WEBHOOK ${integration} ${event} — meeting ${meetingId}. Spawn meeting-writeback-worker with FF_MEETING_ID=${meetingId} set so the single-meeting fast path runs now instead of waiting for the 2h poll: cd ${target} agent dir, source env, read ../../skills/meeting-writeback-worker/SKILL.md and execute every bash block in order, then python3 scripts/ff-extractor.py --mode full --meeting-id ${meetingId}.`;
  }

  if (integration === 'ops-check-lead') {
    const contact = typeof envelope.contact === 'object' && envelope.contact !== null
      ? envelope.contact as Record<string, unknown>
      : null;
    const firmographic = typeof envelope.firmographic === 'object' && envelope.firmographic !== null
      ? envelope.firmographic as Record<string, unknown>
      : null;
    const openText = typeof envelope.openText === 'object' && envelope.openText !== null
      ? envelope.openText as Record<string, unknown>
      : null;
    const computed = typeof envelope.computed === 'object' && envelope.computed !== null
      ? envelope.computed as Record<string, unknown>
      : null;
    const topGaps = Array.isArray(computed?.topGaps)
      ? computed.topGaps.filter((gap): gap is Record<string, unknown> => typeof gap === 'object' && gap !== null)
      : [];

    const name = typeof contact?.name === 'string' && contact.name.trim()
      ? contact.name.trim()
      : 'Unknown lead';
    const email = typeof contact?.email === 'string' && contact.email.trim()
      ? contact.email.trim()
      : 'unknown-email';
    const company = typeof contact?.company === 'string' && contact.company.trim()
      ? contact.company.trim()
      : 'unknown company';
    const score = computed?.score === undefined || computed.score === null
      ? 'unknown'
      : String(computed.score).trim() || 'unknown';
    const band = typeof computed?.band === 'string' && computed.band.trim()
      ? computed.band.trim()
      : 'unknown';
    const gapIds = topGaps
      .map((gap) => (typeof gap.id === 'string' ? gap.id.trim() : ''))
      .filter(Boolean);
    const keepsUpAtNight = typeof openText?.keepsUpAtNight === 'string' && openText.keepsUpAtNight.trim()
      ? openText.keepsUpAtNight.trim()
      : typeof openText?.keepsYouUp === 'string' && openText.keepsYouUp.trim()
        ? openText.keepsYouUp.trim()
        : 'n/a';
    const processDescription = typeof openText?.processDescription === 'string' && openText.processDescription.trim()
      ? openText.processDescription.trim()
      : 'n/a';
    const industry = typeof firmographic?.industry === 'string' && firmographic.industry.trim()
      ? firmographic.industry.trim()
      : 'n/a';
    const teamSize = typeof firmographic?.teamSize === 'string' && firmographic.teamSize.trim()
      ? firmographic.teamSize.trim()
      : 'n/a';
    const role = typeof firmographic?.role === 'string' && firmographic.role.trim()
      ? firmographic.role.trim()
      : 'n/a';
    const submittedAt = typeof envelope.occurred_at === 'string' && envelope.occurred_at.trim()
      ? envelope.occurred_at.trim()
      : 'unknown';

    return [
      `WEBHOOK ${integration} ${event} — new ops-check lead-magnet submission from ${name} <${email}> at ${company}.`,
      'Run crm/upsert-contact.py for this lead. Dedup by email. Tag as prospect and lead-magnet. Notes must include the ops-check score, band, top gaps, and both open-text answers.',
      `Score: ${score}`,
      `Band: ${band}`,
      `Top gaps (ids): ${gapIds.join(', ') || 'n/a'}`,
      `Firmographic: industry=${industry}; teamSize=${teamSize}; role=${role}`,
      `Keeps them up: ${keepsUpAtNight}`,
      `Process: ${processDescription}`,
      `Submitted at: ${submittedAt}`,
      'Full payload:',
      '```json',
      JSON.stringify(envelope, null, 2),
      '```',
    ].join('\n');
  }

  const registrant = typeof envelope.registrant === 'object' && envelope.registrant !== null
    ? envelope.registrant as Record<string, unknown>
    : null;
  const firstName = typeof registrant?.first_name === 'string' ? registrant.first_name.trim() : '';
  const lastName = typeof registrant?.last_name === 'string' ? registrant.last_name.trim() : '';
  const email = typeof registrant?.email === 'string' ? registrant.email.trim() : '';

  if (registrant && (firstName || lastName || email || meetingId)) {
    const name = [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown registrant';
    return `WEBHOOK ${integration} ${event} — registrant ${name} <${email}> for meeting ${meetingId}. Run the classify+upsert path from crm/zoom-officehours-sync.py for THIS registrant: email/name-tier match against contacts.json, tag aia-office-hours + cohort, mirror to Mailchimp. AMBIG/NOISE = do not auto-write.`;
  }

  return `WEBHOOK ${integration} ${event} — payload: ${JSON.stringify(envelope)}`;
}

function getBridgeConfigPath(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'webhook-bridge.json');
}

function readBridgeConfig(instanceId: string): BridgeConfig {
  try {
    return JSON.parse(readFileSync(getBridgeConfigPath(instanceId), 'utf-8')) as BridgeConfig;
  } catch {
    return {};
  }
}

function writeBridgeConfig(instanceId: string, config: BridgeConfig): void {
  const configPath = getBridgeConfigPath(instanceId);
  mkdirSync(join(homedir(), '.cortextos', instanceId), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function checkPlatform(): void {
  if (process.platform !== 'darwin') {
    console.error('  cortextos webhook-bridge requires macOS (uses launchd for persistence).');
    process.exit(1);
  }
}

function getUid(): string {
  try {
    return execSync('id -u', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return String(process.getuid ? process.getuid() : 501);
  }
}

function isServiceLoaded(): boolean {
  const result = spawnSync('launchctl', ['list', PLIST_LABEL], { stdio: 'pipe' });
  return result.status === 0;
}

function loadService(): void {
  const uid = getUid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${PLIST_LABEL}`], { stdio: 'pipe' });
  spawnSync('launchctl', ['bootout', `gui/${uid}`, PLIST_PATH], { stdio: 'pipe' });

  const result = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    const legacyResult = spawnSync('launchctl', ['load', '-w', PLIST_PATH], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (legacyResult.status !== 0) {
      throw new Error(`Failed to load service: ${legacyResult.stderr || legacyResult.stdout}`);
    }
  }
}

function unloadService(): void {
  const uid = getUid();
  const result = spawnSync('launchctl', ['bootout', `gui/${uid}/${PLIST_LABEL}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    spawnSync('launchctl', ['unload', '-w', PLIST_PATH], { stdio: 'pipe' });
  }
}

function buildLaunchdPath(): string {
  const candidates = [
    dirname(process.execPath),
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  return candidates.filter((value, index, all) => value && all.indexOf(value) === index).join(':');
}

function writePlist(context: BridgeRuntimeContext, port: number): void {
  const logDir = join(homedir(), '.cortextos', context.instanceId, 'logs', 'webhook-bridge');
  mkdirSync(logDir, { recursive: true });

  const cliEntryPath = getCliEntryPath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${cliEntryPath}</string>
        <string>webhook-bridge</string>
        <string>run</string>
        <string>--instance</string>
        <string>${context.instanceId}</string>
        <string>--port</string>
        <string>${port}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>WorkingDirectory</key>
    <string>${context.frameworkRoot}</string>

    <key>StandardOutPath</key>
    <string>${logDir}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${logDir}/stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homedir()}</string>
        <key>PATH</key>
        <string>${buildLaunchdPath()}</string>
        <key>CTX_ROOT</key>
        <string>${context.ctxRoot}</string>
        <key>CTX_INSTANCE_ID</key>
        <string>${context.instanceId}</string>
        <key>CTX_FRAMEWORK_ROOT</key>
        <string>${context.frameworkRoot}</string>
        <key>CTX_PROJECT_ROOT</key>
        <string>${context.frameworkRoot}</string>
${context.org ? `        <key>CTX_ORG</key>
        <string>${context.org}</string>
` : ''}    </dict>
</dict>
</plist>
`;

  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(PLIST_PATH, plist, 'utf-8');
  chmodSync(PLIST_PATH, 0o644);
}

export function createBridgeServer(options: BridgeServerOptions): Server {
  const allowedIntegrations = new Set(options.allowedIntegrations ?? ALLOWED_INTEGRATIONS);
  const now = options.now ?? Date.now;
  let windowStartedAt = now();
  let requestCount = 0;
  const providerRateBuckets: ProviderRateBuckets = new Map();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${DEFAULT_HOST}`);
      const pathParts = url.pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(response, 200, { ok: true, service: 'webhook-bridge' });
        return;
      }

      if (request.method !== 'POST' || pathParts.length !== 2 || pathParts[0] !== 'relay') {
        jsonResponse(response, 404, { error: 'not_found' });
        return;
      }

      const integration = pathParts[1];
      if (!/^[a-z0-9-]+$/.test(integration)) {
        jsonResponse(response, 404, { error: 'not_found' });
        return;
      }

      if (await handleProviderShadowIngress(integration, request, response, {
        stateDir: options.providerShadowStateDir ?? join(options.ctxRoot, 'state', 'pa'),
        now,
        gmail: options.gmailShadow,
        calendar: options.calendarShadow,
        dependencies: options.providerIngressDependencies,
        // FR-E2: per-lane shadow|active flag lives in provider-config.json under
        // the framework root. Absent/malformed => every lane defaults to shadow.
        configDir: options.providerConfigDir ?? options.frameworkRoot,
        // FR-E3: a lane's ACTIVE path resolves the target agent dir dynamically
        // for the deterministic worker spawn (comms-check-worker for gmail).
        frameworkRoot: options.frameworkRoot,
        org: options.org,
        instanceId: options.instanceId,
      }, providerRateBuckets)) return;

      const currentWindow = now();
      if (currentWindow - windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        windowStartedAt = currentWindow;
        requestCount = 0;
      }
      if (requestCount >= RATE_LIMIT_MAX) {
        response.setHeader('retry-after', '60');
        jsonResponse(response, 429, { error: 'rate_limited', tier: 'rate_limit' });
        return;
      }
      requestCount += 1;

      const rawBody = await readRequestBody(request, response);
      if (rawBody === null) return;

      const useFirefliesHmac = integration === 'fireflies' && !!options.firefliesWebhookSecret;

      // Zoom mode: active only when the secret is set AND (via test seams or org)
      // the CRM paths resolve. If org is undefined, zoom stays dormant (v1 behavior).
      const zoomContactsPath = options.zoomContactsPath
        ?? (options.org ? join(options.frameworkRoot, 'orgs', options.org, 'agents', 'crm', 'crm', 'contacts.json') : undefined);
      const zoomStateDir = options.zoomStateDir
        ?? (options.org ? join(options.frameworkRoot, 'orgs', options.org, 'agents', 'crm', 'state') : undefined);
      const zoomSuppressionPath = zoomContactsPath ? join(dirname(zoomContactsPath), '_ingest_suppression.json') : undefined;
      const zoomModeConfigured = !!options.zoomWebhookSecretToken && !!zoomContactsPath && !!zoomStateDir;
      const useZoomHmac = integration === 'zoom-officehours' && !!options.zoomWebhookSecretToken && zoomModeConfigured;

      const appendZoomLog = (entry: Record<string, unknown>): void => {
        if (!zoomStateDir) return;
        try {
          mkdirSync(zoomStateDir, { recursive: true });
          appendFileSync(
            join(zoomStateDir, 'zoom-officehours-webhook.jsonl'),
            `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`,
            'utf-8',
          );
        } catch { /* non-critical audit trail */ }
      };

      if (useZoomHmac) {
        // master-plan D2: signature is verified on ALL zoom POSTs, including CRC —
        // an unauthenticated CRC responder is an HMAC-forgery oracle.
        const zoomSig = request.headers['x-zm-signature'];
        const zoomTs = request.headers['x-zm-request-timestamp'];
        const verdict = verifyZoomSignature({
          rawBody,
          signatureHeader: Array.isArray(zoomSig) ? zoomSig[0] : zoomSig,
          timestampHeader: Array.isArray(zoomTs) ? zoomTs[0] : zoomTs,
          secret: options.zoomWebhookSecretToken as string,
          nowSeconds: Math.floor(now() / 1000),
        });
        if (!verdict.ok) {
          jsonResponse(response, 401, { error: verdict.reason, tier: 'auth' });
          return;
        }
      } else if (useFirefliesHmac) {
        const signatureHeader = request.headers['x-hub-signature'];
        const providedSignature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (!providedSignature) {
          jsonResponse(response, 401, { error: 'missing_secret', tier: 'auth' });
          return;
        }
        if (!hmacSignatureMatches(rawBody, providedSignature, options.firefliesWebhookSecret as string)) {
          jsonResponse(response, 401, { error: 'secret_mismatch', tier: 'auth' });
          return;
        }
      } else {
        const secretHeader = request.headers['x-webhook-bridge-secret'];
        const providedSecret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
        if (!providedSecret) {
          jsonResponse(response, 401, { error: 'missing_secret', tier: 'auth' });
          return;
        }
        if (!bridgeSecretMatches(providedSecret, options.bridgeSecret)) {
          jsonResponse(response, 401, { error: 'secret_mismatch', tier: 'auth' });
          return;
        }
      }

      if (!allowedIntegrations.has(integration)) {
        jsonResponse(response, 403, { error: 'unknown_integration', tier: 'integration' });
        return;
      }

      let envelope: RelayEnvelope;
      try {
        envelope = JSON.parse(rawBody) as RelayEnvelope;
      } catch {
        jsonResponse(response, 400, { error: 'invalid_json', tier: 'body' });
        return;
      }

      if (useZoomHmac) {
        const payload = (typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {}) as Record<string, unknown>;
        // CRC handshake — respond with the HMAC of plainToken (guarded per D2).
        if (envelope.event === 'endpoint.url_validation') {
          const plainToken = payload.plainToken;
          if (typeof plainToken !== 'string' || plainToken.length > 512) {
            jsonResponse(response, 400, { error: 'invalid_crc', tier: 'payload' });
            return;
          }
          jsonResponse(response, 200, buildCrcResponse(plainToken, options.zoomWebhookSecretToken as string));
          appendZoomLog({ type: 'crc' });
          return;
        }
        // Native Zoom shape → internal envelope (internal fields win, like fireflies).
        const object = (typeof payload.object === 'object' && payload.object !== null ? payload.object : {}) as Record<string, unknown>;
        if (envelope.integration === undefined) envelope.integration = 'zoom-officehours';
        if (envelope.meeting_id === undefined && object.id !== undefined) envelope.meeting_id = object.id;
        if (envelope.registrant === undefined && object.registrant !== undefined) envelope.registrant = object.registrant;
        // `event` stays as Zoom sent it (top-level).
      }

      if (integration === 'fireflies') {
        envelope = normalizeFirefliesEnvelope(envelope);
      }

      if (typeof envelope.integration !== 'string' || envelope.integration !== integration) {
        jsonResponse(response, 400, { error: 'integration_mismatch', tier: 'payload' });
        return;
      }
      if (typeof envelope.event !== 'string' || envelope.event.trim() === '') {
        jsonResponse(response, 400, { error: 'invalid_event', tier: 'payload' });
        return;
      }

      if (useZoomHmac) {
        // Meeting filter — 200 (not a retry-triggering error) on noise.
        if (envelope.event !== 'meeting.registration_created' || String(envelope.meeting_id) !== ZOOM_OFFICEHOURS_MEETING_ID) {
          jsonResponse(response, 200, { ok: true, ignored: true, event: envelope.event, meeting_id: envelope.meeting_id ?? null });
          appendZoomLog({ type: 'ignored', event: String(envelope.event) });
          return;
        }
        const rawReg = envelope.registrant;
        if (!rawReg || typeof rawReg !== 'object') {
          jsonResponse(response, 400, { error: 'invalid_registrant', tier: 'payload' });
          return;
        }
        const reg = rawReg as Record<string, unknown>;
        const registrant: ZoomRegistrant = {
          email: typeof reg.email === 'string' ? reg.email : '',
          firstName: typeof reg.first_name === 'string' ? reg.first_name : '',
          lastName: typeof reg.last_name === 'string' ? reg.last_name : '',
          name: '',
        };
        registrant.name = `${registrant.firstName} ${registrant.lastName}`.trim();

        let result;
        try {
          result = processRegistrant({
            contactsPath: zoomContactsPath as string,
            suppressionPath: zoomSuppressionPath as string,
            registrant,
          });
        } catch {
          jsonResponse(response, 500, { error: 'crm_unavailable', tier: 'crm' });
          appendZoomLog({ type: 'error', tier: 'crm', email: registrant.email });
          return;
        }

        if (result.tier === 'AMBIG') {
          const explicitZoomTarget = typeof envelope.target === 'string' ? envelope.target.trim() : '';
          const targetAgent = explicitZoomTarget !== '' ? explicitZoomTarget : 'crm';
          if (!isKnownAgent(targetAgent, options.ctxRoot, options.frameworkRoot, options.org)) {
            jsonResponse(response, 404, { error: 'unknown_agent', tier: 'target' });
            return;
          }
          const reviewText = `WEBHOOK zoom-officehours meeting.registration_created — AMBIG registrant ${registrant.name} ${registrant.email} for meeting ${ZOOM_OFFICEHOURS_MEETING_ID}. Candidates: ${(result.candidateIds ?? []).join(', ')}. Do not auto-write; review and merge manually per crm/zoom-officehours-sync.py rules.`;
          const messageId = sendMessage(
            resolveBusPaths(options.ctxRoot, targetAgent, options.instanceId || 'default', options.org),
            SOURCE_NAME,
            targetAgent,
            'normal',
            reviewText,
          );
          wakeFastChecker(options.ctxRoot, targetAgent);
          appendInboundLog(options.ctxRoot, targetAgent, messageId, reviewText);
          jsonResponse(response, 200, { ok: true, tier: 'AMBIG', messageId });
          appendZoomLog({ type: 'processed', tier: 'AMBIG', email: registrant.email });
          return;
        }

        // NOISE / SUPPRESSED / EMAIL / NAME / NEW — no bus message.
        jsonResponse(response, 200, { ok: true, tier: result.tier, ...(result.contactId ? { contactId: result.contactId } : {}) });
        appendZoomLog({ type: 'processed', tier: result.tier, email: registrant.email, ...(result.contactId ? { contactId: result.contactId } : {}) });

        // Mailchimp mirror fires AFTER the response (fire-and-forget, master-plan D4).
        if (result.mailchimpEligible && options.mailchimpApiKey) {
          const fetchImpl = options.fetchImpl ?? globalThis.fetch;
          void mirrorToMailchimp({
            apiKey: options.mailchimpApiKey,
            listId: ZOOM_MAILCHIMP_LIST_ID,
            email: registrant.email,
            tags: result.tags,
            fetchImpl,
          })
            .then((outcome) => appendZoomLog({ type: 'mailchimp', email: registrant.email, outcome: outcome.outcome, detail: outcome.detail }))
            .catch((err) => appendZoomLog({ type: 'mailchimp', email: registrant.email, outcome: 'error', detail: err instanceof Error ? err.message : String(err) }));
        } else if (result.mailchimpEligible) {
          appendZoomLog({ type: 'mailchimp', email: registrant.email, outcome: 'skipped_no_key' });
        }
        return;
      }
      const explicitTarget = typeof envelope.target === 'string' ? envelope.target.trim() : null;
      const target = explicitTarget && explicitTarget !== ''
        ? explicitTarget
        : integration === 'fireflies' && (envelope.target === undefined || explicitTarget === '')
          ? 'pa'
          : null;

      if (target === null) {
        jsonResponse(response, 400, { error: 'invalid_target', tier: 'payload' });
        return;
      }
      if (!isKnownAgent(target, options.ctxRoot, options.frameworkRoot, options.org)) {
        jsonResponse(response, 404, { error: 'unknown_agent', tier: 'target' });
        return;
      }

      // Deterministic path: for a fireflies meeting event, spawn the writeback
      // worker directly via the daemon rather than posting an NL nudge that depends
      // on the long-running agent noticing and acting. Falls through to the NL relay
      // below if the daemon spawn cannot be reached (no regression).
      const meetingId = extractMeetingId(envelope);
      let relayTarget = target;
      if (integration === 'fireflies' && meetingId) {
        const spawnTarget = resolveActiveTarget(target, options.ctxRoot, options.frameworkRoot, options.org);
        relayTarget = spawnTarget;
        const spawned = await trySpawnMeetingWriteback({
          instanceId: options.instanceId,
          frameworkRoot: options.frameworkRoot,
          org: options.org,
          target: spawnTarget,
          meetingId,
        });
        if (spawned.ok) {
          wakeFastChecker(options.ctxRoot, spawnTarget);
          appendInboundLog(
            options.ctxRoot,
            spawnTarget,
            spawned.workerName,
            `SPAWN meeting-writeback ${spawned.workerName} FF_MEETING_ID=${meetingId}`,
          );
          jsonResponse(response, 200, { ok: true, worker: spawned.workerName });
          return;
        }
        // else: fall through to the NL relay below.
      }

      const text = buildRelayMessage(integration, envelope.event.trim(), envelope, relayTarget);
      const messageId = sendMessage(
        resolveBusPaths(options.ctxRoot, relayTarget, options.instanceId || 'default', options.org),
        SOURCE_NAME,
        relayTarget,
        'normal',
        text,
      );

      wakeFastChecker(options.ctxRoot, relayTarget);
      appendInboundLog(options.ctxRoot, relayTarget, messageId, text);
      jsonResponse(response, 200, { ok: true, messageId });
    } catch {
      jsonResponse(response, 500, { error: 'relay_failed' });
    }
  });
}

type StartOptions = {
  instance?: string;
  org?: string;
  port: string;
};

type RunOptions = StartOptions;

const startCommand = new Command('start')
  .option('--instance <id>', 'Instance ID')
  .option('--org <id>', 'Organization ID (required when the framework contains multiple orgs)')
  .option('--port <port>', 'Webhook bridge port', String(DEFAULT_PORT))
  .description('Start the webhook bridge as a launchd service')
  .addHelpText(
    'after',
    '\nWEBHOOK_BRIDGE_SECRET is loaded at start time from process env, .cortextos-env, or orgs/<org>/secrets.env. FIREFLIES_WEBHOOK_SECRET is optional, loaded the same way, and only affects the fireflies integration. ZOOM_WEBHOOK_SECRET_TOKEN (loaded the same way) turns /relay/zoom-officehours into a real Zoom webhook receiver (CRC + x-zm-signature); MAILCHIMP_API_KEY additionally enables the Mailchimp mirror.',
  )
  .action(async (options: StartOptions) => {
    try {
      checkPlatform();
      const instanceId = resolveInstanceId(options.instance);
      const port = parsePort(options.port, '--port');
      const context = resolveBridgeRuntimeContext(instanceId, options.org);

      console.log('\ncortextOS Webhook Bridge\n');
      writePlist(context, port);
      console.log(`  Plist: ${PLIST_PATH}`);

      if (isServiceLoaded()) {
        console.log('  Service: already running — reloading');
      }
      loadService();
      writeBridgeConfig(instanceId, {
        port,
        createdAt: new Date().toISOString(),
      });

      console.log('  Service: loaded (auto-starts on login)');
      console.log(`  Health: http://${DEFAULT_HOST}:${port}/healthz\n`);
    } catch (error) {
      console.error(`  webhook-bridge start failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

const stopCommand = new Command('stop')
  .description('Stop the webhook bridge launchd service')
  .action(async () => {
    checkPlatform();

    if (!existsSync(PLIST_PATH)) {
      console.log('  Webhook bridge service is not installed. Run: cortextos webhook-bridge start');
      return;
    }

    if (!isServiceLoaded()) {
      console.log('  Webhook bridge service is not running.');
      return;
    }

    unloadService();
    console.log('  Webhook bridge service stopped.');
  });

const statusCommand = new Command('status')
  .option('--instance <id>', 'Instance ID')
  .description('Show webhook bridge launchd and local health status')
  .action(async (options: { instance?: string }) => {
    try {
      checkPlatform();
      const instanceId = resolveInstanceId(options.instance);
      const config = readBridgeConfig(instanceId);
      const port = config.port ?? DEFAULT_PORT;

      console.log('\ncortextOS Webhook Bridge Status\n');
      console.log(`  Service (launchd): ${isServiceLoaded() ? 'running' : 'stopped'}`);
      try {
        const health = execSync(`curl -sf http://${DEFAULT_HOST}:${port}/healthz`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 3000,
        }).trim();
        console.log(`  Health: ${health}`);
      } catch {
        console.log(`  Health: unavailable at http://${DEFAULT_HOST}:${port}/healthz`);
      }
      if (config.createdAt) {
        console.log(`  Config written: ${new Date(config.createdAt).toLocaleString()}`);
      }
      console.log('');
    } catch (error) {
      console.error(`  webhook-bridge status failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

const runCommand = new Command('run')
  .option('--instance <id>', 'Instance ID')
  .option('--org <id>', 'Organization ID (required when the framework contains multiple orgs)')
  .option('--port <port>', 'Webhook bridge port', String(DEFAULT_PORT))
  .description('Run the webhook bridge in the foreground')
  .addHelpText(
    'after',
    '\nWEBHOOK_BRIDGE_SECRET is loaded at run time from process env, .cortextos-env, or orgs/<org>/secrets.env. FIREFLIES_WEBHOOK_SECRET is optional, loaded the same way, and only affects the fireflies integration. ZOOM_WEBHOOK_SECRET_TOKEN (loaded the same way) turns /relay/zoom-officehours into a real Zoom webhook receiver (CRC + x-zm-signature); MAILCHIMP_API_KEY additionally enables the Mailchimp mirror.',
  )
  .action(async (options: RunOptions) => {
    try {
      const instanceId = resolveInstanceId(options.instance);
      const port = parsePort(options.port, '--port');
      const context = resolveBridgeRuntimeContext(instanceId, options.org);
      const server = createBridgeServer({
        instanceId,
        ctxRoot: context.ctxRoot,
        frameworkRoot: context.frameworkRoot,
        org: context.org,
        bridgeSecret: context.bridgeSecret,
        firefliesWebhookSecret: context.firefliesWebhookSecret,
        zoomWebhookSecretToken: context.zoomWebhookSecretToken,
        mailchimpApiKey: context.mailchimpApiKey,
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, DEFAULT_HOST, () => resolve());
      });

      const address = server.address();
      const printable = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${DEFAULT_HOST}:${port}`;
      console.log(`webhook-bridge listening on http://${printable}`);
    } catch (error) {
      console.error(`  webhook-bridge run failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

export const webhookBridgeCommand = new Command('webhook-bridge')
  .description('Manage the local webhook relay bridge for verified external events')
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(statusCommand)
  .addCommand(runCommand);
