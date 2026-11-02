import { createTimeline } from './timeline.mjs';
import { cacheableJSON } from './pipeline-cache.mjs';

export function createTimelineHost({ maxEntries = 4, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 0 || maxEntries > 64 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid timeline cache bounds.');
  const cache = new Map(); let bytes = 0, hits = 0, misses = 0;
  return {
    create(account, records, options, definition, runtime = {}) {
      runtime.signal?.throwIfAborted();
      const input = [account, records, options || {}, definition || {}];
      const key = !options?.layoutEngine && !runtime.nodeRenderer && !runtime.onDiagnostic && cacheableJSON(input) ? JSON.stringify(input) : null;
      if (key !== null && cache.has(key)) {
        const entry = cache.get(key); cache.delete(key); cache.set(key, entry); hits++;
        return structuredClone(entry.value);
      }
      misses++;
      const value = createTimeline(account, records, options, definition, runtime);
      runtime.signal?.throwIfAborted();
      if (key !== null && maxEntries > 0) {
        const size = new TextEncoder().encode(key + JSON.stringify(value)).length;
        if (size <= maxBytes) {
          while (cache.size >= maxEntries || bytes + size > maxBytes) { const oldest = cache.keys().next().value; bytes -= cache.get(oldest).size; cache.delete(oldest); }
          cache.set(key, { value: structuredClone(value), size }); bytes += size;
        }
      }
      return value;
    },
    clear() { cache.clear(); bytes = 0; hits = 0; misses = 0; },
    get cacheStatistics() { return { entries: cache.size, estimatedBytes: bytes, maxEntries, maxBytes, hits, misses }; },
  };
}
