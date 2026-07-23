import { existsSync, readFileSync } from 'fs';
import { URLSearchParams } from 'url';
import type {
  AuthStep,
  DriveStep,
  RepoConfig,
  RunContext,
  Scenario,
  StageOutcome,
  StateAssertion,
} from './types.js';

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

interface CookieEntry {
  name: string;
  value: string;
  path: string;
}

export interface DriveState {
  jar: CookieJar;
  captures: Record<string, string>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function isDriveStep(value: unknown): value is DriveStep {
  if (!isObject(value)) return false;
  if (typeof value.name !== 'string' || typeof value.path !== 'string') return false;
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(String(value.method))) return false;
  if (!isNumberArray(value.expectStatus)) return false;
  if (value.contentType !== undefined && value.contentType !== 'application/json' && value.contentType !== 'application/x-www-form-urlencoded') {
    return false;
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) return false;
  if (value.captureJson !== undefined && !isStringRecord(value.captureJson)) return false;
  return true;
}

function isAuthStep(value: unknown): value is AuthStep {
  if (!isObject(value)) return false;
  if (value.kind !== 'form-login' && value.kind !== 'json-login') return false;
  if (typeof value.path !== 'string') return false;
  if (typeof value.usernameEnv !== 'string' || typeof value.passwordEnv !== 'string') return false;
  if (!isStringRecord(value.bodyTemplate)) return false;
  if (!isNumberArray(value.successStatus)) return false;
  return true;
}

function isStateAssertion(value: unknown): value is StateAssertion {
  if (!isObject(value)) return false;
  if (typeof value.name !== 'string') return false;
  if (value.source !== 'json-api' && value.source !== 'db') return false;
  if (value.endpoint !== undefined && typeof value.endpoint !== 'string') return false;
  if (value.jsonPath !== undefined && typeof value.jsonPath !== 'string') return false;
  if (value.queryScript !== undefined && typeof value.queryScript !== 'string') return false;
  if (!['eq', 'gte', 'lte'].includes(String(value.op))) return false;
  return typeof value.expected === 'number';
}

function assertScenario(value: unknown, field = 'scenario'): asserts value is Scenario {
  if (!isObject(value)) throw new Error(`Invalid ${field}`);
  if (typeof value.name !== 'string') throw new Error(`Invalid ${field}.name`);
  if (value.auth !== undefined && !isAuthStep(value.auth)) throw new Error(`Invalid ${field}.auth`);
  if (!Array.isArray(value.steps) || !value.steps.every(isDriveStep)) throw new Error(`Invalid ${field}.steps`);
  if (!Array.isArray(value.assertions) || !value.assertions.every(isStateAssertion)) throw new Error(`Invalid ${field}.assertions`);
}

function scenarioPath(repo: RepoConfig): string {
  return repo.scenarioPath ?? `${repo.localPath}/.staging-verify/scenario.json`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCookies(jar: CookieJar): boolean {
  return jar.size() > 0;
}

function isTransientTransport(message: string): boolean {
  return /econnreset|econnrefused|etimedout|network|abort/i.test(message);
}

function escapeForUrl(value: string): string {
  return encodeURIComponent(value);
}

function getByPath(value: unknown, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = value;
  for (const part of parts) {
    if (part === 'length') {
      if (Array.isArray(cursor) || typeof cursor === 'string') {
        cursor = cursor.length;
        continue;
      }
      return undefined;
    }
    if (!isObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function substituteEnvReference(value: string): string {
  if (!value.startsWith('$ENV:')) return value;
  const key = value.slice('$ENV:'.length);
  const resolved = process.env[key];
  if (!resolved) {
    throw new Error(`Missing environment variable ${key}`);
  }
  return resolved;
}

function substituteString(value: string, state: DriveState): string {
  return value.replace(/\$([A-Za-z0-9_]+)/g, (_match, variable: string) => {
    const captured = state.captures[variable];
    if (captured === undefined) {
      throw new Error(`Missing captured variable ${variable}`);
    }
    return escapeForUrl(captured);
  });
}

function substituteValue(value: unknown, state: DriveState): unknown {
  if (typeof value === 'string') {
    return substituteString(substituteEnvReference(value), state);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substituteValue(entry, state));
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteValue(entry, state)]));
  }
  return value;
}

function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

async function fetchWithRedirects(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  jar: CookieJar,
): Promise<Response> {
  let currentUrl = url;
  let currentInit = { ...init };
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const headers = new Headers(currentInit.headers ?? {});
    const cookie = jar.headerFor(currentUrl);
    if (cookie) headers.set('cookie', cookie);
    currentInit.headers = headers;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(currentUrl, {
        ...currentInit,
        redirect: 'manual',
        signal: controller.signal,
      });
      const cookies = setCookieHeaders(response);
      if (cookies.length > 0) {
        jar.storeFrom(currentUrl, cookies);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return response;
        currentUrl = new URL(location, currentUrl).toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentInit.method === 'POST')) {
          currentInit = {
            ...currentInit,
            method: 'GET',
            body: undefined,
          };
        }
        continue;
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects for ${url}`);
}

function buildBody(step: Pick<DriveStep, 'body' | 'contentType'>, state: DriveState): { body?: string; headers: Record<string, string> } {
  if (step.body === undefined) return { headers: {} };
  const substituted = substituteValue(step.body, state);
  if (step.contentType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(substituted as Record<string, unknown>)) {
      params.set(key, String(value ?? ''));
    }
    return {
      body: params.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
    };
  }
  return {
    body: JSON.stringify(substituted),
    headers: {
      'content-type': 'application/json',
    },
  };
}

async function performAuth(
  ctx: RunContext,
  scenario: Scenario,
  fetchImpl: FetchLike,
  state: DriveState,
): Promise<StageOutcome> {
  const auth = scenario.auth;
  if (!auth) return { kind: 'ok' };

  const username = process.env[auth.usernameEnv];
  const password = process.env[auth.passwordEnv];
  if (!username) return { kind: 'fatal', detail: `Missing environment variable ${auth.usernameEnv}` };
  if (!password) return { kind: 'fatal', detail: `Missing environment variable ${auth.passwordEnv}` };

  const template = Object.fromEntries(
    Object.entries(auth.bodyTemplate).map(([key, value]) => [
      key,
      value.replace(/\$USERNAME/g, username).replace(/\$PASSWORD/g, password),
    ]),
  );

  const { body, headers } = buildBody({
    body: template,
    contentType: auth.kind === 'form-login' ? 'application/x-www-form-urlencoded' : 'application/json',
  }, state);

  try {
    const response = await fetchWithRedirects(new URL(auth.path, ctx.stagingUrl).toString(), {
      method: 'POST',
      body,
      headers,
    }, fetchImpl, state.jar);
    if (!auth.successStatus.includes(response.status)) {
      return { kind: 'fatal', detail: `auth failed with status ${response.status}` };
    }
    if (!hasCookies(state.jar)) {
      return { kind: 'fatal', detail: 'auth produced no session cookie' };
    }
    return { kind: 'ok' };
  } catch (error) {
    const detail = toMessage(error);
    return {
      kind: isTransientTransport(detail) ? 'transient' : 'fatal',
      detail,
    };
  }
}

async function performStep(
  ctx: RunContext,
  step: DriveStep,
  fetchImpl: FetchLike,
  state: DriveState,
): Promise<StageOutcome> {
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      const substitutedPath = substituteString(step.path, state);
      const headers = Object.fromEntries(
        Object.entries(step.headers ?? {}).map(([key, value]) => [key, substituteEnvReference(substituteString(value, state))]),
      );
      const built = buildBody(step, state);
      const response = await fetchWithRedirects(new URL(substitutedPath, ctx.stagingUrl).toString(), {
        method: step.method,
        body: built.body,
        headers: {
          ...headers,
          ...built.headers,
        },
      }, fetchImpl, state.jar);

      if (response.status === 500 && attempt === 1) {
        await sleep(5_000);
        continue;
      }
      if ([502, 503, 504].includes(response.status)) {
        return { kind: 'transient', detail: `${step.name} returned ${response.status}` };
      }
      if (response.status >= 400 && response.status < 500) {
        return { kind: 'fatal', detail: `${step.name} returned ${response.status}` };
      }
      if (response.status === 500) {
        return { kind: 'fatal', detail: `${step.name} returned 500 twice` };
      }
      if (!step.expectStatus.includes(response.status)) {
        return { kind: 'fatal', detail: `${step.name} returned unexpected status ${response.status}` };
      }
      if (!step.captureJson) {
        return { kind: 'ok' };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        return { kind: 'fatal', detail: `${step.name} returned HTML for captureJson` };
      }
      if (!contentType.includes('application/json')) {
        return { kind: 'fatal', detail: `${step.name} returned non-JSON content-type ${contentType}` };
      }
      const body = await response.json();
      for (const [variable, path] of Object.entries(step.captureJson)) {
        const value = getByPath(body, path);
        if (value === undefined || value === null) {
          return { kind: 'fatal', detail: `${step.name} missing capture path ${path}` };
        }
        state.captures[variable] = String(value);
      }
      return { kind: 'ok' };
    } catch (error) {
      const detail = toMessage(error);
      return {
        kind: isTransientTransport(detail) ? 'transient' : 'fatal',
        detail,
      };
    }
  }
  return { kind: 'fatal', detail: `${step.name} failed` };
}

export class CookieJar {
  private readonly entries = new Map<string, CookieEntry>();

  storeFrom(url: string, setCookieHeaders: string[]): void {
    const pathname = new URL(url).pathname || '/';
    for (const header of setCookieHeaders) {
      const parts = header.split(';').map((part) => part.trim()).filter(Boolean);
      const [nameValue, ...attributes] = parts;
      const [name, ...valueParts] = nameValue.split('=');
      if (!name || valueParts.length === 0) continue;
      const value = valueParts.join('=');
      let path = pathname;
      for (const attribute of attributes) {
        const [attrName, attrValue] = attribute.split('=');
        if (attrName.toLowerCase() === 'path' && attrValue) {
          path = attrValue;
        }
      }
      this.entries.set(name, {
        name,
        value,
        path,
      });
    }
  }

  headerFor(url: string): string | undefined {
    const pathname = new URL(url).pathname || '/';
    const pairs = Array.from(this.entries.values())
      .filter((entry) => pathname.startsWith(entry.path))
      .map((entry) => `${entry.name}=${entry.value}`);
    return pairs.length > 0 ? pairs.join('; ') : undefined;
  }

  size(): number {
    return this.entries.size;
  }
}

export function loadScenario(repo: RepoConfig): Scenario {
  const path = scenarioPath(repo);
  if (!existsSync(path)) {
    return {
      name: 'minimal',
      steps: [{
        name: 'health',
        method: 'GET',
        path: repo.healthPath,
        expectStatus: [200],
      }],
      assertions: [],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read scenario file ${path}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Scenario file ${path} is not valid JSON`);
  }
  assertScenario(parsed);
  return parsed;
}

export async function runDrive(
  ctx: RunContext,
  scenario: Scenario,
  fetchImpl: FetchLike = fetch,
  state: DriveState = { jar: new CookieJar(), captures: {} },
): Promise<StageOutcome> {
  if (!ctx.stagingUrl) {
    return { kind: 'fatal', detail: 'deploy stage did not set a staging URL' };
  }

  state.captures = {};
  const authResult = await performAuth(ctx, scenario, fetchImpl, state);
  if (authResult.kind !== 'ok') return authResult;

  for (const step of scenario.steps) {
    const outcome = await performStep(ctx, step, fetchImpl, state);
    if (outcome.kind !== 'ok') {
      return outcome;
    }
  }
  return { kind: 'ok' };
}
