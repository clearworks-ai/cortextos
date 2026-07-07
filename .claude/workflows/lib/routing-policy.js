const { existsSync, readFileSync } = require('node:fs');
const { isAbsolute, resolve } = require('node:path');

const STAGE_NAMES = [
  'research',
  'explore',
  'synthesize',
  'plan',
  'implement',
  'implement_light',
  'implement_heavy',
  'merge',
  'review',
  'pr',
  'lessons',
];

const CURRENT_BEHAVIOR_ROUTING = {
  fableGate: {
    fallback: 'opus',
  },
  stages: {
    research: { provider: 'anthropic', model: 'sonnet' },
    explore: { provider: 'anthropic', model: 'sonnet' },
    synthesize: { provider: 'anthropic', model: 'opus', effort: 'high' },
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
    },
    implement: { provider: 'anthropic', model: 'sonnet', effort: 'medium' },
    implement_light: { provider: 'anthropic', model: 'sonnet', effort: 'medium' },
    implement_heavy: { provider: 'anthropic', model: 'sonnet', effort: 'medium' },
    merge: { provider: 'anthropic', model: 'sonnet' },
    review: { provider: 'anthropic', model: 'opus', effort: 'high' },
    pr: { provider: 'anthropic', model: 'sonnet' },
    lessons: { provider: 'anthropic', model: 'sonnet' },
  },
};

const ROUTING_CONFIG_DEFAULTS = {
  $comment: 'Per-stage model routing for dynamic-pipeline. provider ∈ anthropic|openrouter|codex.',
  fableGate: {
    fallback: 'opus',
  },
  stages: {
    research: {
      provider: 'openrouter',
      model: 'openrouter/google/gemini-3.5-flash',
      worker: 'opencoder',
      feature: 'grounded-search',
    },
    explore: { provider: 'openrouter', model: 'openrouter/google/gemini-3.5-flash' },
    synthesize: { provider: 'anthropic', model: 'opus', effort: 'high' },
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
    },
    implement: { provider: 'codex', model: 'default' },
    implement_light: {
      provider: 'openrouter',
      model: 'openrouter/deepseek/deepseek-v4-flash',
      worker: 'opencoder',
    },
    implement_heavy: { provider: 'codex', model: 'default', worker: 'codexer' },
    merge: { provider: 'anthropic', model: 'haiku' },
    review: { provider: 'anthropic', model: 'opus', effort: 'high' },
    pr: { provider: 'anthropic', model: 'sonnet' },
    lessons: { provider: 'anthropic', model: 'sonnet' },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveConfigPath(configPath, cwd) {
  return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
}

function mergeRoutingConfig(base, overlay) {
  const merged = clone(base);
  if (!isRecord(overlay)) return merged;

  if (isRecord(overlay.fableGate)) {
    merged.fableGate = { ...merged.fableGate, ...overlay.fableGate };
  }

  if (isRecord(overlay.stages)) {
    for (const stageName of STAGE_NAMES) {
      if (isRecord(overlay.stages[stageName])) {
        merged.stages[stageName] = {
          ...merged.stages[stageName],
          ...overlay.stages[stageName],
        };
      }
    }
  }

  return merged;
}

function loadRoutingConfig(configPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const resolvedPath = resolveConfigPath(configPath, cwd);

  if (!existsSync(resolvedPath)) {
    return clone(CURRENT_BEHAVIOR_ROUTING);
  }

  try {
    const raw = readFileSync(resolvedPath, 'utf8').trim();
    if (!raw) {
      return clone(CURRENT_BEHAVIOR_ROUTING);
    }
    const parsed = JSON.parse(raw);
    return mergeRoutingConfig(CURRENT_BEHAVIOR_ROUTING, parsed);
  } catch (error) {
    log(`Routing config parse failed at ${resolvedPath}; falling back to current behavior: ${error}`);
    return clone(CURRENT_BEHAVIOR_ROUTING);
  }
}

function resolveStageRoute(config, stageName, options = {}) {
  const stages = config && isRecord(config.stages) ? config.stages : CURRENT_BEHAVIOR_ROUTING.stages;
  const configured = isRecord(stages[stageName]) ? stages[stageName] : CURRENT_BEHAVIOR_ROUTING.stages[stageName];
  if (!configured) {
    throw new Error(`Unknown stage "${stageName}" in routing policy`);
  }

  const route = { ...configured };

  if (stageName === 'review') {
    if (route.provider !== 'anthropic') {
      throw new Error('Review stage must stay on provider=anthropic');
    }
    if (isRecord(route.escalation) && route.escalation.provider !== 'anthropic') {
      throw new Error('Review escalation pass must stay on provider=anthropic');
    }
  }

  if (route.model === 'fable' && stageName !== 'plan') {
    throw new Error('Fable is only allowed at the plan stage');
  }

  if (stageName === 'plan' && route.model === 'fable') {
    route.lean = true;
    const confirmFableUse = typeof options.confirmFableUse === 'function'
      ? options.confirmFableUse
      : null;
    const approved = confirmFableUse ? Boolean(confirmFableUse({ stageName, route, config })) : false;
    if (!approved && route.requiresConfirmation !== false) {
      return {
        provider: 'anthropic',
        model: route.fallback || config?.fableGate?.fallback || 'opus',
        effort: route.effort,
        lean: false,
        requiresConfirmation: false,
        fallback: route.fallback || config?.fableGate?.fallback || 'opus',
        confirmationDeclined: true,
      };
    }
  }

  return route;
}

function resolveReviewStack(config, options = {}) {
  const route = resolveStageRoute(config, 'review', options);
  const primary = isRecord(route.primary) ? { ...route.primary } : null;
  const escalation = isRecord(route.escalation)
    ? { ...route.escalation }
    : { provider: route.provider, model: route.model, effort: route.effort };

  return {
    runGatesFirst: route.runGatesFirst === true,
    diffScopedOnly: route.diffScopedOnly === true,
    primary,
    escalation,
    maxLoops: typeof escalation.maxLoops === 'number' ? escalation.maxLoops : 2,
  };
}

function buildAnthropicAgentOptions(base, route) {
  const options = {
    ...base,
    model: route.model,
  };
  if (route.effort) {
    options.effort = route.effort;
  }
  if (route.model === 'fable' && route.lean) {
    options.agentType = 'fable-lean';
  }
  return options;
}

module.exports = {
  CURRENT_BEHAVIOR_ROUTING,
  ROUTING_CONFIG_DEFAULTS,
  buildAnthropicAgentOptions,
  loadRoutingConfig,
  resolveReviewStack,
  resolveStageRoute,
};
