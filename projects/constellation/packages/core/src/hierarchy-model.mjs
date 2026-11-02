export const HIERARCHY_VERSION = 1;
export function validateHierarchy(hierarchy, validateScene) {
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
  if (!hierarchy || hierarchy.version !== HIERARCHY_VERSION || !id(hierarchy.root) || !Array.isArray(hierarchy.scenes) || hierarchy.scenes.length < 1 || hierarchy.scenes.length > 64) throw new Error('Hierarchy requires a root and 1–64 scenes.');
  const scenes = new Map(); let nodes = 0;
  for (const entry of hierarchy.scenes) {
    if (!id(entry.id) || scenes.has(entry.id) || typeof entry.title !== 'string' || entry.title.length > 200 || entry.scene?.kind !== 'scene' || entry.scene.hierarchy !== undefined || entry.scene.story !== undefined) throw new Error('Invalid or duplicate hierarchy scene.');
    validateScene?.(entry.scene); scenes.set(entry.id, entry);
    nodes += entry.scene.nodes.length + (entry.scene.timeline?.frames.reduce((sum, frame) => sum + frame.scene.nodes.length, 0) || 0);
    if (nodes > 16384) throw new Error('Hierarchy exceeds 16,384 aggregate nodes.');
  }
  if (!scenes.has(hierarchy.root)) throw new Error('Hierarchy root scene is missing.');
  const visiting = new Set(), depths = new Map();
  function visit(sceneId) {
    if (visiting.has(sceneId)) throw new Error('Hierarchy contains a cycle.');
    if (depths.has(sceneId)) return depths.get(sceneId);
    const entry = scenes.get(sceneId); if (!entry) throw new Error(`Missing child scene: ${sceneId}`);
    visiting.add(sceneId);
    let depth = 1;
    const allNodes = [...entry.scene.nodes, ...entry.scene.timeline?.frames.flatMap(frame => frame.scene.nodes) || []];
    for (const node of allNodes) if (node.interaction.childScene !== undefined) {
      if (!id(node.interaction.childScene)) throw new Error('Invalid child scene reference.');
      depth = Math.max(depth, 1 + visit(node.interaction.childScene));
    }
    if (depth > 16) throw new Error('Hierarchy exceeds 16 levels.');
    visiting.delete(sceneId); depths.set(sceneId, depth); return depth;
  }
  for (const sceneId of scenes.keys()) visit(sceneId);
  return hierarchy;
}
