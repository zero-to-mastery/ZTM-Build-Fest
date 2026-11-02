const cache = new Map();
export const HEALTH_TTL = 5 * 60 * 1000;
const key = (t) => JSON.stringify([t.url, t.requestUrl, t.snapshot || null]);
export function cachedHealth(target, now = Date.now()) {
  const r = cache.get(key(target));
  return r && now - r.checkedAt < HEALTH_TTL ? structuredClone(r) : null;
}
export function cacheHealth(target, result) {
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key(target), structuredClone(result));
}
export function invalidateHealth() {
  cache.clear();
}
