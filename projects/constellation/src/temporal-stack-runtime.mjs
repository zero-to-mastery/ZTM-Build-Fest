import { projectTemporalPlane } from './temporal-stack-model.mjs';
import { temporalGeometryMath } from './temporal-geometry.mjs';
import { applyTemporalGeometryDrawing } from './temporal-geometry-runtime.mjs';
import { temporalMotion } from './temporal-motion.mjs';

// Embedded verbatim alongside projectTemporalPlane in offline HTML.
export function mountTemporalStack(root, scene, api) {
  const stack = scene.temporalStack;
  if (!stack) return { destroy() {} };
  const layers = stack.layers.map(layer => ({ ...layer, key: layer.id ?? layer.year }));
  const dimension = stack.axis !== 'year';
  const distance = (a,b) => Math.abs(layers.findIndex(layer => String(layer.key) === String(a)) - layers.findIndex(layer => String(layer.key) === String(b)));
  const svg = root.querySelector('[data-canvas] > svg'), abort = new AbortController();
  let pendingView, cameraFrame;
  const queueView = value => {
    pendingView = { ...pendingView, ...value };
    if (cameraFrame !== undefined) return;
    cameraFrame = requestAnimationFrame(() => { cameraFrame = undefined; const next = pendingView; pendingView = undefined; setTemporalView(next); });
  };
  const frames = new Map((stack.frames || scene.timeline.frames).map(frame => [frame.id, frame]));
  const planes = [...svg.querySelectorAll('[data-temporal-year]')];
  const controls = document.createElement('div'); controls.className = 'constellation-toolbar'; controls.setAttribute('aria-label', dimension ? 'Universe' : 'Temporal Stack');
  const year = document.createElement('select'); year.setAttribute('aria-label', dimension ? 'Focus layer' : 'Focus year');
  const all = document.createElement('option'); all.value = ''; all.textContent = dimension ? 'All layers' : 'All years'; year.append(all);
  for (const layer of layers) {
    const option = document.createElement('option'); option.value = String(layer.key);
    option.textContent = `${layer.label ?? layer.key} · ${frames.get(layer.frameId).evidence}`; year.append(option);
  }
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: abort.signal });
  const sliders = {};
  for (const [key, title, min, max, step, initial] of [['depth', 'Separate layers', 0, 2, .05, 1], ['rotation', 'Rotate', -1, 1, .05, 0], ['tilt', 'Tilt', .15, .85, .05, stack.settings.tilt]]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = initial;
    label.append(input); controls.append(label); sliders[key] = input;
    listen(input, 'input', () => queueView({ [key]: Number(input.value) }));
  }
  const onlyLabel = document.createElement('label'); onlyLabel.textContent = dimension ? 'Only focused layer' : 'Only focused year';
  const only = document.createElement('input'); only.type = 'checkbox'; onlyLabel.append(only);
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset perspective';
  const current = document.createElement('button'); current.type = 'button'; current.textContent = dimension ? 'First layer' : 'Latest year';
  controls.prepend(year); controls.append(onlyLabel, current, reset); root.prepend(controls);
  const initialView = () => ({ depth: 1, rotation: 0, tilt: stack.settings.tilt, ...(stack.geometry ? { shape: stack.geometry.profile.shape, twist: stack.geometry.profile.twist, surface: stack.geometry.profile.surface } : {}) });
  let view = initialView(), focused = null;
  let form, surface, twist;
  if (stack.geometry) {
    const select = (title, values) => { const label = document.createElement('label'); label.textContent = title; const control = document.createElement('select'); for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = value; control.append(option); } label.append(control); controls.append(label); return control; };
    form = select('Universe form ', temporalGeometryMath.shapes); form.value = view.shape;
    surface = select('Surface ', ['off', 'wireframe', 'translucent']); surface.value = view.surface;
    const label = document.createElement('label'); label.textContent = 'Twist '; twist = document.createElement('input'); twist.type = 'range'; twist.min = '-720'; twist.max = '720'; twist.step = '15'; twist.value = view.twist; label.append(twist); controls.append(label);
    listen(form, 'change', () => setTemporalView({ shape: form.value, ...(form.value === 'helix' && view.twist === 0 ? { twist: 240 } : {}) }));
    listen(surface, 'change', () => setTemporalView({ surface: surface.value }));
    listen(twist, 'input', () => queueView({ twist: Number(twist.value) }));
  }
  let elapsed = 0;
  function apply(ambient = false) {
    if (stack.geometry) {
      const drawing = applyTemporalGeometryDrawing(svg, scene, { ...view, elapsed, fitBackdrop: !ambient });
      const playback = scene.presentation.options.history?.timeLapse;
      const progress = elapsed / (playback?.duration || 16), fraction = playback?.loop === false ? Math.min(1, progress) : progress % 1;
      const playbackYear = layers[Math.max(0, layers.length - 1 - Math.floor(fraction * layers.length))]?.key;
      for (const element of svg.querySelectorAll('[data-layer-id]')) {
        const elementYear = dimension ? element.dataset.layerId : Number(element.dataset.layerId);
        const display = only.checked && focused !== null && elementYear !== focused ? 'none' : '';
        if (element.style.display !== display) element.style.display = display;
        const base = Number(element.dataset.baseOpacity || element.getAttribute('opacity') || 1);
        const playbackOpacity = elapsed && playback?.enabled && focused === null ? playback.mode === 'grow' ? (elementYear <= playbackYear ? 1 : .08) : elementYear === playbackYear ? 1 : .25 : 1;
        const opacity = String(base * playbackOpacity * (focused === null || elementYear === focused ? 1 : Math.max(.2, .65 - distance(elementYear, focused) * .1)));
        if (element.getAttribute('opacity') !== opacity) element.setAttribute('opacity', opacity);
      }
      for (const bridge of svg.querySelectorAll('.temporal-bridge, .temporal-mesh, .temporal-surface')) bridge.style.display = only.checked && focused !== null ? 'none' : '';
      for (const [key, input] of Object.entries(sliders)) input.value = view[key];
      form.value = view.shape; surface.value = view.surface; twist.value = view.twist;
      if (!ambient) api.setCamera(drawing.viewBox); return;
    }
    const coordinates = new Map();
    for (const layer of layers) {
      const matrix = projectTemporalPlane(layer.depth, stack.settings, view), [a, b, c, d, e, f] = matrix;
      const plane = planes.find(plane => Number(plane.dataset.temporalYear) === layer.key);
      plane.setAttribute('transform', `matrix(${matrix.join(' ')})`);
      const determinant = a * d - b * c;
      for (const group of plane.querySelectorAll('.repository')) {
        const star = group.querySelector('.star'), x = Number(star.getAttribute('cx')), y = Number(star.getAttribute('cy'));
        group.setAttribute('transform', `translate(${x} ${y}) matrix(${a * d / determinant} ${-a * b / determinant} ${-a * c / determinant} ${a * a / determinant} 0 0) translate(${-x} ${-y})`);
      }
      for (const text of plane.querySelectorAll('text')) {
        const x = Number(text.getAttribute('x')), y = Number(text.getAttribute('y'));
        text.setAttribute('transform', `translate(${x} ${y}) matrix(${d / determinant} ${-b / determinant} ${-c / determinant} ${a / determinant} 0 0) translate(${-x} ${-y})`);
      }
      plane.style.display = only.checked && focused !== null && layer.key !== focused ? 'none' : '';
      plane.setAttribute('opacity', focused === null ? Math.max(.55, 1 + layer.depth * .045) : layer.key === focused ? 1 : Math.max(.2, .65 - distance(layer.key, focused) * .1));
      for (const node of frames.get(layer.frameId).scene.nodes) coordinates.set(`${layer.key}::${node.id}`, { x: a * node.geometry.x + c * node.geometry.y + e, y: b * node.geometry.x + d * node.geometry.y + f });
    }
    for (const bridge of svg.querySelectorAll('.temporal-bridge')) {
      const from = coordinates.get(`${bridge.dataset.fromYear}::${bridge.dataset.nodeId}`), to = coordinates.get(`${bridge.dataset.toYear}::${bridge.dataset.nodeId}`);
      bridge.setAttribute('d', `M${from.x} ${from.y}L${to.x} ${to.y}`);
      bridge.style.display = only.checked && focused !== null ? 'none' : '';
    }
    for (const [key, input] of Object.entries(sliders)) input.value = view[key];
    const height = 200 + 540 * view.tilt + 160 * Math.abs(view.rotation) + (layers.length - 1) * stack.settings.depthGap * view.depth;
    const width = 1000 + (layers.length - 1) * (18 + Math.abs(view.rotation) * 35) * stack.settings.perspective;
    api.setCamera([0, 0, width, height]);
  }
  function setTemporalView(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(stack.geometry ? ['depth', 'rotation', 'tilt', 'shape', 'twist', 'surface'] : ['depth', 'rotation', 'tilt']).includes(key))) throw new Error('Invalid temporal view.');
    const next = { ...view, ...value };
    if (![next.depth, next.rotation, next.tilt].every(Number.isFinite) || next.depth < 0 || next.depth > 2 || Math.abs(next.rotation) > 1 || next.tilt < .15 || next.tilt > .85 || stack.geometry && (!temporalGeometryMath.shapes.includes(next.shape) || !['off', 'wireframe', 'translucent'].includes(next.surface) || !Number.isFinite(next.twist) || Math.abs(next.twist) > 720)) throw new Error('Temporal view exceeds camera bounds.');
    view = next; apply();
  }
  function focusYear(value) {
    if (value !== null && !layers.some(layer => layer.key === value)) throw new Error('Unknown temporal year.');
    focused = value; year.value = value === null ? '' : String(value); apply();
    const frame = value === null ? null : frames.get(layers.find(layer => layer.key === value).frameId);
    const status = root.querySelector('[data-status]');
    if (status) status.textContent = dimension ? (frame ? layers.find(layer => layer.key === value).label + ': current repository membership.' : 'All dimensional layers visible.') : frame ? `${value}: ${frame.evidence === 'current-metadata' ? 'Repositories known to exist by this date, using current metadata' : frame.evidence}. Evidence date ${frame.date.slice(0, 10)}.` : 'All yearly layers visible.';
    root.dispatchEvent(new CustomEvent(dimension ? 'universe-layer-change' : 'temporal-year-change', { detail: { ...(dimension ? { layer: value, axis: stack.axis } : { year: value }), evidence: frame?.evidence ?? null }, bubbles: true, composed: true }));
  }
  function resetTemporalView() { cancelAnimationFrame(cameraFrame); cameraFrame = undefined; pendingView = undefined; only.checked = false; focused = null; year.value = ''; view = initialView(); apply(); }
  function focusTemporalNode(id) { only.checked = false; focusYear(null); api.selectNode(id, { focus: false }); }
  Object.assign(api, { setTemporalView, focusLayer: focusYear, focusYear, resetTemporalView, focusTemporalNode });
  listen(year, 'change', () => focusYear(year.value ? dimension ? year.value : Number(year.value) : null));
  listen(only, 'change', () => focusYear(focused ?? layers[0].key));
  listen(current, 'click', () => focusYear(layers[0].key));
  listen(reset, 'click', resetTemporalView);
  listen(root, 'node-select', event => {
    const id = event.detail.id;
    for (const bridge of svg.querySelectorAll('.temporal-bridge')) bridge.toggleAttribute('data-related', bridge.dataset.nodeId === id && scene.layers.find(layer => layer.id === 'selection')?.visible !== false);
    if (!id) return;
    const years = layers.filter(layer => frames.get(layer.frameId).scene.nodes.some(node => node.id === id)).map(layer => layer.key);
    if (!years.length) return;
    const details = root.querySelector('[data-details]'), summary = document.createElement('p');
    summary.textContent = dimension ? 'Present in: ' + layers.filter(layer => years.includes(layer.key)).map(layer => layer.label).join(', ') + '. Current memberships, not historical observations.' : `First visible: ${Math.min(...years)}. Present through: ${Math.max(...years)}. Visible in: ${years.length} yearly layers. First visibility is limited to the selected years and available evidence.`;
    details?.append(summary);
    const created = scene.timeline?.metadata?.find(record => record.id === id)?.created;
    if (created) { const date = document.createElement('p'); date.textContent = `Created: ${created.slice(0, 10)} (recorded creation date).`; details?.append(date); }
  });
  listen(root, 'filter-change', () => {
    const visible = new Set([...svg.querySelectorAll('.repository:not([data-filtered])')].map(node => node.dataset.nodeId));
    for (const bridge of svg.querySelectorAll('.temporal-bridge')) bridge.toggleAttribute('data-filtered', !visible.has(bridge.dataset.nodeId));
  });
  // Keep the projected painter order and data paths in sync. Hidden tabs and
  // reduced-motion users incur no continuous projection work.
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let motionFrame, previous, lastPaint = 0, paused = false;
  const tick = now => {
    motionFrame = undefined;
    if (media.matches || document.hidden || paused || !root.isConnected) { previous = undefined; return; }
    elapsed += previous === undefined ? 0 : Math.min(.1, (now - previous) / 1000); previous = now;
    if (now - lastPaint >= 50) { apply(true); lastPaint = now; }
    motionFrame = requestAnimationFrame(tick);
  };
  const resume = () => {
    cancelAnimationFrame(motionFrame); previous = undefined;
    if (media.matches) { elapsed = 0; apply(true); }
    else if (stack.geometry && temporalMotion(scene.presentation.options).active && !document.hidden && !paused) motionFrame = requestAnimationFrame(tick);
  };
  listen(media, 'change', resume); listen(document, 'visibilitychange', resume);
  listen(root, 'pointerdown', () => { paused = true; cancelAnimationFrame(motionFrame); });
  listen(window, 'pointerup', () => { paused = false; resume(); });
  resume();
  return { destroy() { abort.abort(); cancelAnimationFrame(cameraFrame); cancelAnimationFrame(motionFrame); controls.remove(); } };
}
