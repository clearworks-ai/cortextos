import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { buildCloudflaredConfig } from '../../../src/cli/tunnel';

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
    expect(
      buildCloudflaredConfig(tunnelId, dashboardPort, { port: bridgePort }),
    ).toMatchInlineSnapshot(`
      "tunnel: abc123
      credentials-file: /Users/joshweiss/.cloudflared/abc123.json
      ingress:
        - path: ^/relay/.*
          service: http://localhost:20242
        - service: http://localhost:3000
        - service: http_status:404
      "
    `);
  });

  it('emits a hostname-specific bridge rule when bridge hostname is configured', () => {
    expect(
      buildCloudflaredConfig(tunnelId, dashboardPort, {
        port: bridgePort,
        hostname: 'bridge.example.com',
      }),
    ).toMatchInlineSnapshot(`
      "tunnel: abc123
      credentials-file: /Users/joshweiss/.cloudflared/abc123.json
      ingress:
        - hostname: bridge.example.com
          service: http://localhost:20242
        - service: http://localhost:3000
        - service: http_status:404
      "
    `);
  });

  it('always leaves the catch-all rule last when bridge ingress is enabled', () => {
    const lines = buildCloudflaredConfig(tunnelId, dashboardPort, { port: bridgePort }).trimEnd().split('\n');
    expect(lines.at(-1)).toBe('  - service: http_status:404');
  });
});
