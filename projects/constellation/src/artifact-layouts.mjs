import { seededRandom } from './seeded-random.mjs';
import { compareRepositories } from './repository-filters.mjs';

export const artifactLayouts = ['galaxy', 'solar-system'];
// Feed deterministic positions into the existing Rust scene/relationship engine.
// Manual positions remain the final override, so dragging works in every layout.
// round: true circles, reaching as far sideways as up and down (see orbit-shape.mjs).
export function artifactPositions(nodes, mode, seed, compact = false, metric = 'stars', groupBy = node => !node.nodeKind || node.nodeKind === 'repository' ? node.language || 'Other' : node.nodeKind, round = false) {
  if (!artifactLayouts.includes(mode)) return {};
  const projects = nodes.filter(node => !node.nodeKind || node.nodeKind === 'repository');
  if (projects.length && projects.length !== nodes.length) {
    // Adding people or technologies leaves project anchors in place.
    const anchors = artifactPositions(projects, mode, seed, compact, metric, groupBy, round);
    return membershipPositions(nodes, anchors, seed, compact, round);
  }
  const ordered = [...nodes].sort((a, b) => compareRepositories(a, b, metric));
  const yCenter = compact ? 126 : 270, yScale = compact ? 78 : 185, xScale = round ? yScale : 365;
  const random = seededRandom(seed), phase = random() * Math.PI * 2;
  const result = {};
  if (mode === 'galaxy') {
    const groups = [...new Set(ordered.map(groupBy))].sort();
    for (const [groupIndex, group] of groups.entries()) {
      const members = ordered.filter(node => groupBy(node) === group);
      const angle = phase + groupIndex * Math.PI * 2 / groups.length;
      const cx = groups.length === 1 ? 0 : Math.cos(angle) * .6, cy = groups.length === 1 ? 0 : Math.sin(angle) * .6;
      members.forEach((node, i) => {
        const distance = Math.sqrt(i / Math.max(1, members.length)) * (groups.length === 1 ? .88 : .3);
        const theta = phase + i * 2.399963;
        result[node.full_name] = { x: 450 + xScale * (cx + Math.cos(theta) * distance), y: yCenter + yScale * (cy + Math.sin(theta) * distance) };
      });
    }
  } else {
    const majors = ordered.slice(0, Math.min(4, ordered.length));
    const satellites = new Map(majors.map(node => [node.full_name, []]));
    for (const node of ordered.slice(majors.length)) {
      const major = [...majors].sort((a, b) => affinity(node, b) - affinity(node, a) || compareRepositories(a, b, metric))[0];
      satellites.get(major.full_name).push(node);
    }
    majors.forEach((node, i) => {
      const angle = phase + i * Math.PI * 2 / majors.length;
      const cx = majors.length === 1 ? 0 : Math.cos(angle) * .55, cy = majors.length === 1 ? 0 : Math.sin(angle) * .55;
      result[node.full_name] = { x: 450 + cx * xScale, y: yCenter + cy * yScale };
      const members = satellites.get(node.full_name);
      members.forEach((child, j) => {
        const theta = j * 2.399963 + phase, radius = .1 + .24 * Math.sqrt((j + 1) / members.length);
        result[child.full_name] = { x: 450 + (cx + Math.cos(theta) * radius) * xScale, y: yCenter + (cy + Math.sin(theta) * radius) * yScale };
      });
    });
  }
  return result;
}
export function membershipPositions(nodes, anchors, seed, compact = false, round = false) {
  const result = { ...anchors }, occupied = Object.values(anchors);
  const centerY = compact ? 126 : 270, height = compact ? 220 : 500;
  // Technologies precede people so the shared language map stays recognizable.
  const layer = { language: 0, topic: 1, dependency: 2, contributor: 3, era: 4 };
  const additional = nodes.filter(node => !anchors[node.full_name]).sort((a, b) => (layer[a.nodeKind] ?? 5) - (layer[b.nodeKind] ?? 5) || a.full_name.localeCompare(b.full_name));
  for (const node of additional) {
    const linked = (node.members || []).map(id => anchors[id]).filter(Boolean);
    const phase = seededRandom(`${seed}:${node.full_name}`)() * Math.PI * 2;
    const center = linked.length ? {
      x: linked.reduce((sum, p) => sum + p.x, 0) / linked.length,
      y: linked.reduce((sum, p) => sum + p.y, 0) / linked.length,
    } : { x: 450 + Math.cos(phase) * (round ? (compact ? 75 : 180) : 330), y: centerY + Math.sin(phase) * (compact ? 75 : 180) };
    let best, bestDistance = -1;
    for (let attempt = 0; attempt < 80; attempt++) {
      const angle = phase + attempt * 2.399963, radius = (compact ? 16 : 24) + Math.sqrt(attempt) * (compact ? 5 : 8);
      const point = { x: Math.max(38, Math.min(862, center.x + Math.cos(angle) * radius)), y: Math.max(35, Math.min(height - 12, center.y + Math.sin(angle) * radius)) };
      const distance = occupied.reduce((minimum, other) => Math.min(minimum, Math.hypot(point.x - other.x, point.y - other.y)), Infinity);
      if (distance > bestDistance) { best = point; bestDistance = distance; }
      if (distance >= (compact ? 16 : 23)) break;
    }
    result[node.full_name] = best; occupied.push(best);
  }
  return result;
}
function affinity(a, b) {
  return Number(Boolean(a.language) && a.language === b.language) + (a.topics || []).filter(topic => b.topics?.includes(topic)).length + Number(a.members?.includes(b.full_name) || b.members?.includes(a.full_name));
}
