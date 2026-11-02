import { temporalGeometryMath } from './temporal-geometry.mjs';

export function mountTemporalRingEditor(svg, onMove, previewMove, snap) {
  // Connections can cross a star's center after depth sorting. They carry no
  // editor actions and must not intercept pointer events intended for nodes.
  for (const path of svg.querySelectorAll('.temporal-bridge,.shared-language')) path.style.pointerEvents = 'none';
  // Editing uses the stable final geometry rather than chasing moving targets.
  svg.pauseAnimations?.(); svg.setCurrentTime?.(0);
  const data = JSON.parse(svg.querySelector('#temporal-geometry-data').textContent);
  const geometry = data.geometry, profile = geometry.profile;
  const camera = temporalGeometryMath.camera(profile, data.settings);
  const slots = geometry.points;
  const occupied = new Map(Object.entries(geometry.placements).map(([id, p]) => [`${p.ring}:${p.point}`, id]));
  const key = p => `${p.ring}:${p.point}`;
  const targets = document.createElementNS('http://www.w3.org/2000/svg', 'g'); targets.setAttribute('class', 'temporal-snap-targets'); targets.setAttribute('aria-hidden', 'true'); targets.style.pointerEvents = 'none'; svg.append(targets);
  const showTargets = (year, plane) => {
    targets.replaceChildren(); svg.dataset.temporalActiveYear = year;
    if (!snap) return;
    for (const slot of slots) {
      const p = temporalGeometryMath.project(temporalGeometryMath.world(slot, plane, profile, geometry.outerRadius), camera);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'identity-point'); circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y); circle.setAttribute('r', occupied.has(key(slot)) ? '2' : '3');
      circle.setAttribute('fill', 'var(--sky-accent)'); circle.setAttribute('opacity', '.65'); circle.dataset.ring = slot.ring; circle.dataset.ringPoint = slot.point; circle.dataset.year = year;
      targets.append(circle);
    }
  };
  const restorePreview = markup => {
    const next = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const nodes = new Map([...next.querySelectorAll('[data-geometry-key]')].map(node => [node.dataset.geometryKey, node]));
    for (const node of svg.querySelectorAll('[data-geometry-key]')) {
      const updated = nodes.get(node.dataset.geometryKey); if (!updated) continue;
      for (const name of ['x', 'y', 'd', 'transform', 'data-ring', 'data-ring-point']) if (updated.hasAttribute(name)) node.setAttribute(name, updated.getAttribute(name));
      const circles = [...updated.querySelectorAll('circle')];
      [...node.querySelectorAll('circle:not(.star-hit):not(.explore-hit)')].forEach((circle, index) => {
        for (const name of ['cx', 'cy', 'r']) if (circles[index]) circle.setAttribute(name, circles[index].getAttribute(name));
      });
      for (const hit of node.querySelectorAll('.star-hit,.explore-hit')) for (const name of ['cx', 'cy']) hit.setAttribute(name, updated.querySelector('.star').getAttribute(name));
    }
  };
  for (const group of svg.querySelectorAll('.repository')) {
    const id = group.dataset.nodeId, year = group.dataset.layerId ?? group.dataset.year, star = group.querySelector('.star');
    const origin = { x: Number(star.getAttribute('cx')), y: Number(star.getAttribute('cy')) };
    const index = data.layers.findIndex(layer => String(layer.id ?? layer.year) === year);
    const plane = temporalGeometryMath.plane(profile, index, data.layers.length);
    const label = [...svg.querySelectorAll('.repo-label')].find(label => label.dataset.repo === id && (label.dataset.layerId ?? label.dataset.year) === year);
    const offsets = label ? { [id]: { x: Number(label.getAttribute('x')) - origin.x, y: Number(label.getAttribute('y')) - origin.y } } : {};
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.setAttribute('class', 'star-hit'); hit.setAttribute('cx', origin.x); hit.setAttribute('cy', origin.y); hit.setAttribute('r', '13'); group.append(hit);
    let current = { star: origin, offsets }, drag, suppress = false;
    const local = event => {
      const screen = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
      return temporalGeometryMath.unproject(screen, plane, profile, geometry.outerRadius, camera);
    };
    const move = target => {
      let destination = null, point = { x: Math.max(32, Math.min(868, target.x)), y: Math.max(28, Math.min(500, target.y)) };
      if (snap) destination = [...slots].sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y))[0];
      const placements = {}, ringPlacements = { ...geometry.placements, [id]: destination ? { ring: destination.ring, point: destination.point } : null };
      if (destination) {
        point = { x: destination.x, y: destination.y };
        const owner = occupied.get(key(destination));
        if (owner && owner !== id) {
          const source = slots.find(p => geometry.placements[id] && key(p) === key(geometry.placements[id])) || [...slots].filter(p => !occupied.has(key(p))).sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y))[0];
          if (!source) return;
          placements[owner] = { x: source.x, y: source.y }; ringPlacements[owner] = { ring: source.ring, point: source.point };
        }
      }
      current = { star: point, offsets, placements, ringPlacements };
      restorePreview(previewMove(id, current));
    };
    for (const handle of [group, label].filter(Boolean)) {
      handle.classList.add('draggable'); handle.setAttribute('tabindex', '0'); handle.setAttribute('role', 'button');
      handle.addEventListener('focus', () => showTargets(year, plane));
      handle.addEventListener('pointerenter', () => showTargets(year, plane));
      handle.setAttribute('aria-label', `${star.dataset.label || id}, ${year}. Move on this year's cross-section${snap ? '; snap to persistent identity-ring points' : ''}. Drag or use arrow keys.`);
      handle.addEventListener('click', event => { if (suppress) { suppress = false; event.stopImmediatePropagation(); } });
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        const start = local(event); if (!start) return;
        event.preventDefault(); event.stopPropagation(); handle.focus(); drag = { id: event.pointerId, start };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        const next = local(event); if (next) move({ x: origin.x + next.x - drag.start.x, y: origin.y + next.y - drag.start.y });
      });
      const finish = event => {
        if (drag?.id !== event.pointerId) return;
        const cancelled = event.type === 'pointercancel'; drag = null;
        if (cancelled) { restorePreview(previewMove(id, { star: origin, offsets })); return; }
        suppress = current.star.x !== origin.x || current.star.y !== origin.y;
        if (suppress) onMove(id, current, handle === label ? 'label' : 'star');
      };
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
      handle.addEventListener('keydown', event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        const next = snap ? [...slots].filter(p => (p.x - current.star.x) * delta[0] + (p.y - current.star.y) * delta[1] > .1).sort((a, b) => Math.hypot(a.x - current.star.x, a.y - current.star.y) - Math.hypot(b.x - current.star.x, b.y - current.star.y))[0] : { x: current.star.x + delta[0] * step, y: current.star.y + delta[1] * step };
        if (next) { move(next); onMove(id, current, handle === label ? 'label' : 'star'); }
      });
    }
  }
}
