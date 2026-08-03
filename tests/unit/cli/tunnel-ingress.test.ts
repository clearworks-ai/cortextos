import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { buildCloudflaredConfig, isTunnelDeleted, CLOUDFLARED_ZERO_DATE } from '../../../src/cli/tunnel';
import { DEFAULT_PORT } from '../../../src/cli/webhook-bridge';

describe('isTunnelDeleted — cloudflared zero-date sentinel', () => {
  it('treats the Go zero-time sentinel as NOT deleted (a live tunnel)', () => {
    // cloudflared stamps active tunnels with this non-empty string; a plain
    // `!deleted_at` check wrongly read it as truthy and hid every live tunnel.
    expect(isTunnelDeleted(CLOUDFLARED_ZERO_DATE)).toBe(false);
    expect(isTunnelDeleted('0001-01-01T00:00:00Z')).toBe(false);
  });

  it('treats a missing / empty deleted_at as NOT deleted', () => {
    expect(isTunnelDeleted(undefined)).toBe(false);
    expect(isTunnelDeleted('')).toBe(false);
  });

  it('treats a real timestamp as deleted', () => {
    expect(isTunnelDeleted('2026-08-02T12:00:00Z')).toBe(true);
  });
});

describe('tunnel ingress generation', () => {
  const tunnelId = 'abc123';
  const dashboardPort = 3000;
  const bridgePort = 20242;
  const credFile = `${homedir()}/.cloudflared/${tunnelId}.json`;

  it('preserves the exact legacy output when no bridge is configured', () => {
    expect(buildCloudflaredConfig(tunnelId, dashboardPort)).toBe(
      [
        `tunnel: ${tunnelId}`,
        `credentials-file: ${credFile}`,
        'ingress:',
        `  - service: http://localhost:${dashboardPort}`,
        '',
      ].join('\n'),
    );
  });

  it('emits a path-based bridge rule plus dashboard fallback when bridge hostname is absent', () => {
    const config = buildCloudflaredConfig(tunnelId, dashboardPort, { port: bridgePort });
    expect(config).toContain(`credentials-file: ${credFile}`);
    expect(config).toContain('  - path: ^/relay/.*');
    expect(config).toContain(`    service: http://localhost:${bridgePort}`);
    expect(config).toContain(`  - service: http://localhost:${dashboardPort}`);
    expect(config).toContain('  - service: http_status:404');
  });

  it('emits a hostname-specific bridge rule when bridge hostname is configured', () => {
    const config = buildCloudflaredConfig(tunnelId, dashboardPort, {
      port: bridgePort,
      hostname: 'bridge.example.com',
    });
    expect(config).toContain(`credentials-file: ${credFile}`);
    expect(config).toContain('  - hostname: bridge.example.com');
    expect(config).toContain(`    service: http://localhost:${bridgePort}`);
    expect(config).toContain(`  - service: http://localhost:${dashboardPort}`);
    expect(config).toContain('  - service: http_status:404');
  });

  it('always leaves the catch-all rule last when bridge ingress is enabled', () => {
    const lines = buildCloudflaredConfig(tunnelId, dashboardPort, { port: bridgePort }).trimEnd().split('\n');
    expect(lines.at(-1)).toBe('  - service: http_status:404');
  });

  it('orders the relay rule before the dashboard rule before the catch-all', () => {
    const lines = buildCloudflaredConfig(tunnelId, dashboardPort, { port: bridgePort }).split('\n');
    const relayIdx = lines.indexOf('  - path: ^/relay/.*');
    const dashboardIdx = lines.indexOf(`  - service: http://localhost:${dashboardPort}`);
    const catchAllIdx = lines.indexOf('  - service: http_status:404');
    expect(relayIdx).toBeGreaterThanOrEqual(0);
    expect(relayIdx).toBeLessThan(dashboardIdx);
    expect(dashboardIdx).toBeLessThan(catchAllIdx);
  });

  it('wires the webhook-bridge DEFAULT_PORT constant as the single source of truth', () => {
    // Pins the newly-exported constant and guards against port drift between
    // webhook-bridge.ts and tunnel.ts.
    expect(DEFAULT_PORT).toBe(20242);
    const config = buildCloudflaredConfig(tunnelId, dashboardPort, { port: DEFAULT_PORT });
    expect(config).toContain('    service: http://localhost:20242');
  });
});
