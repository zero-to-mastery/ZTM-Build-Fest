import { fieldPath, readField, validateExpression, evaluateExpression } from './data-transforms.mjs';
import { mappedColor, activityScore } from './visual-mapping.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const color = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
const shorthand = {
  size: { stars: { field: 'metrics.stars', domain: [0, 1000], range: [2.7, 10], scale: 'log' } },
  color: { language: { field: 'attributes.language', palette: 'language' } },
  glow: { activity: { field: 'metrics.activity', domain: [0, 1], range: [0, 1] } },
  opacity: { age: { field: 'metrics.age', domain: [0, 3650], range: [1, 0.25] } },
};
export function normalizeMappings(input = {}) {
  if (!object(input)) throw new Error('mappings must be an object.');
  const mappings = {};
  for (const [channel, value] of Object.entries(input)) {
    if (!Object.hasOwn(shorthand, channel)) throw new Error(`Unknown visual mapping: ${channel}`);
    const mapping = typeof value === 'string' ? shorthand[channel][value] : value;
    if (!object(mapping) || Object.keys(mapping).some(key => !['field', 'expression', 'domain', 'range', 'scale', 'categories', 'fallback', 'palette'].includes(key))) throw new Error(`Invalid ${channel} mapping.`);
    if (Number(Object.hasOwn(mapping, 'field')) + Number(Object.hasOwn(mapping, 'expression')) !== 1) throw new Error('Mappings need exactly one field or expression.');
    if (mapping.field) fieldPath(mapping.field); else validateExpression(mapping.expression);
    if (channel === 'color') {
      if (mapping.palette !== undefined && mapping.palette !== 'language') throw new Error('Unknown mapping palette.');
      if (mapping.categories !== undefined && (!object(mapping.categories) || Object.keys(mapping.categories).length > 256 || !Object.values(mapping.categories).every(color))) throw new Error('Color categories must contain 6-digit hex colors.');
      if (mapping.fallback !== undefined && !color(mapping.fallback)) throw new Error('Color fallback must be a 6-digit hex color.');
      if (['domain', 'range', 'scale'].some(key => key in mapping)) throw new Error('Color mappings use categories or the language palette.');
    } else {
      if (!Array.isArray(mapping.domain) || mapping.domain.length !== 2 || !mapping.domain.every(Number.isFinite) || mapping.domain[1] <= mapping.domain[0]) throw new Error('Mapping domain needs two increasing finite numbers.');
      const maximum = channel === 'size' ? 20 : 1;
      if (!Array.isArray(mapping.range) || mapping.range.length !== 2 || !mapping.range.every(value => Number.isFinite(value) && value >= (channel === 'size' ? 0.5 : 0) && value <= maximum)) throw new Error(`Invalid ${channel} mapping range.`);
      if (!['linear', 'sqrt', 'log'].includes(mapping.scale || 'linear')) throw new Error('Invalid mapping scale.');
      if (mapping.fallback !== undefined && (!Number.isFinite(mapping.fallback) || mapping.fallback < (channel === 'size' ? 0.5 : 0) || mapping.fallback > maximum)) throw new Error('Invalid mapping fallback.');
      if ('palette' in mapping || 'categories' in mapping) throw new Error('Numeric mappings cannot contain color categories.');
    }
    mappings[channel] = structuredClone(mapping);
  }
  return mappings;
}

export function mapRecord(record, mappings, { reference, activity } = {}) {
  const created = Date.parse(record.attributes.created_at);
  const metrics = { ...record.metrics };
  if (metrics.activity === undefined) metrics.activity = activity ?? activityScore(record.attributes, reference);
  if (metrics.age === undefined && Number.isFinite(created)) metrics.age = Math.max(0, reference - created) / 86400000;
  const input = { ...record, metrics };
  const result = {};
  for (const [channel, mapping] of Object.entries(mappings)) {
    const value = mapping.field ? readField(input, mapping.field) : evaluateExpression(mapping.expression, input);
    if (channel === 'color') {
      const mapped = mapping.categories && Object.hasOwn(mapping.categories, value) ? mapping.categories[value]
        : mapping.palette === 'language' && typeof value === 'string' ? mappedColor({ language: value, name: value }, 'language') : mapping.fallback;
      if (mapped !== undefined) result.color = mapped;
    } else if (!Number.isFinite(value)) {
      if (mapping.fallback !== undefined) result[channel] = mapping.fallback;
    } else {
      let fraction = Math.max(0, Math.min(1, (value - mapping.domain[0]) / (mapping.domain[1] - mapping.domain[0])));
      if (mapping.scale === 'sqrt') fraction = Math.sqrt(fraction);
      if (mapping.scale === 'log') fraction = Math.log1p(fraction * 999) / Math.log(1000);
      result[channel] = mapping.range[0] + fraction * (mapping.range[1] - mapping.range[0]);
    }
  }
  return result;
}
