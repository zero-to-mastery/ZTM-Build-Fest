import { mountTemporalRingEditor } from './temporal-ring-editor.mjs';
// Clamp the pair as a unit so a chart boundary never separates a label from its node.
export function movePair(origin, target, label, height) {
  const dx = label ? label.x - origin.x : 0;
  const dy = label ? label.y - origin.y : 0;
  const minX = label ? Math.max(32, 34 + label.halfWidth - dx) : 32;
  const maxX = label ? Math.min(868, 866 - label.halfWidth - dx) : 868;
  const minY = label ? Math.max(28, 28 - dy) : 28;
  const maxY = label ? Math.min(height - 60, height - 43 - dy) : height - 60;
  const star = { x: Number(Math.max(minX, Math.min(maxX, target.x)).toFixed(1)), y: Number(Math.max(minY, Math.min(maxY, target.y)).toFixed(1)) };
  return { star, label: label ? { x: Number((star.x + dx).toFixed(1)), y: Number((star.y + dy).toFixed(1)) } : null };
}

// Keep SVG styles (including custom CSS) isolated from the studio page.
export function snapPair(origin, target, label, height, points, id) {
  const candidates = points.filter(point => !point.occupied.some(owner => owner !== id))
    .map(point => ({ ...point, distance: Math.hypot(point.x - target.x, point.y - target.y) }))
    .sort((a, b) => a.distance - b.distance);
  for (const point of candidates) {
    const pair = movePair(origin, point, label, height);
    if (Math.abs(pair.star.x - point.x) < .05 && Math.abs(pair.star.y - point.y) < .05) return pair;
  }
  return { star: { ...origin }, label: label ? { x: label.x, y: label.y } : null };
}

export function mountLabelEditor(host, source, onMove, previewMove, locked = true, snapToRings = true) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const svg = document.importNode(new DOMParser().parseFromString(source, 'image/svg+xml').documentElement, true);
  if (svg.querySelector('.ring-motion-active') && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    svg.querySelectorAll('animate, animateTransform, .ring-motion-still').forEach(node => node.remove());
    svg.querySelector('.ring-motion-active').removeAttribute('class');
  }
  const style = document.createElement('style');
  style.textContent = ':host{display:block;width:100%;height:100%;min-height:0}svg{display:block;width:100%;height:100%}.draggable{cursor:grab;touch-action:none;user-select:none}.draggable[data-dragging]{cursor:grabbing}.repo-label:focus{outline:none;stroke:var(--sky-accent);stroke-width:.3}.repository:focus{outline:none}.repository:focus .star-halo{opacity:.35}.star-hit{fill:transparent;pointer-events:all}.repo-label:not(.draggable){pointer-events:none}';
  shadow.replaceChildren(style, svg);
  svg.setAttribute('role', 'group');
  if (locked) return;
  if (svg.querySelector('#temporal-geometry-data')) return mountTemporalRingEditor(svg, onMove, previewMove, snapToRings);
  const temporal = Boolean(svg.querySelector('[data-temporal-year]'));
  if (temporal) snapToRings = false;
  const ringPoints = [...svg.querySelectorAll('.identity-point')].map(point => ({
    x: Number(point.dataset.snapX), y: Number(point.dataset.snapY), occupied: JSON.parse(point.dataset.occupied || '[]'),
  }));
  const labels = new Map([...svg.querySelectorAll('.repo-label')].map(node => [node.dataset.repo, node]));
  const positions = Object.fromEntries([...labels].map(([id, label]) => [id, { x: Number(label.getAttribute('x')), y: Number(label.getAttribute('y')) }]));
  const offsets = Object.fromEntries([...svg.querySelectorAll('.star')].filter(star => labels.has(star.dataset.repo)).map(star => {
    const id = star.dataset.repo;
    return [id, { x: Number((positions[id].x - Number(star.getAttribute('cx'))).toFixed(1)), y: Number((positions[id].y - Number(star.getAttribute('cy'))).toFixed(1)) }];
  }));
  const originals = new Map([...svg.querySelectorAll('.repository')].map(group => {
    const star = group.querySelector('.star');
    return [star.dataset.repo, { group, x: Number(star.getAttribute('cx')), y: Number(star.getAttribute('cy')) }];
  }));
  const availablePoints = ringPoints.filter(point => point.occupied.every(owner => originals.has(owner)));
  const point = event => {
    const matrix = (event.currentTarget?.closest('[data-temporal-year]') || svg.querySelector('.perspective-scene') || svg).getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
  };
  for (const group of svg.querySelectorAll('.repository')) {
    const star = group.querySelector('.star');
    const id = star.dataset.repo;
    const label = labels.get(id);
    const origin = { x: Number(star.getAttribute('cx')), y: Number(star.getAttribute('cy')) };
    const anchor = label ? { ...positions[id], halfWidth: label.textContent.length * 2.8 } : null;
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.setAttribute('class', 'star-hit');
    hit.setAttribute('cx', origin.x); hit.setAttribute('cy', origin.y); hit.setAttribute('r', '12'); group.append(hit);
    let current = { star: origin, offsets };
    const move = (target, cancel = false) => {
      const height = svg.viewBox.baseVal.height;
      const candidates = availablePoints.map(point => ({ ...point, occupied: [] }));
      const pair = snapToRings && !cancel ? snapPair(origin, target, anchor, height, candidates, id) : movePair(origin, target, anchor, height);
      const placements = {};
      if (snapToRings && !cancel) {
        const destination = availablePoints.find(point => Math.hypot(point.x - pair.star.x, point.y - pair.star.y) < .1);
        const displaced = destination?.occupied.filter(owner => owner !== id) || [];
        // A vacated source point receives the other node; off-ring layouts use the nearest free point.
        const free = availablePoints.filter(point => point !== destination && point.occupied.every(owner => owner === id))
          .sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y));
        if (displaced.length && !free.length) return;
        for (const owner of displaced) placements[owner] = { x: free[0].x, y: free[0].y };
      }
      current = { star: pair.star, offsets, placements };
      for (const [owner, original] of originals) {
        const position = owner === id ? pair.star : placements[owner] || original;
        for (const circle of original.group.querySelectorAll('circle')) {
          circle.setAttribute('cx', position.x.toFixed(1)); circle.setAttribute('cy', position.y.toFixed(1));
        }
        const nodeLabel = labels.get(owner);
        if (nodeLabel) {
          nodeLabel.setAttribute('x', (position.x + offsets[owner].x).toFixed(1));
          nodeLabel.setAttribute('y', (position.y + offsets[owner].y).toFixed(1));
        }
      }
      const updated = new DOMParser().parseFromString(previewMove(id, current), 'image/svg+xml');
      if (temporal) {
        for (const selector of ['.repository', '.star', '.temporal-birth', '.repo-label', '.shared-language', '.temporal-bridge']) {
          const next = [...updated.querySelectorAll(selector)];
          [...svg.querySelectorAll(selector)].forEach((node, index) => {
            for (const attribute of ['cx', 'cy', 'x', 'y', 'd', 'transform']) if (next[index]?.hasAttribute(attribute)) node.setAttribute(attribute, next[index].getAttribute(attribute));
          });
        }
        return;
      }
      for (const selector of ['.connections', '.bridges']) {
        svg.querySelector(selector).replaceChildren(...[...updated.querySelector(selector).childNodes].map(node => document.importNode(node, true)));
      }
    };
    for (const handle of [group, label].filter(Boolean)) {
      handle.classList.add('draggable');
      handle.setAttribute('tabindex', '0'); handle.setAttribute('role', 'button');
      handle.setAttribute('aria-label', `Move ${star.dataset.label || id} and its label together. Drag or use arrow keys; Shift moves faster.`);
      let drag, suppressClick = false;
      handle.addEventListener('click', event => {
        if (suppressClick) { suppressClick = false; event.stopImmediatePropagation(); }
      });
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        const start = point(event); if (!start) return;
        event.preventDefault(); suppressClick = false; handle.focus();
        drag = { id: event.pointerId, start };
        handle.setPointerCapture(event.pointerId); handle.dataset.dragging = '';
      });
      handle.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        const next = point(event);
        if (next) move({ x: origin.x + next.x - drag.start.x, y: origin.y + next.y - drag.start.y });
      });
      const finish = event => {
        if (drag?.id !== event.pointerId) return;
        const cancelled = event.type === 'pointercancel';


        const changed = current.star.x !== origin.x || current.star.y !== origin.y;
        if (cancelled) move(origin, true);
        drag = null; delete handle.dataset.dragging; suppressClick = changed;
        if (changed && !cancelled) onMove(id, current, handle === label ? 'label' : 'star');
      };
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
      handle.addEventListener('keydown', event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault(); const step = event.shiftKey ? 10 : 1;
        const directional = snapToRings ? availablePoints.filter(point => (point.x - current.star.x) * delta[0] + (point.y - current.star.y) * delta[1] > .1)
          .sort((a, b) => Math.hypot(a.x - current.star.x, a.y - current.star.y) - Math.hypot(b.x - current.star.x, b.y - current.star.y))[0] : null;
        if (snapToRings && !directional) return;
        move(directional || { x: current.star.x + delta[0] * step, y: current.star.y + delta[1] * step });
        onMove(id, current, handle === label ? 'label' : 'star');
      });
    }
  }
}
