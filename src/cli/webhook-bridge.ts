import { Command } from 'commander';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { homedir } from 'os';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { listAgents } from '../bus/agents.js';
import { sendMessage } from '../bus/message.js';
import { loadEnvFileInto } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import type { BusPaths } from '../types/index.js';
import { resolveInstanceId } from './resolve-instance-id.js';

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
}

export interface BridgeServerOptions {
  instanceId?: string;
  ctxRoot: string;
  frameworkRoot: string;
  org?: string;
  bridgeSecret: string;
  firefliesWebhookSecret?: string;
  allowedIntegrations?: readonly string[];
  now?: () => number;
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

function readFrameworkEnv(frameworkRoot: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (!frameworkRoot) return resolved;
  loadEnvFileInto(join(frameworkRoot, '.cortextos-env'), resolved);
  loadEnvFileInto(join(frameworkRoot, '.env'), resolved);
  const org = process.env.CTX_ORG || resolved.CTX_ORG || '';
  if (org) {
    loadEnvFileInto(join(frameworkRoot, 'orgs', org, 'secrets.env'), resolved);
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

function resolveBridgeRuntimeContext(instanceId: string): BridgeRuntimeContext {
  const frameworkRoot = findFrameworkRoot();
  const envFromFiles = readFrameworkEnv(frameworkRoot);
  const org = process.env.CTX_ORG || envFromFiles.CTX_ORG || '';
  const ctxRoot = process.env.CTX_ROOT || envFromFiles.CTX_ROOT || join(homedir(), '.cortextos', instanceId);
  const bridgeSecret = process.env.WEBHOOK_BRIDGE_SECRET || envFromFiles.WEBHOOK_BRIDGE_SECRET || '';
  const firefliesWebhookSecret = process.env.FIREFLIES_WEBHOOK_SECRET || envFromFiles.FIREFLIES_WEBHOOK_SECRET || undefined;

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

function buildRelayMessage(integration: string, event: string, envelope: RelayEnvelope): string {
  const meetingId = envelope.meeting_id === undefined || envelope.meeting_id === null
    ? ''
    : String(envelope.meeting_id).trim();

  if (integration === 'fireflies' && meetingId) {
    return `WEBHOOK ${integration} ${event} — meeting ${meetingId}. Spawn meeting-commitments-worker with FF_MEETING_ID=${meetingId} set so the single-meeting fast path runs now instead of waiting for the 2h poll: cd pa agent dir, source env, then python3 scripts/ff-extractor.py --mode full --meeting-id ${meetingId}.`;
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

      if (useFirefliesHmac) {
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

      const text = buildRelayMessage(integration, envelope.event.trim(), envelope);
      const messageId = sendMessage(
        resolveBusPaths(options.ctxRoot, target, options.instanceId || 'default', options.org),
        SOURCE_NAME,
        target,
        'normal',
        text,
      );

      wakeFastChecker(options.ctxRoot, target);
      appendInboundLog(options.ctxRoot, target, messageId, text);
      jsonResponse(response, 200, { ok: true, messageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jsonResponse(response, 500, { error: 'relay_failed', details: message });
    }
  });
}

type StartOptions = {
  instance?: string;
  port: string;
};

type RunOptions = StartOptions;

const startCommand = new Command('start')
  .option('--instance <id>', 'Instance ID')
  .option('--port <port>', 'Webhook bridge port', String(DEFAULT_PORT))
  .description('Start the webhook bridge as a launchd service')
  .addHelpText(
    'after',
    '\nWEBHOOK_BRIDGE_SECRET is loaded at start time from process env, .cortextos-env, or orgs/<org>/secrets.env. FIREFLIES_WEBHOOK_SECRET is optional, loaded the same way, and only affects the fireflies integration.',
  )
  .action(async (options: StartOptions) => {
    try {
      checkPlatform();
      const instanceId = resolveInstanceId(options.instance);
      const port = parsePort(options.port, '--port');
      const context = resolveBridgeRuntimeContext(instanceId);

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
  .option('--port <port>', 'Webhook bridge port', String(DEFAULT_PORT))
  .description('Run the webhook bridge in the foreground')
  .addHelpText(
    'after',
    '\nWEBHOOK_BRIDGE_SECRET is loaded at run time from process env, .cortextos-env, or orgs/<org>/secrets.env. FIREFLIES_WEBHOOK_SECRET is optional, loaded the same way, and only affects the fireflies integration.',
  )
  .action(async (options: RunOptions) => {
    try {
      const instanceId = resolveInstanceId(options.instance);
      const port = parsePort(options.port, '--port');
      const context = resolveBridgeRuntimeContext(instanceId);
      const server = createBridgeServer({
        instanceId,
        ctxRoot: context.ctxRoot,
        frameworkRoot: context.frameworkRoot,
        org: context.org,
        bridgeSecret: context.bridgeSecret,
        firefliesWebhookSecret: context.firefliesWebhookSecret,
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
