import { normalizeRecords } from './data-pipeline.mjs';
import { applyTransforms } from './data-transforms.mjs';

// Explicit host ownership avoids process-wide data registries and cross-instance
// state. Values outside plain JSON remain usable but are never cache keys.
export function cacheableJSON(value, seen = new WeakSet(), depth = 0) {
  if (depth > 32) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) return true;
  if (typeof value !== 'object' || seen.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  const valid = Object.values(value).every(child => cacheableJSON(child, seen, depth + 1));
  seen.delete(value); return valid;
}

export function createDataPipeline({ maxEntries = 16, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 0 || maxEntries > 1024 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid pipeline cache bounds.');
  const cache = new Map();
  let bytes = 0, hits = 0, misses = 0;
  function cached(stage, input, options, signal, compute) {
    signal?.throwIfAborted();
    const payload = [stage, input, options];
    const key = maxEntries && maxBytes && cacheableJSON(payload) ? JSON.stringify(payload) : null;
    if (key && cache.has(key)) {
      hits++;
      const entry = cache.get(key); cache.delete(key); cache.set(key, entry);
      return structuredClone(entry.value);
    }
    misses++;
    const value = compute();
    signal?.throwIfAborted();
    const size = key ? (key.length + JSON.stringify(value).length) * 2 : Infinity;
    if (size <= maxBytes) {
      while (cache.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = cache.keys().next().value;
        bytes -= cache.get(oldest).bytes; cache.delete(oldest);
      }
      cache.set(key, { value: structuredClone(value), bytes: size }); bytes += size;
    }
    return value;
  }
  const pipeline = {
    get cacheStatistics() { return { entries: cache.size, estimatedBytes: bytes, maxEntries, maxBytes, hits, misses }; },
    clear() { cache.clear(); bytes = 0; hits = 0; misses = 0; },
    normalize(input, { signal, onDiagnostic, deferIdentityCheck = false } = {}) {
      const result = cached('normalize', input, { deferIdentityCheck }, signal, () => normalizeRecords(input, { deferIdentityCheck }));
      for (const diagnostic of result.diagnostics) onDiagnostic?.(structuredClone(diagnostic));
      signal?.throwIfAborted(); return result;
    },
    transform(records, transforms = [], { signal } = {}) {
      return cached('transform', records, transforms, signal, () => applyTransforms(records, transforms));
    },
    run(input, { transforms = [], signal, onDiagnostic } = {}) {
      const normalized = pipeline.normalize(input, { signal, onDiagnostic });
      const transformed = pipeline.transform(normalized.records, transforms, { signal });
      return { records: transformed.records, diagnostics: normalized.diagnostics,
        statistics: { ...normalized.statistics, transformed: transformed.records.length,
          filtered: transformed.diagnostics.filter(stage => ['filter', 'limit', 'deduplicate'].includes(stage.type)).reduce((sum, stage) => sum + stage.removed, 0), transforms: transformed.diagnostics } };
    },
  };
  return pipeline;
}
