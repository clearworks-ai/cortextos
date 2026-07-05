const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/*
Public contract: sendWork({
  provider,            // "openrouter" | "codex"
  model,               // provider-native model slug/name
  prompt,              // task prompt for the worker
  schema,              // JSON schema describing the required final shape
  cwd = process.cwd(), // working directory to execute in
  effort,              // optional reasoning/variant hint
  allowWrite = false,  // true when the worker may edit files in cwd
  env = {},            // optional environment overrides
})
=> Promise<object>     // parsed, schema-validated final JSON result

dynamic-pipeline.js is only the first caller. Future M2C1/OBF execution should
reuse sendWork() unchanged.
*/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildJsonOnlyPrompt(prompt, schema, attempt) {
  const retryLine = attempt > 0
    ? 'Your previous response was not valid JSON or did not match the schema. Correct it now.'
    : '';
  return [
    prompt.trim(),
    '',
    'Return ONLY one JSON value that matches this schema exactly.',
    stableStringify(schema),
    '',
    'Rules:',
    '- No markdown fences.',
    '- No prose or explanations.',
    '- Start immediately with "{" or "[" and end immediately with the matching closing bracket.',
    retryLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function collectErrorText(error) {
  if (!error) return 'Unknown command failure';
  const stderr = error.stderr ? String(error.stderr).trim() : '';
  const stdout = error.stdout ? String(error.stdout).trim() : '';
  return stderr || stdout || String(error.message || error);
}

function parseJsonText(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractOpenCodeJsonText(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const textParts = [];

  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'text' && parsed.part && typeof parsed.part.text === 'string') {
        textParts.push(parsed.part.text);
      }
    } catch {
      continue;
    }
  }

  if (textParts.length === 0) {
    throw new Error('OpenCode did not emit a text payload in --format json output');
  }

  return textParts.join('').trim();
}

function validateSchema(schema, value, path = '$') {
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) {
      errors.push(`${path} must be an object`);
      return errors;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      errors.push(...validateSchema(propertySchema, value[key], `${path}.${key}`));
    }
    return errors;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return errors;
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(schema.items, item, `${path}[${index}]`));
      });
    }
    return errors;
  }

  if (schema.type === 'string' && typeof value !== 'string') {
    errors.push(`${path} must be a string`);
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`);
  }
  if (schema.type === 'number' && typeof value !== 'number') {
    errors.push(`${path} must be a number`);
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) {
    errors.push(`${path} must be an integer`);
  }

  return errors;
}

function assertSchema(schema, value, context) {
  const errors = validateSchema(schema, value);
  if (errors.length > 0) {
    throw new Error(`${context} failed schema validation: ${errors.join('; ')}`);
  }
}

function ensureRequiredInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('sendWork requires an input object');
  }
  if (typeof input.provider !== 'string' || input.provider.length === 0) {
    throw new Error('sendWork requires provider');
  }
  if (typeof input.model !== 'string' || input.model.length === 0) {
    throw new Error('sendWork requires model');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new Error('sendWork requires prompt');
  }
  if (!input.schema || typeof input.schema !== 'object') {
    throw new Error('sendWork requires schema');
  }
}

function runOpenRouter(input, deps) {
  const mergedEnv = { ...process.env, ...(input.env || {}) };
  if (!mergedEnv.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required for provider=openrouter');
  }

  const run = deps.execFileSync || execFileSync;
  const args = [
    'run',
    '--model', input.model,
    '--format', 'json',
    '--dir', input.cwd || process.cwd(),
  ];
  if (input.effort) {
    args.push('--variant', input.effort);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wrappedPrompt = buildJsonOnlyPrompt(input.prompt, input.schema, attempt);
    try {
      const stdout = run('opencode', [...args, wrappedPrompt], {
        cwd: input.cwd || process.cwd(),
        env: mergedEnv,
        encoding: 'utf8',
      });
      const rawJson = extractOpenCodeJsonText(stdout);
      const parsed = parseJsonText(rawJson, 'OpenRouter stage');
      assertSchema(input.schema, parsed, 'OpenRouter stage');
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /invalid JSON|schema validation|did not emit a text payload/i.test(message);
      if (!retryable || attempt === 1) {
        throw new Error(`OpenRouter stage failed (${input.model}): ${message}`);
      }
    }
  }

  throw new Error(`OpenRouter stage failed (${input.model})`);
}

function runCodex(input, deps) {
  const run = deps.execFileSync || execFileSync;
  const makeTempDir = deps.mkdtempSync || mkdtempSync;
  const readText = deps.readFileSync || readFileSync;
  const writeText = deps.writeFileSync || writeFileSync;
  const removeTree = deps.rmSync || rmSync;
  const mergedEnv = { ...process.env, ...(input.env || {}) };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tempDir = makeTempDir(join(tmpdir(), 'runtime-bridge-'));
    const schemaPath = join(tempDir, 'schema.json');
    const outputPath = join(tempDir, 'output.json');

    try {
      writeText(schemaPath, JSON.stringify(input.schema, null, 2), 'utf8');
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
      ];
      if (input.model) {
        args.push('--model', input.model);
      }
      if (input.allowWrite) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      if (input.cwd) {
        args.push('--cd', input.cwd);
      }
      args.push(buildJsonOnlyPrompt(input.prompt, input.schema, attempt));

      run('codex', args, {
        cwd: input.cwd || process.cwd(),
        env: mergedEnv,
        encoding: 'utf8',
      });

      const rawJson = String(readText(outputPath, 'utf8')).trim();
      const parsed = parseJsonText(rawJson, 'Codex stage');
      assertSchema(input.schema, parsed, 'Codex stage');
      return parsed;
    } catch (error) {
      const message = collectErrorText(error);
      const retryable = /invalid JSON|schema validation/i.test(message);
      if (!retryable || attempt === 1) {
        throw new Error(`Codex stage failed (${input.model || 'default'}): ${message}`);
      }
    } finally {
      try {
        removeTree(tempDir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best-effort only.
      }
    }
  }

  throw new Error(`Codex stage failed (${input.model || 'default'})`);
}

async function sendWork(input, deps = {}) {
  ensureRequiredInput(input);
  if (input.provider === 'openrouter') {
    return runOpenRouter(input, deps);
  }
  if (input.provider === 'codex') {
    return runCodex(input, deps);
  }
  throw new Error(`Unsupported provider "${input.provider}" in sendWork()`);
}

module.exports = {
  buildJsonOnlyPrompt,
  extractOpenCodeJsonText,
  sendWork,
  validateSchema,
};
