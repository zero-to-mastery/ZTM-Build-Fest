export const DATA_RECORD_VERSION = 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f]/.test(value);

export function normalizeRecords(input, { onDiagnostic, deferIdentityCheck = false } = {}) {
  if (!Array.isArray(input)) throw new Error('Source data must be an array.');
  const records = [], diagnostics = [], ids = new Set();
  for (const [index, item] of input.entries()) {
    let record;
    try {
      if (!object(item)) throw new Error('record must be an object');
      if (item.type === 'record' && !Object.hasOwn(item, 'full_name')) {
        if (item.version !== DATA_RECORD_VERSION || !name(item.id) || !name(item.label) || !name(item.kind) || !object(item.metrics) || !object(item.attributes)) throw new Error('invalid normalized record');
        if (Object.values(item.metrics).some(value => !Number.isFinite(value))) throw new Error('metrics must be finite numbers');
        record = structuredClone(item);
      } else {
        if (!name(item.full_name) || !name(item.name)) throw new Error('record needs full_name and name');
        record = {
          version: DATA_RECORD_VERSION, type: 'record', id: item.full_name, label: item.name,
          kind: item.nodeKind || 'repository',
          source: item.pluginSource ? { id: item.pluginSource, instance: item.pluginInstance } : { id: 'github' },
          metrics: { stars: Number.isFinite(item.stargazers_count) && item.stargazers_count >= 0 ? item.stargazers_count : 0 },
          attributes: structuredClone(item),
        };
      }
    } catch (error) {
      const diagnostic = { code: 'record-rejected', index, reason: error.message };
      diagnostics.push(diagnostic); onDiagnostic?.(diagnostic); continue;
    }
    if (!deferIdentityCheck && ids.has(record.id)) throw new Error(`Duplicate graph node ID: ${record.id}`);
    ids.add(record.id); records.push(record);
  }
  return { records, diagnostics, statistics: { loaded: input.length, rejected: diagnostics.length, normalized: records.length } };
}

// Keep graph/source API 1 compatible while the canonical data interface evolves.
// Attributes retain existing metadata, including plugin identity and temporal evidence.
export function toGraphRecords(records) {
  return records.map(record => ({ ...structuredClone(record.attributes),
    full_name: record.id, name: record.label,
    ...(record.kind !== 'repository' ? { nodeKind: record.kind } : {}),
    ...(record.metrics.stars !== undefined ? { stargazers_count: Math.max(0, record.metrics.stars) } : {}),
  }));
}
