const { existsSync, readFileSync } = require('node:fs');
const { isAbsolute, resolve } = require('node:path');

const STAGE_NAMES = ['explore', 'plan', 'implement', 'merge', 'review', 'pr', 'lessons'];
const PLANNER_CHOICES = ['fable', 'opus'];

const CURRENT_BEHAVIOR_ROUTING = {
  fableGate: {
    fallback: 'opus',
  },
  stages: {
    explore: { provider: 'anthropic', model: 'sonnet' },
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
    },
    implement: { provider: 'anthropic', model: 'sonnet', effort: 'medium' },
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
    explore: { provider: 'openrouter', model: 'openrouter/google/gemini-3.5-flash' },
    plan: {
      provider: 'anthropic',
      model: 'fable',
      effort: 'high',
      lean: true,
      requiresConfirmation: true,
      fallback: 'opus',
    },
    implement: { provider: 'codex', model: 'gpt-5.4' },
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

function resolvePlannerChoice(env = process.env) {
  const raw = env && typeof env.PIPELINE_PLANNER === 'string'
    ? env.PIPELINE_PLANNER.trim().toLowerCase()
    : '';
  return PLANNER_CHOICES.includes(raw) ? raw : null;
}

function resolveStageRoute(config, stageName, options = {}) {
  const stages = config && isRecord(config.stages) ? config.stages : CURRENT_BEHAVIOR_ROUTING.stages;
  const configured = isRecord(stages[stageName]) ? stages[stageName] : CURRENT_BEHAVIOR_ROUTING.stages[stageName];
  if (!configured) {
    throw new Error(`Unknown stage "${stageName}" in routing policy`);
  }

  const route = { ...configured };

  if (stageName === 'review' && route.provider !== 'anthropic') {
    throw new Error('Review stage must stay on provider=anthropic');
  }

  if (route.model === 'fable' && stageName !== 'plan') {
    throw new Error('Fable is only allowed at the plan stage');
  }

  if (stageName === 'plan' && route.model === 'fable') {
    route.lean = true;
    const plannerChoice = PLANNER_CHOICES.includes(options.plannerChoice)
      ? options.plannerChoice
      : null;
    const confirmFableUse = typeof options.confirmFableUse === 'function'
      ? options.confirmFableUse
      : null;
    const approved = plannerChoice === 'fable'
      ? true
      : plannerChoice === 'opus'
        ? false
        : confirmFableUse ? Boolean(confirmFableUse({ stageName, route, config })) : false;
    if (!approved && (plannerChoice === 'opus' || route.requiresConfirmation !== false)) {
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
  resolvePlannerChoice,
  resolveStageRoute,
};
