import { createScene } from './constellation.mjs';
import { renderSceneSVG } from './renderer-svg.mjs';
import { normalizeRecords } from './data-pipeline.mjs';
import { createDataPipeline } from './pipeline-cache.mjs';
import { createLayoutHost } from './layout-host.mjs';
import { validateThemePack } from './theme-packs.mjs';
import { jsonFeedSource, normalizedJSONSource } from './json-feed-source.mjs';

const identifier = value => typeof value === 'string' && /^[a-z][a-z\d-]{0,63}$/.test(value);
export const PLUGIN_API_VERSION = 2;
export const SOURCE_API_VERSION = 2;
export function pluginOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'sources') || !Array.isArray(value.sources ?? [])) throw new Error('plugins must contain a sources array.');
  const ids = new Set();
  for (const item of value.sources || []) {
    if (!item || !identifier(item.id) || !identifier(item.source) || ids.has(item.id)) throw new Error('Each plugin source needs a unique id and a source identifier (lowercase letters, digits, hyphens).');
    if (item.options !== undefined && (!item.options || typeof item.options !== 'object' || Array.isArray(item.options))) throw new Error(`plugins.sources.${item.id}.options must be an object.`);
    ids.add(item.id);
  }
  return value.sources || [];
}

export function createPluginHost({ fetchImpl = globalThis.fetch } = {}) {
  const pipeline = createDataPipeline();
  const layoutHost = createLayoutHost();
  const sources = new Map(), themes = new Map();
  const cache = new Map();
  const cacheBudget = 8 * 1024 * 1024;
  let cacheBytes = 0;
  let generation = 0;
  const host = {
    apiVersion: PLUGIN_API_VERSION,
    clearCache() { generation++; cache.clear(); cacheBytes = 0; pipeline.clear(); layoutHost.clearCache(); },
    get pipelineCacheStatistics() { return pipeline.cacheStatistics; },
    get layoutCacheStatistics() { return layoutHost.cacheStatistics; },
    registerLayout(definition) { layoutHost.register(definition); return host; },
    get cacheStatistics() { return { entries: cache.size, estimatedBytes: cacheBytes, budgetBytes: cacheBudget }; },
    registerSource(plugin) {
      if (!plugin || !identifier(plugin.id) || ![1, SOURCE_API_VERSION].includes(plugin.apiVersion) || typeof plugin.load !== 'function') throw new Error('Source plugins require id, apiVersion: 1 or 2 and load(context).');
      if (sources.has(plugin.id)) throw new Error(`Source plugin already registered: ${plugin.id}`);
      sources.set(plugin.id, Object.freeze({ id: plugin.id, apiVersion: plugin.apiVersion, load: plugin.load, renderNode: plugin.renderNode })); return host;
    },
    registerThemePack(pack) {
      validateThemePack(pack);
      const key = `${pack.id}@${pack.version}`;
      if (themes.has(key)) throw new Error(`Theme pack already registered: ${key}`);
      themes.set(key, structuredClone(pack)); return host;
    },
    async load(config = {}, { account, signal, refresh = false } = {}) {
      if (refresh) host.clearCache();
      const epoch = generation;
      const result = [], seen = new Set();
      for (const source of structuredClone(pluginOptions(config.plugins)).sort((a, b) => a.id.localeCompare(b.id))) {
        signal?.throwIfAborted();
        const plugin = sources.get(source.source);
        if (!plugin) throw new Error(`Unknown source plugin: ${source.source}. Register it before loading.`);
        const key = JSON.stringify([account, source.source, source.id, source.options || {}]);
        let items = cache.get(key)?.items;
        const cached = Boolean(items);
        if (!items) {
          items = await plugin.load({ account, options: structuredClone(source.options || {}), signal, fetchImpl });
          signal?.throwIfAborted();
          if (epoch !== generation) throw new Error('Source data was refreshed during this load; retry with the current snapshot.');
          if (!Array.isArray(items)) throw new Error(`Source ${source.id} must return an array of nodes.`);
        }
        if (!Array.isArray(items)) throw new Error(`Source ${source.id} must return an array of nodes.`);
        for (const item of items) {
          if (plugin.apiVersion === 2) {
            const normalized = normalizeRecords([item]);
            if (item?.type !== 'record' || item.full_name !== undefined || normalized.records.length !== 1) throw new Error(`Source ${source.id} API v2 must return valid normalized records.`);
            const record = normalized.records[0], id = `source:${source.id}:${encodeURIComponent(record.id)}`;
            if (seen.has(id)) throw new Error(`Duplicate source node ID: ${id}`);
            seen.add(id);
            result.push({ ...record, id, source: { id: source.source, instance: source.id }, attributes: { ...record.attributes, language: record.attributes.language || 'External', private: false, pluginSource: source.source, pluginInstance: source.id, pluginId: record.id } });
            continue;
          }
          if (!item || typeof item.id !== 'string' || !item.id.trim() || /[\x00-\x1f]/.test(item.id) || typeof item.name !== 'string' || !item.name.trim()) throw new Error(`Source ${source.id} returned a node without a valid id and name.`);
          const id = `source:${source.id}:${encodeURIComponent(item.id)}`;
          if (seen.has(id)) throw new Error(`Duplicate source node ID: ${id}`);
          seen.add(id);
          result.push({ ...structuredClone(item), full_name: id, language: item.language || 'External', private: false, pluginSource: source.source, pluginInstance: source.id, pluginId: item.id, stargazers_count: item.stargazers_count || 0 });
        }
        if (!cached) {
          const bytes = (key.length + JSON.stringify(items).length) * 2;
          if (bytes <= cacheBudget) {
            while (cache.size >= 32 || cacheBytes + bytes > cacheBudget) {
              const oldest = cache.keys().next().value;
              cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
            }
            cache.set(key, { items: structuredClone(items), bytes }); cacheBytes += bytes;
          }
        }
      }
      return result.sort((a, b) => (a.full_name || a.id).localeCompare(b.full_name || b.id));
    },
    render(account, nodes, options = {}, runtime = {}) {
      return renderSceneSVG(host.createScene(account, nodes, options, runtime));
    },
    async loadRecords(config = {}, context = {}) {
      return normalizeRecords(await host.load(config, context), context);
    },
    createScene(account, nodes, options = {}, runtime = {}) {
      const ids = new Set();
      for (const node of nodes) {
        const id = node?.type === 'record' && !Object.hasOwn(node, 'full_name') ? node.id : node?.full_name;
        if (id === undefined) continue; // Normalization reports malformed records.
        if (ids.has(id)) throw new Error(`Duplicate graph node ID: ${id}`);
        ids.add(id);
      }
      let themePack = options.themePack;
      if (themePack && !themePack.preset) themePack = themes.get(`${themePack.id}@${themePack.version}`) || themePack;
      return createScene(account, nodes, { ...options, ...(themePack ? { themePack } : {}) }, {
        pipeline,
        layoutHost,
        ...runtime,
        nodeRenderer: context => runtime.nodeRenderer?.(context) ?? sources.get(context.node.pluginSource)?.renderNode?.(context),
      });
    },
  };
  host.registerSource(jsonFeedSource);
  host.registerSource(normalizedJSONSource);
  return host;
}
