// Scene-to-diagnostic adapter shared by candidate analysis and static SVG.
// Text width is an estimate; actual browser geometry is tested separately.
export function sceneClarityInput(scene, { targetWidth } = {}) {
  const [originX = 0, originY = 0, viewWidth = 900, viewHeight = 560] = scene.viewport.viewBox || [];
  const baseWidth = Number(scene.viewport.width) || viewWidth;
  const baseHeight = Number(scene.viewport.height) || viewHeight;
  const width = Number.isFinite(targetWidth) && targetWidth > 0 ? targetWidth : baseWidth;
  const scale = width / baseWidth;
  const fontScale = width < 600 ? 900 / width : 1;
  const height = baseHeight * scale;
  const isProject = node => node.metadata?.nodeKind === 'repository' || (node.metadata?.full_name && !node.metadata?.nodeKind);
  const nodeById = new Map(scene.nodes.filter(isProject).map(node => [node.id, node]));
  const showcase = scene.presentation.options.projectShowcase || {};
  const projects = [...nodeById.values()].map(node => {
    const role = showcase[node.id]?.role || '';
    return {
      id: node.id, role,
      x: (Number(node.geometry.x) - originX) * scale,
      y: (Number(node.geometry.y) - originY) * scale,
      radius: (Number(node.geometry.radius) || 0) * scale,
      prominence: (Number(node.geometry.radius) || 0) * scale,
      manualPosition: Object.hasOwn(scene.presentation.options.starPositions || {}, node.id),
    };
  });
  const labels = (scene.labels || []).filter(label => nodeById.has(label.id)).map(label => {
    const text = String(label.text || ''), role = showcase[label.id]?.role;
    const size = (role === 'featured' ? 13 : role === 'supporting' ? 11 : 10) * fontScale * scale;
    const estimatedWidth = Math.min(width * 0.8, Math.max(12 * scale, [...text].length * size * 0.58));
    const x = (Number(label.x) - originX) * scale, y = (Number(label.y) - originY) * scale;
    return {
      id: `label:${label.id}`, projectId: label.id, text,
      bounds: { x: x - estimatedWidth / 2, y: y - size, width: estimatedWidth, height: size + 2 * scale },
      priority: role === 'featured' ? 3 : role === 'supporting' ? 2 : 1,
      visible: !label.hidden,
      manualPosition: Object.hasOwn(scene.presentation.options.labelPositions || {}, label.id),
    };
  });
  const relationships = (scene.edges || []).filter(edge => nodeById.has(edge.from) && nodeById.has(edge.to)).map(edge => ({
    id: edge.metadata?.key || edge.id, from: edge.from, to: edge.to,
    kind: edge.metadata?.relationshipType || edge.metadata?.semanticType || 'shared-metadata',
    style: edge.metadata?.relationshipType || edge.metadata?.semanticType || 'shared-metadata',
    evidence: edge.metadata?.relationshipEvidence || [],
  }));
  const groups = (scene.semanticGroups?.groups || []).map(group => ({ id: group.id, projectIds: group.members || [] }));
  return { width, height, projects, labels, relationships, groups, manualLayout: false };
}
