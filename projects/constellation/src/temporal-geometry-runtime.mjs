import { temporalGeometryDrawing } from './temporal-geometry-drawing.mjs';

export function applyTemporalGeometryDrawing(svg, scene, view) {
  const drawing = temporalGeometryDrawing(scene, view), world = svg.querySelector('[data-temporal-world]');
  const elements = new Map([...svg.querySelectorAll('[data-geometry-key]')].map(node => [node.dataset.geometryKey, node]));
  const live = new Set(), ordered = [];
  const set = (element, name, value) => { if (element.getAttribute(name) !== String(value)) element.setAttribute(name, value); };
  for (const item of drawing.items) {
    live.add(item.key);
    let element = elements.get(item.key);
    if (!element) {
      element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      element.dataset.geometryKey = item.key; element.dataset.geometricGuide = '';
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('class', item.kind === 'surface' ? 'temporal-surface' : 'temporal-mesh');
    }
    set(element, 'data-base-opacity', item.opacity);
    set(element, 'opacity', item.opacity); set(element, 'data-camera-depth', item.depth);
    if (element.hasAttribute('data-rear') !== (item.rear === true)) element.toggleAttribute('data-rear', item.rear === true);
    if (item.kind === 'dust') {
      // Decorative world dust is not projected as a repository/year vertex.
      if (item.afterLabels) continue;
    } else if (item.kind === 'node') {
      const { x, y } = item.node.geometry, { scale } = item.point;
      element.setAttribute('transform', `matrix(${scale} 0 0 ${scale} ${item.point.x - x * scale} ${item.point.y - y * scale})`);
    } else element.setAttribute('d', item.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('') + (item.kind === 'surface' ? 'Z' : ''));
    ordered.push(element);
  }
  for (const element of [...world.children]) if (!live.has(element.dataset.geometryKey)) element.remove();
  // Keep DOM identity and avoid moving elements already in painter order.
  let cursor = world.firstChild;
  for (const element of ordered) {
    if (element === cursor) cursor = cursor.nextSibling;
    else world.insertBefore(element, cursor);
  }
  for (const item of drawing.labels) {
    const label = elements.get(item.key);
    label.setAttribute('transform', `translate(${item.x - item.label.x} ${item.y - item.label.y})`);
    label.dataset.baseOpacity = item.opacity; label.setAttribute('opacity', item.opacity);
  }
  for (const item of drawing.years) {
    const label = [...svg.querySelectorAll('[data-layer-label]')].find(label => label.dataset.layerId === String(item.layerId));
    label.dataset.baseOpacity = '1'; label.setAttribute('opacity', '1');
    label.setAttribute('transform', `translate(${item.x} ${item.y})`);
  }
  svg.dataset.temporalForm = drawing.profile.shape;
  const [x, y, width, height] = drawing.viewBox;
  if (view?.fitBackdrop === false) return drawing;
  const backdrop = svg.querySelector('[data-starfield-backdrop]');
  if (backdrop) set(backdrop, 'transform', `translate(${x} ${y}) scale(${width / 900} ${height / 560})`);
  const background = svg.querySelector('.background');
  if (background) for (const [name, value] of Object.entries({ x, y, width, height })) set(background, name, value);
  return drawing;
}
