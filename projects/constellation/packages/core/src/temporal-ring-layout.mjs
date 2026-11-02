import { identityGeometry, identityPoints } from './engine.mjs';
import { validateRingPlacements } from './temporal-geometry.mjs';

export function temporalRingLayout(seed, nodes, options, anchors) {
  const explicit = validateRingPlacements(options.ringPlacements);
  const geometry = identityGeometry(seed), radii = Array.from({ length: 4 }, (_, i) => geometry[2 + i * 22]);
  const requested = Object.values(explicit).reduce((max, p) => Math.max(max, (p.point + 1) * 4), 24);
  const count = Math.min(2048, Math.max(nodes.length, requested));
  const coordinates = identityPoints(seed, count, options.ringRotations || Array(4).fill(options.ringRotation || 0));
  const counts = [0, 0, 0, 0];
  const points = Array.from({ length: count }, (_, i) => {
    const x = coordinates[i * 3] - 240, y = coordinates[i * 3 + 1] - 240, radius = Math.hypot(x, y);
    const ring = radii.reduce((best, r, j) => Math.abs(radius - r) < Math.abs(radius - radii[best]) ? j : best, 0);
    return { ring, point: counts[ring]++, angle: Math.atan2(y, x), x: 450 + x * 368 / 172, y: 270 + y * 192 / 172 };
  });
  const byId = new Map(points.map(p => [`${p.ring}:${p.point}`, p])), placements = {}, occupied = new Set();
  const ringMode = options.innerArrangement === 'rings';
  // Explicit semantic placements take precedence and reserve their slots first.
  for (const node of nodes) if (explicit[node.id]) {
    const p = byId.get(`${explicit[node.id].ring}:${explicit[node.id].point}`);
    if (!p) throw new Error('Requested ring point exceeds the identity point capacity.');
    const key = `${p.ring}:${p.point}`;
    if (occupied.has(key)) throw new Error('Two projects cannot occupy the same temporal ring point.');
    occupied.add(key); placements[node.id] = { ring: p.ring, point: p.point }; anchors[node.id] = { x: p.x, y: p.y };
  }
  for (const node of nodes) {
    if (placements[node.id]) continue;
    const manual = options.starPositions?.[node.id];
    if (!ringMode && !options.snapToRings || manual && options.snapToRings === false) continue;
    const target = manual || anchors[node.id] || node.geometry;
    const p = points.filter(p => !occupied.has(`${p.ring}:${p.point}`)).sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y) || a.ring - b.ring || a.point - b.point)[0];
    if (!p) throw new Error('No free temporal identity point.');
    occupied.add(`${p.ring}:${p.point}`); placements[node.id] = { ring: p.ring, point: p.point }; anchors[node.id] = { x: p.x, y: p.y };
  }
  return { radii, points, placements, outerRadius: Math.max(...radii) };
}
