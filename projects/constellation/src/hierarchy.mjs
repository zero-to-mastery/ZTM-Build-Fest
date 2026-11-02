import { createScene } from './constellation.mjs';
import { assertScene } from './scene.mjs';
import { validateHierarchy, HIERARCHY_VERSION } from './hierarchy-model.mjs';

export function createHierarchy(definition, runtime = {}) {
  if (!definition || typeof definition !== 'object' || !Array.isArray(definition.scenes) || definition.scenes.length > 64) throw new Error('Hierarchy requires scene definitions.');
  const scenes = definition.scenes.map(entry => {
    runtime.signal?.throwIfAborted();
    if (!entry || entry.definition?.options?.hierarchy !== undefined) throw new Error('Use child references instead of nested hierarchy definitions.');
    const scene = entry.scene ? structuredClone(assertScene(entry.scene)) : entry.definition && createScene(entry.definition.account, entry.definition.records, entry.definition.options, runtime);
    if (!scene || scene.kind !== 'scene' || scene.hierarchy) throw new Error('Hierarchy entries need a compiled scene or declarative scene definition.');
    for (const link of entry.links || []) {
      const node = scene.nodes.find(node => node.id === link.nodeId);
      if (!node || node.interaction.childScene !== undefined) throw new Error(`Missing or duplicate hierarchy node link: ${link.nodeId}`);
      node.interaction.childScene = link.target;
      for (const frame of scene.timeline?.frames || []) {
        const member = frame.scene.nodes.find(node => node.id === link.nodeId);
        if (member) member.interaction.childScene = link.target;
      }
    }
    return { id: entry.id, title: entry.title || entry.id, scene };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const hierarchy = validateHierarchy({ version: HIERARCHY_VERSION, root: definition.root, scenes }, assertScene);
  return { ...structuredClone(scenes.find(entry => entry.id === hierarchy.root).scene), hierarchy };
}
