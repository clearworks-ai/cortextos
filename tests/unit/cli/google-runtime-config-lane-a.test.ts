import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWebhookBridgeLaunchdEnvironment,
  buildWebhookBridgePlist,
  resolveBridgeRuntimeContext,
} from '../../../src/cli/webhook-bridge';

const ENV_KEYS = [
  'CTX_FRAMEWORK_ROOT',
  'CTX_PROJECT_ROOT',
  'CTX_ROOT',
  'CTX_ORG',
  'WEBHOOK_BRIDGE_SECRET',
  'GOOGLE_PROVIDER_SHADOW_ENABLED',
  'GMAIL_PUSH_AUDIENCE',
  'GMAIL_PUSH_SERVICE_ACCOUNT',
  'GMAIL_PUSH_SUBSCRIPTION',
  'CALENDAR_WATCH_SHADOW_ENABLED',
] as const;
const saved = new Map<string, string | undefined>();
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'google-runtime-config-lane-a-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cortextos' }));
  mkdirSync(join(root, 'orgs', 'clearworksai'), { recursive: true });
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, {
    CTX_FRAMEWORK_ROOT: root,
    CTX_PROJECT_ROOT: root,
    CTX_ROOT: root,
    CTX_ORG: 'clearworksai',
    WEBHOOK_BRIDGE_SECRET: 'bridge-test-secret',
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  rmSync(root, { recursive: true, force: true });
});

function validGoogleEnv(): void {
  Object.assign(process.env, {
    GOOGLE_PROVIDER_SHADOW_ENABLED: 'true',
    GMAIL_PUSH_AUDIENCE: 'https://hooks.clearworks.ai/relay/gmail-pubsub',
    GMAIL_PUSH_SERVICE_ACCOUNT: 'gws-agent@cortextos-gws-495505.iam.gserviceaccount.com',
    GMAIL_PUSH_SUBSCRIPTION: 'projects/cortextos-gws-495505/subscriptions/cortextos-gmail-push-bridge',
  });
}

function replaceProviderProcessEnv(environment: Record<string, string>): void {
  for (const key of ENV_KEYS) {
    if (key.startsWith('GOOGLE_') || key.startsWith('GMAIL_') || key.startsWith('CALENDAR_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith('GOOGLE_') || key.startsWith('GMAIL_') || key.startsWith('CALENDAR_')) process.env[key] = value;
  }
}

describe('Google runtime config lane A', () => {
  it('keeps both providers disabled without constructing runtime options', () => {
    const context = resolveBridgeRuntimeContext('test');
    expect(context.gmailShadow).toBeUndefined();
    expect(context.calendarShadow).toBeUndefined();
  });

  it('wires the frozen Gmail configuration and a production verifier without a provider call', () => {
    validGoogleEnv();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('must remain lazy'); }) as typeof fetch;
    try {
      const context = resolveBridgeRuntimeContext('test');
      expect(context.gmailShadow).toMatchObject({
        audience: 'https://hooks.clearworks.ai/relay/gmail-pubsub',
        serviceAccount: 'gws-agent@cortextos-gws-495505.iam.gserviceaccount.com',
        subscription: 'projects/cortextos-gws-495505/subscriptions/cortextos-gmail-push-bridge',
        verifyOidc: expect.any(Function),
      });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ['empty audience', 'GMAIL_PUSH_AUDIENCE', ''],
    ['non-HTTPS audience', 'GMAIL_PUSH_AUDIENCE', 'http://hooks.clearworks.ai/relay/gmail-pubsub'],
    ['wrong host', 'GMAIL_PUSH_AUDIENCE', 'https://example.invalid/relay/gmail-pubsub'],
    ['wrong path', 'GMAIL_PUSH_AUDIENCE', 'https://hooks.clearworks.ai/relay/wrong'],
    ['wrong service account', 'GMAIL_PUSH_SERVICE_ACCOUNT', 'other@example.invalid'],
    ['wrong project', 'GMAIL_PUSH_SUBSCRIPTION', 'projects/wrong/subscriptions/cortextos-gmail-push-bridge'],
    ['short subscription', 'GMAIL_PUSH_SUBSCRIPTION', 'cortextos-gmail-push-bridge'],
  ])('fails startup with one redacted code for %s', (_name, key, value) => {
    validGoogleEnv();
    process.env[key] = value;
    expect(() => resolveBridgeRuntimeContext('test')).toThrowError(/^google_provider_shadow_config_invalid$/);
  });

  it('rejects invalid feature flags with the same redacted configuration code', () => {
    process.env.GOOGLE_PROVIDER_SHADOW_ENABLED = 'yes';
    expect(() => resolveBridgeRuntimeContext('test')).toThrowError(/^google_provider_shadow_config_invalid$/);
    delete process.env.GOOGLE_PROVIDER_SHADOW_ENABLED;
    process.env.CALENDAR_WATCH_SHADOW_ENABLED = '';
    expect(() => resolveBridgeRuntimeContext('test')).toThrowError(/^google_provider_shadow_config_invalid$/);
  });

  it('enables Calendar validation independently without initializing Gmail', () => {
    process.env.CALENDAR_WATCH_SHADOW_ENABLED = 'true';
    const context = resolveBridgeRuntimeContext('test');
    expect(context.calendarShadow).toEqual({});
    expect(context.gmailShadow).toBeUndefined();
  });

  it('uses process environment ahead of framework files, including explicit empty values', () => {
    writeFileSync(join(root, '.cortextos-env'), [
      'GOOGLE_PROVIDER_SHADOW_ENABLED=true',
      'GMAIL_PUSH_AUDIENCE=https://hooks.clearworks.ai/relay/gmail-pubsub',
      'GMAIL_PUSH_SERVICE_ACCOUNT=gws-agent@cortextos-gws-495505.iam.gserviceaccount.com',
      'GMAIL_PUSH_SUBSCRIPTION=projects/cortextos-gws-495505/subscriptions/cortextos-gmail-push-bridge',
    ].join('\n'));
    process.env.GMAIL_PUSH_AUDIENCE = '';
    expect(() => resolveBridgeRuntimeContext('test')).toThrowError(/^google_provider_shadow_config_invalid$/);
  });

  it('persists validated enabled values into launchd and replays them at run time', () => {
    writeFileSync(join(root, '.env'), 'GOOGLE_PROVIDER_SHADOW_ENABLED=false\nCALENDAR_WATCH_SHADOW_ENABLED=false\n');
    validGoogleEnv();
    process.env.CALENDAR_WATCH_SHADOW_ENABLED = 'true';
    const startContext = resolveBridgeRuntimeContext('test');
    const launched = buildWebhookBridgeLaunchdEnvironment(startContext);
    const plist = buildWebhookBridgePlist(startContext, 20242);

    expect(launched).toMatchObject({
      GOOGLE_PROVIDER_SHADOW_ENABLED: 'true',
      GMAIL_PUSH_AUDIENCE: 'https://hooks.clearworks.ai/relay/gmail-pubsub',
      GMAIL_PUSH_SERVICE_ACCOUNT: 'gws-agent@cortextos-gws-495505.iam.gserviceaccount.com',
      GMAIL_PUSH_SUBSCRIPTION: 'projects/cortextos-gws-495505/subscriptions/cortextos-gmail-push-bridge',
      CALENDAR_WATCH_SHADOW_ENABLED: 'true',
    });
    for (const [key, value] of Object.entries(launched).filter(([key]) => /^(?:GOOGLE|GMAIL|CALENDAR)_/.test(key))) {
      expect(plist).toContain(`<key>${key}</key>\n        <string>${value}</string>`);
    }

    replaceProviderProcessEnv(launched);
    const runContext = resolveBridgeRuntimeContext('test');
    expect(runContext.gmailShadow).toMatchObject({
      audience: launched.GMAIL_PUSH_AUDIENCE,
      serviceAccount: launched.GMAIL_PUSH_SERVICE_ACCOUNT,
      subscription: launched.GMAIL_PUSH_SUBSCRIPTION,
      verifyOidc: expect.any(Function),
    });
    expect(runContext.calendarShadow).toEqual({});
  });

  it('persists explicit disabled flags so later file changes cannot activate providers', () => {
    const startContext = resolveBridgeRuntimeContext('test');
    const launched = buildWebhookBridgeLaunchdEnvironment(startContext);
    const plist = buildWebhookBridgePlist(startContext, 20242);
    expect(launched.GOOGLE_PROVIDER_SHADOW_ENABLED).toBe('false');
    expect(launched.CALENDAR_WATCH_SHADOW_ENABLED).toBe('false');
    expect(launched).not.toHaveProperty('GMAIL_PUSH_AUDIENCE');
    expect(plist).toContain('<key>GOOGLE_PROVIDER_SHADOW_ENABLED</key>\n        <string>false</string>');
    expect(plist).toContain('<key>CALENDAR_WATCH_SHADOW_ENABLED</key>\n        <string>false</string>');
    expect(plist).not.toContain('<key>GMAIL_PUSH_AUDIENCE</key>');

    writeFileSync(join(root, '.env'), [
      'GOOGLE_PROVIDER_SHADOW_ENABLED=true',
      'GMAIL_PUSH_AUDIENCE=https://hooks.clearworks.ai/relay/gmail-pubsub',
      'GMAIL_PUSH_SERVICE_ACCOUNT=gws-agent@cortextos-gws-495505.iam.gserviceaccount.com',
      'GMAIL_PUSH_SUBSCRIPTION=projects/cortextos-gws-495505/subscriptions/cortextos-gmail-push-bridge',
      'CALENDAR_WATCH_SHADOW_ENABLED=true',
    ].join('\n'));
    replaceProviderProcessEnv(launched);
    const runContext = resolveBridgeRuntimeContext('test');
    expect(runContext.gmailShadow).toBeUndefined();
    expect(runContext.calendarShadow).toBeUndefined();
  });
});
