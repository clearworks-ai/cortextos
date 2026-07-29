import { execFileSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, basename, resolve as resolvePath, sep } from 'path';
import { homedir } from 'os';
import type { CtxEnv } from '../types/index.js';
import { ensureDir } from './atomic.js';
import { validateAgentName, validateOrgName } from './validate.js';
import { stripBom } from './strip-bom.js';

/** A value is a 1Password secret reference iff it starts with op:// */
const OP_REF_PATTERN = /^op:\/\//;

/** Per-process cache: op:// ref string -> resolved secret value. */
const opRefCache = new Map<string, string>();

/** One-shot flag so the no-token warning fires once per process, not per key/file. */
let warnedNoOpToken = false;

/**
 * Resolve the cortextOS environment context.
 * Equivalent of bash _ctx-env.sh - reads from env vars, .cortextos-env, .env files.
 */
export function resolveEnv(overrides?: Partial<CtxEnv>): CtxEnv {
  // Priority: overrides > env vars > .cortextos-env file > defaults

  // Try reading .cortextos-env from cwd
  let envFile: Record<string, string> = {};
  const cortextosEnvPath = join(process.cwd(), '.cortextos-env');
  if (existsSync(cortextosEnvPath)) {
    envFile = parseEnvFile(cortextosEnvPath);
  }

  const instanceId =
    overrides?.instanceId ||
    process.env.CTX_INSTANCE_ID ||
    envFile.CTX_INSTANCE_ID ||
    'default';

  const ctxRoot =
    overrides?.ctxRoot ||
    process.env.CTX_ROOT ||
    envFile.CTX_ROOT ||
    join(homedir(), '.cortextos', instanceId);

  const frameworkRoot =
    overrides?.frameworkRoot ||
    process.env.CTX_FRAMEWORK_ROOT ||
    envFile.CTX_FRAMEWORK_ROOT ||
    '';

  const agentName =
    overrides?.agentName ||
    process.env.CTX_AGENT_NAME ||
    envFile.CTX_AGENT_NAME ||
    basename(process.cwd());

  const org =
    overrides?.org ||
    process.env.CTX_ORG ||
    envFile.CTX_ORG ||
    '';

  const projectRoot =
    overrides?.projectRoot ||
    process.env.CTX_PROJECT_ROOT ||
    envFile.CTX_PROJECT_ROOT ||
    '';

  // Resolve agent directory
  let agentDir =
    overrides?.agentDir ||
    process.env.CTX_AGENT_DIR ||
    envFile.CTX_AGENT_DIR ||
    '';

  if (!agentDir && org && projectRoot) {
    agentDir = join(projectRoot, 'orgs', org, 'agents', agentName);
  } else if (!agentDir && projectRoot) {
    agentDir = join(projectRoot, 'agents', agentName);
  }

  // Resolve timezone and orchestrator from org context.json
  let timezone = overrides?.timezone || process.env.CTX_TIMEZONE || '';
  let orchestrator = overrides?.orchestrator || process.env.CTX_ORCHESTRATOR || '';

  if ((!timezone || !orchestrator) && org && projectRoot) {
    try {
      const contextPath = join(projectRoot, 'orgs', org, 'context.json');
      if (existsSync(contextPath)) {
        // stripBom: PowerShell/Notepad-saved context.json files have a BOM
        // that breaks JSON.parse at position 0 — silent fallback to wrong
        // timezone/orchestrator. See src/utils/strip-bom.ts for incident.
        const ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
        if (!timezone && ctx.timezone) timezone = ctx.timezone;
        if (!orchestrator && ctx.orchestrator) orchestrator = ctx.orchestrator;
      }
    } catch { /* ignore */ }
  }

  // Sandbox/live isolation (issue #313): when both CTX_FRAMEWORK_ROOT and CTX_AGENT_DIR
  // are set, the resolved agentDir MUST be subordinate to frameworkRoot. Catches the leak
  // class where a CLI subprocess inherits CTX_AGENT_DIR (or CTX_PROJECT_ROOT) from a live
  // agent shell while only CTX_FRAMEWORK_ROOT was overridden — agentDir then silently
  // points at the live install. Equality check on projectRoot vs frameworkRoot catches
  // the same divergence on the projectRoot axis.
  if (agentDir && frameworkRoot) {
    const fwRootResolved = resolvePath(frameworkRoot);
    const agentDirResolved = resolvePath(agentDir);
    if (agentDirResolved !== fwRootResolved && !agentDirResolved.startsWith(fwRootResolved + sep)) {
      throw new Error(
        `Resolved CTX_AGENT_DIR '${agentDir}' is not under CTX_FRAMEWORK_ROOT '${frameworkRoot}'. ` +
        `This indicates a sandbox/live environment leak — likely CTX_FRAMEWORK_ROOT was overridden ` +
        `but CTX_AGENT_DIR or CTX_PROJECT_ROOT was inherited from the parent shell. ` +
        `Refusing to proceed.`,
      );
    }
  }
  if (projectRoot && frameworkRoot && resolvePath(projectRoot) !== resolvePath(frameworkRoot)) {
    throw new Error(
      `CTX_PROJECT_ROOT '${projectRoot}' must equal CTX_FRAMEWORK_ROOT '${frameworkRoot}'. ` +
      `A divergence indicates a sandbox/live environment leak — likely one of the two was ` +
      `inherited from the parent shell while the other was overridden. Refusing to proceed.`,
    );
  }

  // Security (H9): Validate agent name and org before they flow into filesystem paths.
  // These come from env vars / .cortextos-env and must match [a-z0-9_-]+.
  if (agentName) {
    try {
      validateAgentName(agentName);
    } catch (err) {
      throw new Error(`CTX_AGENT_NAME is invalid: ${(err as Error).message}`);
    }
  }
  if (org) {
    // Org names from the env may use mixed-case (e.g. AcmeCorp) when the
    // org directory was created before strict lowercase validation was enforced.
    // Only reject values that contain path-traversal characters or whitespace;
    // lowercase enforcement is a CLI-layer concern, not an env-resolution concern.
    if (/[./\\<>|;'"(){}[\] ]/.test(org) || org.includes('..')) {
      throw new Error(`CTX_ORG is invalid: contains unsafe characters`);
    }
  }

  return { instanceId, ctxRoot, frameworkRoot, agentName, agentDir, org, projectRoot, timezone, orchestrator };
}

/**
 * Resolve another agent's directory from the caller's environment.
 *
 * Commands that take a target agent argument (e.g. manage-cycle) must
 * operate on the TARGET agent's files, not the caller's — writing to the
 * caller's dir creates a second, diverging registry the target never reads
 * (manage-cycle create was a silent no-op for autoresearch). Targets
 * are resolved as a sibling of the caller's agentDir first (matches every
 * deployment layout), then via the same projectRoot conventions resolveEnv
 * uses. Returns null when no candidate directory exists on disk, so callers
 * can fail loudly instead of writing into a directory no agent reads.
 * Throws on invalid agent names (path-traversal guard).
 */
export function resolveTargetAgentDir(env: CtxEnv, targetAgent: string): string | null {
  validateAgentName(targetAgent);
  if (targetAgent === env.agentName && env.agentDir) {
    return env.agentDir;
  }
  const candidates: string[] = [];
  if (env.agentDir) {
    candidates.push(join(env.agentDir, '..', targetAgent));
  }
  if (env.projectRoot && env.org) {
    candidates.push(join(env.projectRoot, 'orgs', env.org, 'agents', targetAgent));
  }
  if (env.projectRoot) {
    candidates.push(join(env.projectRoot, 'agents', targetAgent));
  }
  for (const candidate of candidates) {
    const dir = resolvePath(candidate);
    if (existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Write .cortextos-env file for backward compatibility with bash bus scripts.
 * Per D6: maintain this pattern.
 */
export function writeCortextosEnv(agentDir: string, env: CtxEnv): void {
  ensureDir(agentDir);
  const content = [
    `CTX_INSTANCE_ID=${env.instanceId}`,
    `CTX_ROOT=${env.ctxRoot}`,
    `CTX_FRAMEWORK_ROOT=${env.frameworkRoot}`,
    `CTX_AGENT_NAME=${env.agentName}`,
    `CTX_ORG=${env.org}`,
    `CTX_AGENT_DIR=${env.agentDir}`,
    `CTX_PROJECT_ROOT=${env.projectRoot}`,
  ].join('\n');

  writeFileSync(join(agentDir, '.cortextos-env'), content + '\n', 'utf-8');
}

/**
 * Parse a KEY=VALUE env file. Supports:
 *   - `#` comments at start of line
 *   - Surrounding single or double quotes on the value (stripped)
 *   - Inline ` #` comments on unquoted values
 * Lines with no `=` are skipped.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    // stripBom + CRLF-aware split: Windows tooling (PowerShell Out-File,
    // Notepad) writes .env files with a UTF-8 BOM at position 0 AND CRLF
    // line endings. Without stripBom the first KEY line never matches
    // because position 0 is the BOM byte; without the regex split, each
    // value gets a trailing \r that breaks downstream validators.
    const content = stripBom(readFileSync(filePath, 'utf-8'));
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue; // no '=' or empty key

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      } else {
        // Unquoted: strip inline comments starting with ' #'
        const hashIdx = value.indexOf(' #');
        if (hashIdx >= 0) {
          value = value.slice(0, hashIdx).trim();
        }
      }

      result[key] = value;
    }
  } catch {
    // Ignore read errors
  }
  return result;
}

/**
 * Source a .env file into process.env (for agent environment).
 */
export function sourceEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const vars = resolveOpRefs(parseEnvFile(filePath));
  for (const [key, value] of Object.entries(vars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// --- 1Password op:// secret reference resolution (fork product feature) ---
// Agent .env / org secrets.env may store `KEY=op://vault/item/field` references
// instead of raw secrets. These are resolved at load time via the `op` CLI using
// OP_SERVICE_ACCOUNT_TOKEN, cached per-process. Preserved across the upstream
// re-baseline: dropping it would break headless 1Password secret loading.

export function isOpRef(value: string): boolean {
  return OP_REF_PATTERN.test(value);
}

function getUsableOpToken(env: Record<string, string>): string | null {
  const localToken = env['OP_SERVICE_ACCOUNT_TOKEN'];
  if (localToken && !isOpRef(localToken)) {
    return localToken;
  }

  const processToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (processToken && !isOpRef(processToken)) {
    return processToken;
  }

  return null;
}

function resolveViaOpInject(refsByKey: ReadonlyMap<string, string>, token: string): Map<string, string> {
  const template = Array.from(refsByKey.entries())
    .map(([key, ref]) => `${key}=${ref}`)
    .join('\n') + '\n';

  const stdout = execFileSync('op', ['inject'], {
    input: template,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
  });

  const resolved = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1);
    if (!key || !refsByKey.has(key) || isOpRef(value)) continue;

    resolved.set(key, value);
  }

  return resolved;
}

function resolveViaOpRead(ref: string, token: string): string | null {
  try {
    const out = execFileSync('op', ['read', ref], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
    });
    return out.replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

export function resolveOpRefs(env: Record<string, string>): Record<string, string> {
  const resolvedEnv = { ...env };
  const refEntries = Object.entries(env).filter(([, value]) => isOpRef(value));

  if (refEntries.length === 0) {
    return resolvedEnv;
  }

  const unresolvedByKey = new Map<string, string>();
  for (const [key, ref] of refEntries) {
    const cached = opRefCache.get(ref);
    if (cached !== undefined) {
      resolvedEnv[key] = cached;
    } else {
      unresolvedByKey.set(key, ref);
    }
  }

  if (unresolvedByKey.size === 0) {
    return resolvedEnv;
  }

  const token = getUsableOpToken(env);
  if (!token) {
    if (!warnedNoOpToken) {
      const keys = Array.from(unresolvedByKey.keys());
      console.warn(
        `[env] ${keys.length} op:// secret reference(s) left unresolved (OP_SERVICE_ACCOUNT_TOKEN not set): ${keys.join(', ')}`,
      );
      warnedNoOpToken = true;
    }
    return resolvedEnv;
  }

  let usedOpReadFallback = false;
  try {
    const injected = resolveViaOpInject(unresolvedByKey, token);
    for (const [key, ref] of unresolvedByKey.entries()) {
      const value = injected.get(key);
      if (value === undefined) {
        console.warn(`[env] failed to resolve op:// secret reference for ${key}`);
        continue;
      }
      resolvedEnv[key] = value;
      opRefCache.set(ref, value);
    }
    return resolvedEnv;
  } catch {
    console.warn('[env] op inject unavailable, falling back to per-key op read');
    usedOpReadFallback = true;
  }

  if (usedOpReadFallback) {
    for (const [key, ref] of unresolvedByKey.entries()) {
      const value = resolveViaOpRead(ref, token);
      if (value === null) {
        console.warn(`[env] failed to resolve op:// secret reference for ${key}`);
        continue;
      }
      resolvedEnv[key] = value;
      opRefCache.set(ref, value);
    }
  }

  return resolvedEnv;
}

/**
 * Load an env file into the provided target map with overwrite semantics.
 * Later calls win, which preserves org-first / agent-second precedence in PTY loaders.
 */
export function loadEnvFileInto(filePath: string, target: Record<string, string>): void {
  if (!existsSync(filePath)) return;

  const vars = resolveOpRefs(parseEnvFile(filePath));
  for (const [key, value] of Object.entries(vars)) {
    target[key] = value;
  }
}

export function resetOpRefStateForTest(): void {
  opRefCache.clear();
  warnedNoOpToken = false;
}
