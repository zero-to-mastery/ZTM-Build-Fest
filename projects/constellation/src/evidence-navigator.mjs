// Evidence Navigation v1 runtime adapter. Dependency-free: the engine, browser
// runtime, and standalone HTML (which embeds this source) all share it.
// Wraps a constructed EvidenceNavigator with bounded, cached, isolated results.
export function evidenceNavigatorAdapter(EvidenceNavigator, graph) {
  if (typeof EvidenceNavigator !== 'function' || !graph) return null;
  let index;
  try { index = new EvidenceNavigator(JSON.stringify(graph)); } catch { return null; }
  const cache = new Map();
  return {
    projectCount: index.projectCount,
    navigate(projectId, depth = 1) {
      if (typeof projectId !== 'string' || projectId.length > 512 || ![1, 2].includes(depth)) return null;
      const key = `${depth}\n${projectId}`;
      if (!cache.has(key)) {
        let result = null;
        try { result = JSON.parse(index.navigate(JSON.stringify({ projectId, depth }))); } catch {}
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, result);
      }
      const result = cache.get(key);
      return result && structuredClone(result);
    },
    destroy() { cache.clear(); index.free?.(); index = null; },
  };
}
