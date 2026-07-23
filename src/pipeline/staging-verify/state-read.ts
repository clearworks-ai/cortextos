import { resolve } from 'path';
import { RailwayCli } from './railway.js';
import type { AssertionResult, RunContext, Scenario, StageOutcome } from './types.js';
import type { CookieJar, FetchLike } from './drive.js';

export interface ReadStateDeps {
  fetchImpl?: FetchLike;
  jar: CookieJar;
  railway: RailwayCli;
  worktree: string;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function compare(op: 'eq' | 'gte' | 'lte', actual: number | null, expected: number): boolean {
  if (actual === null) return false;
  if (op === 'eq') return actual === expected;
  if (op === 'gte') return actual >= expected;
  return actual <= expected;
}

function transportLike(message: string): boolean {
  return /timed out|econn|network|abort|temporar/i.test(message);
}

function resultDetail(assertion: Scenario['assertions'][number]): string {
  return assertion.source === 'json-api' ? String(assertion.endpoint) : String(assertion.queryScript);
}

async function jsonAssertion(
  ctx: RunContext,
  assertion: Scenario['assertions'][number],
  deps: ReadStateDeps,
): Promise<{ transient?: string; result: AssertionResult }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(assertion.endpoint ?? '', ctx.stagingUrl).toString();
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(deps.jar.headerFor(url) ? { cookie: deps.jar.headerFor(url) } : {}),
      },
    });
    if ([502, 503, 504].includes(response.status)) {
      return {
        transient: `${assertion.name} returned ${response.status}`,
        result: {
          name: assertion.name,
          source: 'json-api',
          expected: assertion.expected,
          actual: null,
          op: assertion.op,
          pass: false,
          detail: resultDetail(assertion),
        },
      };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status !== 200 || !contentType.includes('application/json')) {
      return {
        result: {
          name: assertion.name,
          source: 'json-api',
          expected: assertion.expected,
          actual: null,
          op: assertion.op,
          pass: false,
          detail: resultDetail(assertion),
        },
      };
    }
    const body = await response.json();
    const value = getByPath(body, assertion.jsonPath ?? '');
    const actual = typeof value === 'number' ? value : null;
    return {
      result: {
        name: assertion.name,
        source: 'json-api',
        expected: assertion.expected,
        actual,
        op: assertion.op,
        pass: compare(assertion.op, actual, assertion.expected),
        detail: resultDetail(assertion),
      },
    };
  } catch (error) {
    const detail = toMessage(error);
    return {
      transient: transportLike(detail) ? detail : undefined,
      result: {
        name: assertion.name,
        source: 'json-api',
        expected: assertion.expected,
        actual: null,
        op: assertion.op,
        pass: false,
        detail: resultDetail(assertion),
      },
    };
  }
}

async function dbAssertion(
  ctx: RunContext,
  assertion: Scenario['assertions'][number],
  deps: ReadStateDeps,
): Promise<{ transient?: string; result: AssertionResult }> {
  const script = resolve(deps.worktree, assertion.queryScript ?? '');
  const command = script.endsWith('.py')
    ? ['uv', 'run', 'python', script]
    : ['node', script];
  try {
    const result = await deps.railway.run(deps.worktree, ctx.repo.stagingEnv, command);
    if (result.code !== 0) {
      const detail = result.stderr || result.stdout;
      return {
        transient: transportLike(detail) ? detail : undefined,
        result: {
          name: assertion.name,
          source: 'db',
          expected: assertion.expected,
          actual: null,
          op: assertion.op,
          pass: false,
          detail: resultDetail(assertion),
        },
      };
    }
    const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      return {
        result: {
          name: assertion.name,
          source: 'db',
          expected: assertion.expected,
          actual: null,
          op: assertion.op,
          pass: false,
          detail: `${resultDetail(assertion)} (db query emitted non-JSON terminal line)`,
        },
      };
    }
    const actual = typeof parsed.value === 'number' ? parsed.value : null;
    return {
      result: {
        name: assertion.name,
        source: 'db',
        expected: assertion.expected,
        actual,
        op: assertion.op,
        pass: compare(assertion.op, actual, assertion.expected),
        detail: resultDetail(assertion),
      },
    };
  } catch (error) {
    const detail = toMessage(error);
    return {
      transient: transportLike(detail) ? detail : undefined,
      result: {
        name: assertion.name,
        source: 'db',
        expected: assertion.expected,
        actual: null,
        op: assertion.op,
        pass: false,
        detail: resultDetail(assertion),
      },
    };
  }
}

export async function readEndState(
  ctx: RunContext,
  scenario: Scenario,
  deps: ReadStateDeps,
): Promise<{ outcome: StageOutcome; results: AssertionResult[] }> {
  const results: AssertionResult[] = [];
  for (const assertion of scenario.assertions) {
    const current = assertion.source === 'json-api'
      ? await jsonAssertion(ctx, assertion, deps)
      : await dbAssertion(ctx, assertion, deps);
    results.push(current.result);
    if (current.transient) {
      return {
        outcome: { kind: 'transient', detail: current.transient },
        results,
      };
    }
  }

  const firstFailure = results.find((result) => !result.pass);
  if (firstFailure) {
    return {
      outcome: { kind: 'fatal', detail: `assertion failed: ${firstFailure.name}` },
      results,
    };
  }

  return {
    outcome: { kind: 'ok' },
    results,
  };
}
