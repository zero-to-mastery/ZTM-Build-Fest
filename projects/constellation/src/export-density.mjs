const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const README_GROUP_THRESHOLD = 30;

/** Deterministic, export-only density defaults for compact README graphics. */
export function exportDensityPolicy({ profile, width = 900, nodeCount = 0, groupCount = 0 } = {}) {
  const readme = profile === 'readme';
  const safeWidth = Number.isFinite(width) ? clamp(width, 320, 2400) : 900;
  const widthFactor = clamp((safeWidth - 600) / 300, 0, 1);
  const labelBudget = Math.floor(18 + widthFactor * 18);
  const maxLabels = Math.min(nodeCount, labelBudget);
  return {
    enabled: readme,
    width: safeWidth,
    maxLabels,
    groupLabelBudget: Math.min(groupCount, labelBudget),
    groupRadiusRange: [12, 22],
    projectRadiusRange: [2.8, 4.2],
    edgeWidthRange: [0.65, 2.2],
    edgeOpacityRange: [0.22, 0.68],
    padding: 18,
    groupLabelPriority: 0,
    focusedLabelPriority: 1,
    showcaseLabelPriority: 2,
    projectLabelPriority: 3,
  };
}

export function groupRadius(memberCount, [min, max] = [12, 22]) {
  const count = Number.isFinite(memberCount) ? Math.max(1, memberCount) : 1;
  return Number(clamp(min + Math.log2(count) * 2.1, min, max).toFixed(2));
}

export function aggregateEdgeStyle(relationshipCount, widthRange = [0.65, 2.2], opacityRange = [0.22, 0.68]) {
  const count = Number.isFinite(relationshipCount) ? Math.max(1, relationshipCount) : 1;
  const factor = clamp(Math.log2(count) / 10, 0, 1);
  return {
    width: Number((widthRange[0] + (widthRange[1] - widthRange[0]) * factor).toFixed(2)),
    opacity: Number((opacityRange[0] + (opacityRange[1] - opacityRange[0]) * factor).toFixed(2)),
  };
}

function labelPriority(node, options, graph, policy) {
  if (node.metadata?.nodeKind === 'semantic-group') return { rank: policy.groupLabelPriority, order: -(node.metadata.memberCount || 0) };
  const id = node.id;
  if (graph?.focus === id || options.selection === id || options.selection?.node === id) return { rank: policy.focusedLabelPriority, order: 0 };
  const role = options.projectShowcase?.[id] || options.projectShowcase?.[node.metadata?.name];
  if (role?.role) return { rank: policy.showcaseLabelPriority, order: (role.priority ?? 9999) * 4 + ({ featured: 0, supporting: 1, experimental: 2, historical: 3 }[role.role] ?? 4) };
  return { rank: policy.projectLabelPriority, order: 0 };
}

function labelBounds(label) {
  const width = Math.max(12, Array.from(label.text || '').length * 5.7 + 8);
  return { left: label.x - width / 2, right: label.x + width / 2, top: label.y - 10, bottom: label.y + 3 };
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Prioritize and suppress static labels in near-linear time using a spatial grid. */
export function prioritizeExportLabels(scene, policy) {
  const nodes = new Map(scene.nodes.map(node => [node.id, node]));
  const candidates = scene.labels.map((label, index) => {
    const node = nodes.get(label.id);
    if (!node || node.interaction.hidden || node.interaction.labelHidden || label.hidden) { label.hidden = true; return null; }
    const priority = labelPriority(node || {}, scene.presentation.options || {}, scene.presentation.graph, policy);
    return { label, index, priority, bounds: labelBounds(label) };
  }).filter(Boolean).sort((a, b) => a.priority.rank - b.priority.rank || a.priority.order - b.priority.order
    || String(a.label.id).localeCompare(String(b.label.id)) || a.index - b.index);
  const accepted = [], grid = new Map(), seenText = new Set();
  let acceptedGroupCount = 0;
  const cellSize = 64;
  for (const candidate of candidates) {
    const { label, bounds } = candidate;
    const node = nodes.get(label.id);
    const isGroup = node?.metadata?.nodeKind === 'semantic-group';
    const textKey = String(label.text).toLocaleLowerCase('en-US');
    let collision = seenText.has(textKey);
    const x0 = Math.floor(bounds.left / cellSize), x1 = Math.floor(bounds.right / cellSize);
    const y0 = Math.floor(bounds.top / cellSize), y1 = Math.floor(bounds.bottom / cellSize);
    if (!collision) for (let x = x0; x <= x1 && !collision; x++) for (let y = y0; y <= y1 && !collision; y++) {
      for (const other of grid.get(`${x}:${y}`) || []) if (overlaps(bounds, other)) { collision = true; break; }
    }
    const underCap = accepted.length < policy.maxLabels;
    const keep = underCap && !collision && (!isGroup || acceptedGroupCount < policy.groupLabelBudget);
    label.hidden = !keep;
    if (!keep) continue;
    accepted.push(label.id);
    if (isGroup) acceptedGroupCount++;
    seenText.add(textKey);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x}:${y}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(bounds);
    }
  }
  return { labels: scene.labels, visibleIds: accepted };
}

function stableDirection(a, b) {
  let hash = 2166136261;
  for (const char of `${a}\0${b}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const angle = (hash / 0x100000000) * Math.PI * 2;
  return [Math.cos(angle), Math.sin(angle)];
}

/** Small bounded separation pass over semantic groups only (at most 256 nodes). */
export function separateStaticGroups(scene, policy) {
  const groups = scene.nodes.filter(node => node.metadata?.nodeKind === 'semantic-group');
  if (groups.length < 2) return;
  const box = scene.viewport.viewBox;
  const bounds = { left: box[0] + policy.padding + 56, top: box[1] + policy.padding, right: box[0] + box[2] - policy.padding - 56, bottom: box[1] + box[3] - policy.padding };
  const labels = new Map(scene.labels.map(label => [label.id, label]));
  for (let iteration = 0; iteration < 10; iteration++) {
    const moves = new Map(groups.map(node => [node.id, [0, 0]]));
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j];
      let dx = b.geometry.x - a.geometry.x, dy = b.geometry.y - a.geometry.y;
      let distance = Math.hypot(dx, dy);
      const labelA = labels.get(a.id)?.text || a.metadata.name;
      const labelB = labels.get(b.id)?.text || b.metadata.name;
      const required = Math.min(112, Math.max(54, (Array.from(labelA).length + Array.from(labelB).length) * 2.65 + a.geometry.radius + b.geometry.radius));
      if (distance >= required) continue;
      if (distance < 0.01) { [dx, dy] = stableDirection(a.id, b.id); distance = 1; }
      const force = Math.min(5, (required - distance) * 0.12);
      const mx = dx / distance * force, my = dy / distance * force;
      moves.get(a.id)[0] -= mx; moves.get(a.id)[1] -= my;
      moves.get(b.id)[0] += mx; moves.get(b.id)[1] += my;
    }
    for (const node of groups) {
      const [dx, dy] = moves.get(node.id);
      node.geometry.x = Number(Math.max(bounds.left, Math.min(bounds.right, node.geometry.x + dx)).toFixed(2));
      node.geometry.y = Number(Math.max(bounds.top, Math.min(bounds.bottom, node.geometry.y + dy)).toFixed(2));
    }
  }
  const groupById = new Map(groups.map(node => [node.id, node]));
  for (const label of scene.labels) {
    const node = groupById.get(label.id);
    if (node) { label.x = node.geometry.x; label.y = node.geometry.y + node.geometry.radius + 8; }
  }
  const nodeById = new Map(scene.nodes.map(node => [node.id, node]));
  for (const edge of scene.edges) {
    const from = nodeById.get(edge.from), to = nodeById.get(edge.to);
    if (from && to) edge.geometry.distance = Math.hypot(from.geometry.x - to.geometry.x, from.geometry.y - to.geometry.y);
  }
}

export function applyStaticExportDensity(scene, policy) {
  if (!policy.enabled || scene.semanticGroups?.level !== 'groups') return scene;
  const output = structuredClone(scene);
  for (const node of output.nodes) {
    if (node.metadata.nodeKind === 'semantic-group') node.geometry.radius = groupRadius(node.metadata.memberCount, policy.groupRadiusRange);
    else node.geometry.radius = Math.max(policy.projectRadiusRange[0], Math.min(policy.projectRadiusRange[1], node.geometry.radius));
  }
  separateStaticGroups(output, policy);
  prioritizeExportLabels(output, policy);
  return output;
}
