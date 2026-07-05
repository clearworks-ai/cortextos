import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const routingPolicy = require('../../../.claude/workflows/lib/routing-policy.js') as {
  CURRENT_BEHAVIOR_ROUTING: Record<string, unknown>;
  ROUTING_CONFIG_DEFAULTS: Record<string, unknown>;
  buildAnthropicAgentOptions: (
    base: Record<string, unknown>,
    route: Record<string, unknown>,
  ) => Record<string, unknown>;
  loadRoutingConfig: (configPath: string, options?: Record<string, unknown>) => Record<string, unknown>;
  resolveStageRoute: (
    config: Record<string, unknown>,
    stageName: string,
    options?: Record<string, unknown>,
  ) => Record<string, unknown>;
};

describe('routing-policy', () => {
  it('falls back to current behavior when the routing config file is missing', () => {
    const config = routingPolicy.loadRoutingConfig('.claude/workflows/does-not-exist.json', {
      cwd: '/tmp',
    });

    expect(config).toEqual(routingPolicy.CURRENT_BEHAVIOR_ROUTING);
    expect(config.stages.implement).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'medium',
    });
  });

  it('loads the committed routing defaults from a real config file', () => {
    const root = join(tmpdir(), `routing-policy-${Date.now()}`);
    mkdirSync(join(root, '.claude', 'workflows'), { recursive: true });
    const configPath = join(root, '.claude', 'workflows', 'routing-config.json');
    writeFileSync(
      configPath,
      JSON.stringify(routingPolicy.ROUTING_CONFIG_DEFAULTS, null, 2),
      'utf8',
    );

    const config = routingPolicy.loadRoutingConfig(configPath, { cwd: root });
    expect(config.stages.explore).toEqual({
      provider: 'openrouter',
      model: 'openrouter/google/gemini-3.5-flash',
    });
    expect(config.fableGate).toEqual({ fallback: 'opus' });

    rmSync(root, { recursive: true, force: true });
  });

  it('keeps Fable opt-in and falls plan back to opus by default', () => {
    const route = routingPolicy.resolveStageRoute(routingPolicy.ROUTING_CONFIG_DEFAULTS, 'plan');

    expect(route).toMatchObject({
      provider: 'anthropic',
      model: 'opus',
      confirmationDeclined: true,
      fallback: 'opus',
    });
  });

  it('uses lean fable only when plan confirmation is explicitly granted', () => {
    const config = {
      ...routingPolicy.ROUTING_CONFIG_DEFAULTS,
      stages: {
        ...routingPolicy.ROUTING_CONFIG_DEFAULTS.stages,
        plan: {
          ...routingPolicy.ROUTING_CONFIG_DEFAULTS.stages.plan,
          lean: false,
        },
      },
    };
    const route = routingPolicy.resolveStageRoute(
      config,
      'plan',
      { confirmFableUse: () => true },
    );
    const options = routingPolicy.buildAnthropicAgentOptions({ phase: 'Plan' }, route);

    expect(route).toMatchObject({
      provider: 'anthropic',
      model: 'fable',
      lean: true,
      requiresConfirmation: true,
    });
    expect(options).toMatchObject({
      phase: 'Plan',
      model: 'fable',
      effort: 'high',
      agentType: 'fable-lean',
    });
  });

  it('rejects routing Fable outside the plan stage', () => {
    const badConfig = {
      ...routingPolicy.ROUTING_CONFIG_DEFAULTS,
      stages: {
        ...routingPolicy.ROUTING_CONFIG_DEFAULTS.stages,
        implement: { provider: 'anthropic', model: 'fable', effort: 'medium' },
      },
    };

    expect(() => routingPolicy.resolveStageRoute(badConfig, 'implement')).toThrow(
      'Fable is only allowed at the plan stage',
    );
  });

  it('rejects routing the review stage off Anthropic', () => {
    const badConfig = {
      ...routingPolicy.ROUTING_CONFIG_DEFAULTS,
      stages: {
        ...routingPolicy.ROUTING_CONFIG_DEFAULTS.stages,
        review: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
      },
    };

    expect(() => routingPolicy.resolveStageRoute(badConfig, 'review')).toThrow(
      'Review stage must stay on provider=anthropic',
    );
  });
});
