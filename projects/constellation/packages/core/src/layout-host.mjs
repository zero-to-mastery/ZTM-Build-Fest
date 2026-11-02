import { layoutScene, layoutCapabilities, BUILTIN_LAYOUTS } from './layout-api.mjs';
import { rustAvailable } from './engine.mjs';
import { resolveSeed } from './seeded-random.mjs';
import { cacheableJSON } from './pipeline-cache.mjs';

export const LAYOUT_API_VERSION = 1;
const identifier = value => typeof value === 'string' && /^[a-z][a-z\d-]{0,63}$/.test(value);
export function validateLayoutReference(options) {
  if (options.layoutEngine !== undefined && !identifier(options.layoutEngine)) throw new Error('layoutEngine must be a registered layout identifier.');
  if (options.layoutOptions !== undefined && (!options.layoutOptions || typeof options.layoutOptions !== 'object' || Array.isArray(options.layoutOptions))) throw new Error('layoutOptions must be a declarative object.');
}

export function createLayoutHost({ maxEntries = 8, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 0 || maxEntries > 128 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid layout cache bounds.');
  const layouts = new Map();
  const cache = new Map();
  let bytes = 0, hits = 0, misses = 0;
  const host = {
    clearCache() { cache.clear(); bytes = 0; hits = 0; misses = 0; },
    get cacheStatistics() { return { entries: cache.size, estimatedBytes: bytes, maxEntries, maxBytes, hits, misses }; },
    register(definition) {
      if (!definition || !identifier(definition.id) || definition.apiVersion !== LAYOUT_API_VERSION || typeof definition.layout !== 'function') throw new Error('Layouts require id, apiVersion: 1 and layout(scene, options, context).');
      if (BUILTIN_LAYOUTS.includes(definition.id) || layouts.has(definition.id)) throw new Error(`Layout already registered: ${definition.id}`);
      const capabilities = definition.capabilities;
      if (!capabilities || Array.isArray(capabilities) || Object.keys(capabilities).some(key => !['maxNodes', 'manualPositioning', 'ringSnapping', 'deterministicSeed', 'animation', 'refinement'].includes(key)) || !Number.isInteger(capabilities.maxNodes) || capabilities.maxNodes < 1 || capabilities.maxNodes > 2048 || ['manualPositioning', 'ringSnapping', 'deterministicSeed', 'animation', 'refinement'].some(key => typeof capabilities[key] !== 'boolean')) throw new Error('Layouts must declare graph-size, manual, snapping, seed, animation and refinement capabilities.');
      layouts.set(definition.id, Object.freeze({ id: definition.id, layout: definition.layout, capabilities: Object.freeze(structuredClone(capabilities)) }));
      return host;
    },
    describe(id, options) {
      return BUILTIN_LAYOUTS.includes(id) ? layoutCapabilities(id, options) : layouts.has(id) ? { id, ...structuredClone(layouts.get(id).capabilities) } : null;
    },
    list() { return [...BUILTIN_LAYOUTS, ...layouts.keys()]; },
    run(scene, options = {}, context = {}) {
      validateLayoutReference(options);
      context.signal?.throwIfAborted();
      const id = options.layoutEngine || options.arrangement || (rustAvailable ? 'rings' : 'field');
      if (BUILTIN_LAYOUTS.includes(id)) return layoutScene(scene, { ...options, arrangement: id }, context);
      const registered = layouts.get(id);
      if (!registered) throw new Error(`Unknown layout: ${id}. Register it with the trusted host before rendering.`);
      const capabilities = registered.capabilities;
      if (scene.nodes.length > capabilities.maxNodes) throw new Error(`Layout ${id} supports at most ${capabilities.maxNodes} nodes.`);
      for (const [supported, requested, label] of [
        [capabilities.manualPositioning, Object.keys(options.starPositions || {}).length > 0, 'manual positions'],
        [capabilities.ringSnapping, options.snapToRings === true, 'ring snapping'],
        [capabilities.animation, options.animate !== false, 'animation'],
        [capabilities.refinement, options.layoutRefinement?.enabled, 'refinement'],
      ]) if (requested && !supported) throw new Error(`Layout ${id} does not support ${label}.`);
      if (!capabilities.deterministicSeed) context.onDiagnostic?.({ code: 'layout-nondeterministic', severity: 'warning', message: `Layout ${id} does not promise deterministic seeded output.` });
      // Rust still constructs the relationship graph. Trusted layouts only return
      // positions; they cannot inject SVG or replace source/config validation.
      const graph = layoutScene(scene, { ...options, arrangement: 'field' }, context);
      if (!graph) throw new Error('Registered layouts require the Rust/WASM graph engine.');
      const input = { ...structuredClone(scene), edges: graph.edges.map(edge => ({ from: scene.nodes[edge.from].id, to: scene.nodes[edge.to].id, metadata: { languages: edge.languages, topics: edge.topics, members: edge.members } })) };
      const account = context.account || scene.metadata?.account || 'constellation';
      const layoutContext = { account, seed: context.seed ?? resolveSeed(account, options), reference: context.reference ?? Date.parse(scene.metadata?.referenceDate || options.referenceDate || '1970-01-01T00:00:00Z') };
      const payload = [id, input, options.layoutOptions || {}, layoutContext];
      const key = capabilities.deterministicSeed && maxEntries && maxBytes && cacheableJSON(payload) ? JSON.stringify(payload) : null;
      let positions;
      if (key && cache.has(key)) {
        hits++; const cached = cache.get(key); cache.delete(key); cache.set(key, cached);
        positions = structuredClone(cached.positions);
      } else {
        misses++;
        positions = registered.layout(input, structuredClone(options.layoutOptions || {}), { ...layoutContext, signal: context.signal });
      }
      if (!positions || typeof positions !== 'object' || Array.isArray(positions) || typeof positions.then === 'function') throw new Error('A registered layout must synchronously return positions keyed by node ID.');
      const expected = new Set(scene.nodes.map(node => node.id));
      if (Object.keys(positions).length !== expected.size || Object.keys(positions).some(id => !expected.has(id))) throw new Error('Layout must return exactly one position for every scene node.');
      for (const id of expected) {
        const point = positions[id];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10000 || Math.abs(point.y) > 10000) throw new Error(`Invalid position from layout ${registered.id}: ${id}`);
      }
      context.signal?.throwIfAborted();
      if (key && !cache.has(key)) {
        const size = (key.length + JSON.stringify(positions).length) * 2;
        if (size <= maxBytes) {
          while (cache.size >= maxEntries || bytes + size > maxBytes) { const oldest = cache.keys().next().value; bytes -= cache.get(oldest).bytes; cache.delete(oldest); }
          cache.set(key, { positions: structuredClone(positions), bytes: size }); bytes += size;
        }
      }
      return layoutScene(scene, { ...options, arrangement: 'field', starPositions: { ...structuredClone(positions), ...options.starPositions } }, context);
    },
  };
  return host;
}
