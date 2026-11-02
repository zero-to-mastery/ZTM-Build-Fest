import { temporalGeometryMath } from './temporal-geometry.mjs';
import { temporalMotion } from './temporal-motion.mjs';

// Renderer-independent drawing commands. Camera motion only rebuilds these
// projections of precomputed scenes; canonical anchors and Rust layouts stay put.
export function temporalGeometryDrawing(scene, view = {}) {
  const stack = scene.temporalStack, geometry = stack.geometry;
  const profile = { ...geometry.profile, ...(view.shape ? { shape: view.shape } : {}), ...(view.twist !== undefined ? { twist: view.twist } : {}), ...(view.surface ? { surface: view.surface } : {}) };
  const motion = temporalMotion(scene.presentation.options, view.elapsed ?? 0);
  const camera = temporalGeometryMath.camera(profile, stack.settings, { ...view, rotation: (view.rotation ?? 0) + motion.camera });
  const frames = new Map((stack.frames || scene.timeline.frames).map(frame => [frame.id, frame]));
  const frameNodes = new Map((stack.frames || scene.timeline.frames).map(frame => [frame.id, new Map(frame.scene.nodes.map(node => [node.id, node]))]));
  const planes = stack.layers.map((layer, index) => ({ ...layer, layerId: layer.id ?? layer.year, label: layer.label ?? String(layer.year), ...temporalGeometryMath.plane(profile, index, stack.layers.length, view.depth ?? 1) }));
  const byYear = new Map(planes.map(plane => [plane.layerId, plane]));
  const projectors = new Map();
  const project = (local, plane) => {
    if (!projectors.has(plane.t)) projectors.set(plane.t, temporalGeometryMath.projector(plane, profile, geometry.outerRadius, camera));
    return projectors.get(plane.t)(local);
  };
  const localRing = (radius, angle) => ({ x: 450 + Math.cos(angle) * radius * 368 / 172, y: 270 + Math.sin(angle) * radius * 192 / 172 });
  const visible = id => scene.layers.find(layer => layer.id === id)?.visible !== false && (id !== 'rings' || scene.presentation.options.identityRing !== false);
  const opacity = id => scene.layers.find(layer => layer.id === id)?.opacity ?? 1;
  const items = [], labels = [], years = [], positions = new Map(), first = new Map();
  const line = (key, kind, a, b, extra = {}) => items.push({ key, kind, points: [a, b], depth: (a.depth + b.depth) / 2, ...extra });
  for (const plane of [...planes].reverse()) for (const node of frames.get(plane.frameId).scene.nodes) if (!first.has(node.id)) first.set(node.id, plane.layerId);
  for (const [index, plane] of planes.entries()) {
    const frame = frames.get(plane.frameId), nodes = new Map(frame.scene.nodes.map(node => [node.id, node]));
    const center = project({ x: 450, y: 270 }, plane), emphasis = Math.max(.6, 1 - index * .035);
    const outerPoints = [];
    for (let ring = 0; ring < 4; ring++) {
      for (let segment = 0; segment < 48; segment++) {
        const a = project(localRing(geometry.radii[ring], segment * Math.PI / 24), plane), b = project(localRing(geometry.radii[ring], (segment + 1) * Math.PI / 24), plane);
        const rear = (a.depth + b.depth) / 2 < center.depth;
        if (ring === 3) outerPoints.push(a);
        if (visible('rings')) line(`ring:${index}:${ring}:${segment}`, 'ring', a, b, { layerId: plane.layerId, year: plane.year, ring, rear, opacity: opacity('rings') * (rear ? .12 : .42) * emphasis });
      }
    }
    const evidence = stack.axis !== 'year' ? 'Current repository membership' : frame.evidence === 'current-metadata' ? 'Current-metadata retrospective view' : frame.evidence === 'snapshot' ? `Snapshot · ${frame.date.slice(0, 10)}` : 'Current';
    years.push({ layerId: plane.layerId, year: plane.year, label: plane.label, evidence, x: Math.min(...outerPoints.map(p => p.x)) - 18, y: center.y, depth: center.depth });
    for (const node of frame.scene.nodes) {
      const point = project(motion.local(node.geometry, geometry.placements[node.id]), plane), key = `${plane.layerId}::${node.id}`;
      positions.set(key, point);
      if (node.interaction.hidden || !visible('nodes')) continue;
      items.push({ key: `node:${key}`, kind: 'node', node, point, layerId: plane.layerId, year: plane.year, depth: point.depth, opacity: emphasis * opacity('nodes') * (node.style.opacity ?? 1), birth: stack.axis === 'year' && first.get(node.id) === plane.layerId, placement: geometry.placements[node.id] });
    }
    if (visible('connections')) for (const [edgeIndex, edge] of frame.scene.edges.entries()) {
      if (nodes.get(edge.from).interaction.hidden || nodes.get(edge.to).interaction.hidden) continue;
      line(`edge:${index}:${edgeIndex}`, 'relationship', positions.get(`${plane.layerId}::${edge.from}`), positions.get(`${plane.layerId}::${edge.to}`), { layerId: plane.layerId, year: plane.year, from: edge.from, to: edge.to, opacity: opacity('connections') * emphasis * .35 });
    }
    if (visible('labels')) for (const label of frame.scene.labels) {
      if (label.hidden || nodes.get(label.id).interaction.hidden) continue;
      // Keep label offsets in readable screen units rather than foreshortening text.
      const node = nodes.get(label.id), p = positions.get(`${plane.layerId}::${label.id}`);
      labels.push({ key: `label:${plane.layerId}::${label.id}`, layerId: plane.layerId, year: plane.year, label, x: p.x + (label.x - node.geometry.x) * p.scale, y: p.y + (label.y - node.geometry.y) * p.scale, opacity: opacity('labels') * emphasis });
    }
  }
  if (visible('connections')) for (const bridge of stack.bridges) {
    const older = byYear.get((bridge.fromLayer ?? bridge.fromYear)), newer = byYear.get((bridge.toLayer ?? bridge.toYear));
    const old = frameNodes.get(older.frameId).get(bridge.nodeId), next = frameNodes.get(newer.frameId).get(bridge.nodeId);
    if (old.interaction.hidden || next.interaction.hidden) continue;
    const points = Array.from({ length: 9 }, (_, i) => project(motion.local({ x: old.geometry.x + (next.geometry.x - old.geometry.x) * i / 8, y: old.geometry.y + (next.geometry.y - old.geometry.y) * i / 8 }, geometry.placements[bridge.nodeId]), temporalGeometryMath.section(profile, older.t + (newer.t - older.t) * i / 8, view.depth ?? 1)));
    items.push({ key: `bridge:${(bridge.fromLayer ?? bridge.fromYear)}:${bridge.nodeId}`, kind: 'temporal', points, depth: points.reduce((sum, p) => sum + p.depth, 0) / points.length, ...bridge, opacity: opacity('connections') * .26 });
  }
  // Cap curved profiles with guide-only polar sections. No project is placed at
  // a zero-radius pole. Other shapes use their first/last actual cross-section.
  const sections = ['sphere', 'dome'].includes(profile.shape) ? [temporalGeometryMath.section(profile, 0, view.depth ?? 1), ...planes, temporalGeometryMath.section(profile, 1, view.depth ?? 1)] : planes;
  if (profile.surface !== 'off' && visible('rings')) {
    for (let index = 1; index < sections.length; index++) {
      const older = sections[index], newer = sections[index - 1];
      // The first six points on each Rust identity ring form a bounded mesh.
      for (const p of geometry.points.filter(p => p.point < 6)) for (let part = 0; part < 4; part++) {
        const a = temporalGeometryMath.section(profile, newer.t + (older.t - newer.t) * part / 4, view.depth ?? 1), b = temporalGeometryMath.section(profile, newer.t + (older.t - newer.t) * (part + 1) / 4, view.depth ?? 1);
        const local = motion.local(p, p);
        line(`mesh:${index}:${p.ring}:${p.point}:${part}`, 'mesh', project(local, a), project(local, b), { opacity: .09 * opacity('rings') });
      }
      if (profile.surface === 'translucent') for (let segment = 0; segment < 48; segment++) {
        const a = localRing(geometry.outerRadius, segment * Math.PI / 24), b = localRing(geometry.outerRadius, (segment + 1) * Math.PI / 24);
        const points = [project(a, newer), project(b, newer), project(b, older), project(a, older)];
        items.push({ key: `skin:${index}:${segment}`, kind: 'surface', points, depth: points.reduce((sum, p) => sum + p.depth, 0) / 4, opacity: .022 * opacity('rings') });
      }
    }
  }
  items.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  const bounds = items.flatMap(item => item.points || [item.point]).filter(Boolean);
  const left = Math.min(0, ...bounds.map(p => p.x - 70), ...years.map(p => p.x - 205)), top = Math.min(0, ...bounds.map(p => p.y - 100));
  const right = Math.max(1200, ...bounds.map(p => p.x + 70)), bottom = Math.max(1020, ...bounds.map(p => p.y + 100));
  // Classic dust contributes to the world phase, but has no temporal Z.
  // Insert at its logical layer boundary without re-sorting any 3D geometry.
  const starfield = scene.layers.find(layer => layer.id === 'starfield');
  if ((scene.presentation.options.starfield?.mode ?? 'classic') === 'classic' && starfield?.visible !== false && starfield?.opacity !== 0) {
    const layers = { ring: 'rings', mesh: 'rings', surface: 'rings', relationship: 'connections', temporal: 'connections', node: 'nodes' };
    const index = items.findIndex(item => scene.layers.find(layer => layer.id === layers[item.kind])?.order > starfield.order);
    const at = index < 0 ? items.length : index;
    items.splice(at, 0, { key: 'starfield:classic', kind: 'dust', depth: items[at]?.depth ?? items.at(-1)?.depth ?? 0, opacity: 1,
      afterLabels: starfield.order > scene.layers.find(layer => layer.id === 'labels').order });
  }
  return { profile, camera, planes, items, labels, years, viewBox: [left, top, right - left, bottom - top] };
}
