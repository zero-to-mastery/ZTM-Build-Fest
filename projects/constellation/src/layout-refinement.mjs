import { orbitSpreadX } from './orbit-shape.mjs';
import { refineLayout, identityPoints } from './engine.mjs';

export function layoutRefinementOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'intensity'].includes(key))) throw new Error('Invalid layoutRefinement settings.');
  const { enabled = false, intensity = 5 } = value;
  if (typeof enabled !== 'boolean' || !Number.isInteger(intensity) || intensity < 0 || intensity > 10) throw new Error('Layout refinement requires enabled (boolean) and intensity (integer 0–10).');
  return { enabled, intensity };
}

export function refineStars(stars, labels, options, { seed, height, centerY, spreadY }) {
  const settings = layoutRefinementOptions(options.layoutRefinement);
  if (!settings.enabled || settings.intensity === 0 || !stars.length) return;
  const hidden = new Set(options.hiddenNodes || []), hiddenLabels = new Set(options.hiddenLabels || []);
  const fixed = id => hidden.has(id) || hiddenLabels.has(id) || ['starPositions', 'labelPositions', 'labelOffsets'].some(key => Object.hasOwn(options[key] || {}, id));
  const raw = options.snapToRings ? identityPoints(seed, stars.length, options.ringRotations || Array(4).fill(options.ringRotation || 0)) : [];
  const anchors = options.snapToRings ? Array.from({ length: raw.length / 3 }, (_, i) => [450 + (raw[i * 3] - 240) * orbitSpreadX(options, spreadY) / 172, centerY + (raw[i * 3 + 1] - 240) * spreadY / 172]) : null;
  const nodes = stars.map(star => {
    const id = star.repo.full_name, label = labels.get(id);
    return { x: star.x, y: star.y, radius: star.radius, hidden: hidden.has(id), locked: fixed(id),
      label: label && !hiddenLabels.has(id) && options.visualStyle?.labels !== false
        ? [label.x - star.x - label.width / 2 - 4, label.y - star.y - label.size, label.x - star.x + label.width / 2 + 4, label.y - star.y + 3] : null };
  });
  const positions = refineLayout({ nodes, anchors, intensity: settings.intensity, height });
  stars.forEach((star, i) => {
    if (nodes[i].locked || nodes[i].hidden) return;
    const label = labels.get(star.repo.full_name);
    if (label) { label.x += positions[i][0] - star.x; label.y += positions[i][1] - star.y; }
    [star.x, star.y] = positions[i];
  });
}
