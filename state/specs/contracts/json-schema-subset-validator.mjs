// Planning-only deterministic subset evaluator. This is intentionally not a
// substitute for the standards-compliant Draft 2020-12 CI validator required
// by FR-004 before promotion.
const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported external $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((value, token) => value[token.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateJsonSchema(root, value) {
  const errors = [];

  function visit(schema, current, path) {
    if (schema.$ref) return visit(resolveRef(root, schema.$ref), current, path);

    if (schema.anyOf) {
      const passes = schema.anyOf.some((candidate) => {
        const before = errors.length;
        visit(candidate, current, path);
        const passed = errors.length === before;
        errors.length = before;
        return passed;
      });
      if (!passes) errors.push(`${path}: anyOf failed`);
      return;
    }

    if (schema.allOf) for (const candidate of schema.allOf) visit(candidate, current, path);
    if (schema.if) {
      const before = errors.length;
      visit(schema.if, current, path);
      const condition = errors.length === before;
      errors.length = before;
      if (condition && schema.then) visit(schema.then, current, path);
      if (!condition && schema.else) visit(schema.else, current, path);
    }

    const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types && !types.some((type) => matchesType(current, type))) {
      errors.push(`${path}: expected ${types.join('|')}`);
      return;
    }
    if (Object.hasOwn(schema, 'const') && !jsonEqual(current, schema.const)) errors.push(`${path}: const mismatch`);
    if (schema.enum && !schema.enum.some((item) => jsonEqual(current, item))) errors.push(`${path}: enum mismatch`);

    if (typeof current === 'string') {
      if (schema.minLength !== undefined && current.length < schema.minLength) errors.push(`${path}: minLength`);
      if (schema.pattern && !(new RegExp(schema.pattern).test(current))) errors.push(`${path}: pattern`);
      if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(current) || Number.isNaN(Date.parse(current)))) errors.push(`${path}: date-time`);
    }

    if (typeof current === 'number' && schema.minimum !== undefined && current < schema.minimum) errors.push(`${path}: minimum`);
    if (typeof current === 'number' && schema.maximum !== undefined && current > schema.maximum) errors.push(`${path}: maximum`);

    if (Array.isArray(current)) {
      if (schema.minItems !== undefined && current.length < schema.minItems) errors.push(`${path}: minItems`);
      if (schema.maxItems !== undefined && current.length > schema.maxItems) errors.push(`${path}: maxItems`);
      if (schema.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) errors.push(`${path}: uniqueItems`);
      if (schema.items) current.forEach((item, index) => visit(schema.items, item, `${path}/${index}`));
      if (schema.contains) {
        const count = current.filter((item, index) => {
          const before = errors.length;
          visit(schema.contains, item, `${path}/${index}`);
          const passed = errors.length === before;
          errors.length = before;
          return passed;
        }).length;
        if (schema.minContains !== undefined && count < schema.minContains) errors.push(`${path}: minContains`);
        if (schema.maxContains !== undefined && count > schema.maxContains) errors.push(`${path}: maxContains`);
      }
    }

    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of schema.required ?? []) if (!Object.hasOwn(current, key)) errors.push(`${path}/${key}: required`);
      for (const [key, childSchema] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(current, key)) visit(childSchema, current[key], `${path}/${key}`);
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(current)) if (!allowed.has(key)) errors.push(`${path}/${key}: additionalProperties`);
      }
    }
  }

  visit(root, value, '$');
  return [...new Set(errors)];
}

export { validateJsonSchema };
