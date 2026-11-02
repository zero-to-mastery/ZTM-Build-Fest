// Phases preserve the legacy camera and historical-animation boundaries.
// A logical layer may contribute more than one fragment (e.g. world dust and
// backdrop stars) while retaining one identity and one set of controls.
export const layerDefinitions = Object.freeze([
  ['background', ['backdrop']],
  ['effects', ['backdrop']],
  ['rings', ['world']],
  ['starfield', ['backdrop', 'world']],
  ['annotations', ['underlay', 'overlay']],
  ['connections', ['world']],
  ['nodes', ['world']],
  ['labels', ['world']],
  ['selection', ['interaction']],
].map(([id, phases], order) => Object.freeze({ id, type: id, order, phases: Object.freeze(phases) })));

export function validateLayerOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('layers must be an object.');
  for (const [id, values] of Object.entries(options)) {
    if (!layerDefinitions.some(layer => layer.id === id)) throw new Error(`Unknown layer: ${id}`);
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !['visible', 'opacity', 'order'].includes(key))) throw new Error(`Invalid layer controls: ${id}`);
    if (values.visible !== undefined && typeof values.visible !== 'boolean') throw new Error(`Layer ${id} visibility must be boolean.`);
    if (values.opacity !== undefined && (!Number.isFinite(values.opacity) || values.opacity < 0 || values.opacity > 1)) throw new Error(`Layer ${id} opacity must be between 0 and 1.`);
    if (id === 'selection' && values.opacity !== undefined && values.opacity !== 1) throw new Error('Selection layer supports visibility; opacity is controlled by highlight styling.');
    if (values.order !== undefined && (!Number.isInteger(values.order) || Math.abs(values.order) > 1000)) throw new Error(`Layer ${id} order must be an integer from -1000 to 1000.`);
  }
  return options;
}

export function validateLayerOrder(layers) {
  const before = (first, second) => layers.findIndex(layer => layer.id === first) < layers.findIndex(layer => layer.id === second);
  if (!before('background', 'effects') || !before('background', 'starfield') || !before('connections', 'nodes') || !before('nodes', 'labels')) throw new Error('Layer order must keep the background behind decorations and connections behind nodes and labels.');
}

export function createLayers(options = {}) {
  validateLayerOptions(options);
  const layers = layerDefinitions.map(layer => ({ ...layer, visible: true, opacity: 1, ...options[layer.id], phases: [...layer.phases] }))
    .sort((a, b) => a.order - b.order || layerDefinitions.findIndex(layer => layer.id === a.id) - layerDefinitions.findIndex(layer => layer.id === b.id))
    .map((layer, order) => ({ ...layer, order }));
  validateLayerOrder(layers);
  return layers;
}

export function composeLayers(scene, phase, fragments) {
  return scene.layers.filter(layer => layer.phases.includes(phase))
    .map(layer => {
      const fragment = fragments[layer.id] ?? '';
      if (layer.visible === false || layer.opacity === 0) return '';
      return !fragment || layer.opacity === undefined || layer.opacity === 1 ? fragment : `<g data-scene-layer="${layer.id}" opacity="${layer.opacity}">${fragment}</g>`;
    }).join('');
}

export function selectionForScene(scene) {
  return scene.layers.some(layer => layer.id === 'selection' && layer.visible !== false) ? scene.presentation.options.selection : undefined;
}
