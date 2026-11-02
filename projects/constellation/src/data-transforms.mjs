const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value);
const compare = (a, b) => a === b ? 0 : a == null ? -1 : b == null ? 1 : typeof a === typeof b ? a < b ? -1 : 1 : typeof a < typeof b ? -1 : 1;
const keys = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Invalid declarative transform fields.'); };

export function fieldPath(value, writable = false) {
  if (typeof value !== 'string' || !/^(?:id|label|kind|metrics\.[a-zA-Z_][\w-]*|attributes(?:\.[a-zA-Z_][\w-]*){1,4})$/.test(value) || value.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part)) || writable && value === 'id') throw new Error('Invalid data field path.');
  return value.split('.');
}
export function readField(record, path) {
  return fieldPath(path).reduce((value, part) => value != null && Object.hasOwn(value, part) ? value[part] : undefined, record);
}
function writeField(record, path, value) {
  const parts = fieldPath(path, true), leaf = parts.pop();
  let target = record;
  for (const part of parts) { if (!object(target[part])) target[part] = {}; target = target[part]; }
  target[leaf] = value;
}
const arities = { add: [2, 8], subtract: [2, 2], multiply: [2, 8], divide: [2, 2], min: [1, 8], max: [1, 8], coalesce: [2, 8], concat: [1, 8], lowercase: [1, 1] };
export function validateExpression(expression, depth = 0) {
  if (depth > 6) throw new Error('Data expression is too deeply nested.');
  keys(expression, ['field', 'value', 'op', 'args']);
  if (Object.hasOwn(expression, 'field')) {
    if (Object.keys(expression).length !== 1) throw new Error('A field expression only accepts field.');
    fieldPath(expression.field); return;
  }
  if (Object.hasOwn(expression, 'value')) {
    if (Object.keys(expression).length !== 1 || !scalar(expression.value)) throw new Error('Expression values must be finite scalars.');
    return;
  }
  const arity = arities[expression.op];
  if (!Object.hasOwn(arities, expression.op) || !arity || !Array.isArray(expression.args) || expression.args.length < arity[0] || expression.args.length > arity[1]) throw new Error('Invalid data expression operation or arguments.');
  for (const arg of expression.args) validateExpression(arg, depth + 1);
}
export function evaluateExpression(expression, record) {
  if (Object.hasOwn(expression, 'field')) return readField(record, expression.field);
  if (Object.hasOwn(expression, 'value')) return expression.value;
  const values = expression.args.map(arg => evaluateExpression(arg, record));
  if (expression.op === 'coalesce') return values.find(value => value !== undefined && value !== null) ?? null;
  if (expression.op === 'concat') return values.map(value => value == null ? '' : String(value)).join('');
  if (expression.op === 'lowercase') return String(values[0] ?? '').toLowerCase();
  if (!values.every(Number.isFinite)) return null;
  let result;
  switch (expression.op) {
    case 'add': result = values.reduce((a, b) => a + b, 0); break;
    case 'subtract': result = values[0] - values[1]; break;
    case 'multiply': result = values.reduce((a, b) => a * b, 1); break;
    case 'divide': result = values[1] === 0 ? null : values[0] / values[1]; break;
    case 'min': result = Math.min(...values); break;
    case 'max': result = Math.max(...values); break;
    default: throw new Error('Unknown data expression operation.');
  }
  return Number.isFinite(result) ? result : null;
}

export function validateTransforms(transforms = []) {
  if (!Array.isArray(transforms) || transforms.length > 32) throw new Error('transforms must be an array of at most 32 stages.');
  for (const step of transforms) {
    switch (step?.type) {
      case 'filter':
        keys(step, ['type', 'field', 'op', 'value']); fieldPath(step.field);
        if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists'].includes(step.op)) throw new Error('Invalid filter operation.');
        if (step.op === 'exists' ? step.value !== undefined : step.op === 'in' ? !Array.isArray(step.value) || !step.value.every(scalar) : !scalar(step.value)) throw new Error('Invalid filter value.');
        break;
      case 'sort':
        keys(step, ['type', 'field', 'direction']); fieldPath(step.field);
        if (step.direction !== undefined && !['asc', 'desc'].includes(step.direction)) throw new Error('Invalid sort direction.');
        break;
      case 'limit':
        keys(step, ['type', 'count']);
        if (!Number.isInteger(step.count) || step.count < 0 || step.count > 100000) throw new Error('Invalid transform limit.');
        break;
      case 'deduplicate': case 'group':
        keys(step, ['type', 'field']); fieldPath(step.field); break;
      case 'derive':
        keys(step, ['type', 'field', 'expression']); fieldPath(step.field, true); validateExpression(step.expression); break;
      case 'map':
        keys(step, ['type', 'fields']);
        if (!object(step.fields) || Object.keys(step.fields).length > 32) throw new Error('Invalid mapped fields.');
        for (const [path, expression] of Object.entries(step.fields)) { fieldPath(path, true); validateExpression(expression); }
        break;
      default: throw new Error('Unknown transform type.');
    }
  }
  return transforms;
}

function matches(value, step) {
  switch (step.op) {
    case 'exists': return value !== undefined && value !== null;
    case 'eq': return value === step.value;
    case 'ne': return value !== step.value;
    case 'in': return Array.isArray(step.value) && step.value.includes(value);
    case 'contains': return (typeof value === 'string' || Array.isArray(value)) && value.includes(step.value);
    default:
      if (!Number.isFinite(value) || !Number.isFinite(step.value)) return false;
      return step.op === 'gt' ? value > step.value : step.op === 'gte' ? value >= step.value : step.op === 'lt' ? value < step.value : value <= step.value;
  }
}
const groupKey = value => {
  if (value !== undefined && !scalar(value)) throw new Error('Grouping and deduplication require scalar field values.');
  return JSON.stringify(value ?? null);
};
export function applyTransforms(input, transforms = []) {
  validateTransforms(transforms);
  let records = structuredClone(input);
  const diagnostics = [];
  for (const step of transforms) {
    const before = records.length;
    switch (step.type) {
      case 'filter': records = records.filter(record => matches(readField(record, step.field), step)); break;
      case 'sort':
        if (records.some(record => { const value = readField(record, step.field); return value !== undefined && !scalar(value); })) throw new Error('Sorting requires scalar field values.');
        records.sort((a, b) => compare(readField(a, step.field), readField(b, step.field)) * (step.direction === 'desc' ? -1 : 1) || compare(a.id, b.id)); break;
      case 'limit': records = records.slice(0, step.count); break;
      case 'deduplicate': {
        const seen = new Set(); records = records.filter(record => { const key = groupKey(readField(record, step.field)); if (seen.has(key)) return false; seen.add(key); return true; }); break;
      }
      case 'group': {
        const groups = new Map();
        for (const record of records) {
          const key = groupKey(readField(record, step.field));
          if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record);
        }
        for (const members of groups.values()) members.sort((a, b) => compare(a.id, b.id));
        records = [...groups].sort(([a], [b]) => compare(a, b)).map(([key, members]) => ({
          version: 1, type: 'record', id: `group:${encodeURIComponent(step.field)}:${encodeURIComponent(key)}`,
          label: String(JSON.parse(key) ?? 'Unknown'), kind: 'group', source: { id: 'transform' },
          metrics: { count: members.length, stars: members.reduce((sum, record) => sum + (record.metrics.stars || 0), 0) },
          attributes: { language: 'Group', members: members.map(record => record.id).sort(), representedCount: members.length, groupBy: step.field, groupValue: JSON.parse(key) },
        })); break;
      }
      case 'derive': case 'map': {
        const fields = step.type === 'derive' ? { [step.field]: step.expression } : step.fields;
        records = records.map(record => {
          const next = structuredClone(record);
          for (const [path, expression] of Object.entries(fields)) {
            const value = evaluateExpression(expression, record);
            if (path.startsWith('metrics.') && !Number.isFinite(value)) throw new Error(`Derived metric ${path} must be finite; use coalesce for missing values.`);
            if (['label', 'kind'].includes(path) && (typeof value !== 'string' || !value.trim())) throw new Error(`Derived ${path} must be nonempty text.`);
            writeField(next, path, value ?? null);
          }
          return next;
        }); break;
      }
    }
    diagnostics.push({ type: step.type, input: before, output: records.length, removed: Math.max(0, before - records.length) });
  }
  return { records, diagnostics };
}
