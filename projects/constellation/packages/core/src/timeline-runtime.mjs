// Embedded with the standalone runtime; pass functions explicitly, never evaluate config.
export function mountTimeline(root, source, options, mount) {
  if (source.temporalStack && !source.timeline) return mount(root, source, options);
  if (source.temporalStack) {
    const canvas = root.querySelector('[data-canvas]'), stackSVG = canvas.innerHTML;
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = 'Open Timeline';
    const controls = document.createElement('div'); controls.className = 'constellation-toolbar'; controls.append(toggle); root.prepend(controls);
    let stacked = true, runtime = mount(root, source, options);
    function switchMode(value) {
      if (value === stacked) return;
      const state = { filter: runtime.filter, theme: runtime.theme, selection: runtime.selection };
      runtime.destroy(); stacked = value;
      if (stacked) { canvas.innerHTML = stackSVG; runtime = mount(root, source, options); }
      else {
        const ordinary = { ...source }; delete ordinary.temporalStack;
        runtime = mountTimeline(root, ordinary, options, mount);
      }
      runtime.setFilter(state.filter); runtime.setTheme(state.theme);
      if (state.selection) try { runtime.selectNode(state.selection, { focus: false }); } catch { /* Project absent in this frame. */ }
      toggle.textContent = stacked ? 'Open Timeline' : 'Return to Temporal Stack'; root.constellation = api;
    }
    const api = { get selection() { return runtime.selection; }, get selectionState() { return runtime.selectionState; }, get camera() { return runtime.camera; }, get filter() { return runtime.filter; }, get theme() { return runtime.theme; }, get focusState() { return runtime.focusState; }, get navigation() { return runtime.navigation; }, get frameIndex() { return runtime.frameIndex; }, destroy() { runtime.destroy(); controls.remove(); } };
    for (const method of ['selectNode', 'clearSelection', 'focusProject', 'focusRelationship', 'returnToOverview', 'restoreFocus', 'fit', 'reset', 'setCamera', 'setFilter', 'setTheme']) api[method] = (...args) => runtime[method](...args);
    for (const method of ['setFrame', 'setDate', 'compareWithNow']) api[method] = (...args) => { switchMode(false); return runtime[method](...args); };
    for (const method of ['setTemporalView', 'focusLayer', 'focusYear', 'focusTemporalNode', 'resetTemporalView']) api[method] = (...args) => { switchMode(true); return runtime[method](...args); };
    toggle.addEventListener('click', () => switchMode(!stacked));
    root.constellation = api; return api;
  }
  if (!source.timeline) return mount(root, source, options);
  const frames = source.timeline.frames;
  const abort = new AbortController();
  const controls = document.createElement('div'); controls.className = 'constellation-toolbar'; controls.setAttribute('aria-label', 'Timeline');
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = 'Previous date';
  const next = document.createElement('button'); next.type = 'button'; next.textContent = 'Next date';
  const label = document.createElement('span'); label.setAttribute('role', 'status');
  const scrubLabel = document.createElement('label'); scrubLabel.textContent = 'Date ';
  const scrub = document.createElement('input'); scrub.type = 'range'; scrub.min = '0'; scrub.max = String(frames.length - 1); scrub.step = '1'; scrubLabel.append(scrub);
  const then = document.createElement('button'); then.type = 'button'; then.textContent = 'Then';
  const now = document.createElement('button'); now.type = 'button'; now.textContent = 'Now';
  const compareLabel = document.createElement('label'); compareLabel.textContent = 'Compare with Now ';
  const compare = document.createElement('input'); compare.type = 'checkbox'; compareLabel.append(compare);
  controls.append(previous, scrubLabel, label, next, then, now, compareLabel); root.prepend(controls);
  const summary = document.createElement('p'); summary.className = 'constellation-status'; summary.setAttribute('role', 'status'); summary.hidden = true; controls.after(summary);
  const comparison = document.createElement('aside'); comparison.setAttribute('aria-label', 'Now comparison'); comparison.hidden = true;
  const comparisonRoot = comparison.attachShadow({ mode: 'open' });
  comparisonRoot.innerHTML = `<style>:host{display:block}svg{width:100%;height:70vh;min-height:280px}*{animation:none!important}</style>${options.frameSVGs.at(-1)}`;
  comparisonRoot.querySelector('svg').pauseAnimations?.();
  const viewports = root.querySelector('[data-viewports]'); viewports.append(comparison);
  let index = frames.length - 1, runtime, disposeTransition;
  function compareWithNow(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Comparison must be boolean.');
    compare.checked = enabled; comparison.hidden = !enabled; summary.hidden = !enabled;
    viewports.toggleAttribute('data-comparing', enabled);
    const before = new Set(frames[index].scene.nodes.map(node => node.id));
    const after = new Set(frames.at(-1).scene.nodes.map(node => node.id));
    const added = [...after].filter(id => !before.has(id)).length, removed = [...before].filter(id => !after.has(id)).length;
    summary.textContent = `Then ${frames[index].date.slice(0, 10)} ↔ Now ${frames.at(-1).date.slice(0, 10)}: ${added} added, ${removed} removed. ${frames[index].evidence === 'current-metadata' ? 'Earlier view uses current metrics; this is not historical growth data.' : 'Values reflect the supplied records at each date.'}`;
    comparisonRoot.querySelector('svg').setAttribute('viewBox', runtime.camera.join(' '));
  }
  function setFrame(value) {
    if (!Number.isInteger(value) || value < 0 || value >= frames.length) throw new Error('Invalid timeline frame.');
    const before = runtime ? frames[index].scene : null;
    const state = runtime && { camera: runtime.camera, selection: runtime.selectionState, filter: runtime.filter, theme: runtime.theme };
    runtime?.destroy(); disposeTransition?.(); index = value;
    if (options.replaceSVG) disposeTransition = options.replaceSVG(root.querySelector('[data-canvas]'), options.frameSVGs[index], before, frames[index].scene);
    else root.querySelector('[data-canvas]').innerHTML = options.frameSVGs[index];
    const languages = root.querySelector('[data-language]'); if (languages) while (languages.options.length > 1) languages.remove(1);
    runtime = mount(root, frames[index].scene, { ...options, emitReady: false });
    if (state) {
      runtime.setCamera(state.camera); runtime.setFilter(state.filter); runtime.setTheme(state.theme);
      try {
        if (state.selection.start) runtime.selectNode(state.selection.start, { focus: false });
        if (state.selection.end) runtime.selectNode(state.selection.end, { focus: false, extend: true });
      } catch { runtime.clearSelection(); }
    }
    label.textContent = `${frames[index].date.slice(0, 10)} · ${frames[index].evidence === 'snapshot' ? 'Historical snapshot' : frames[index].evidence === 'current' ? 'Current metadata' : 'Creation-date view using current metadata'}`;
    previous.disabled = index === 0; next.disabled = index === frames.length - 1;
    scrub.value = String(index); scrub.setAttribute('aria-valuetext', `${frames[index].date.slice(0, 10)}; ${frames[index].evidence}`);
    compareWithNow(compare.checked);
    root.constellation = api;
    root.dispatchEvent(new CustomEvent('timeline-change', { detail: { index, date: frames[index].date, evidence: frames[index].evidence }, bubbles: true, composed: true }));
  }
  function setDate(value) {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) throw new Error('Invalid timeline date.');
    let nearest = 0;
    for (let i = 1; i < frames.length; i++) if (Math.abs(Date.parse(frames[i].date) - date) < Math.abs(Date.parse(frames[nearest].date) - date)) nearest = i;
    setFrame(nearest);
  }
  const api = { setFrame, setDate, compareWithNow, get frameIndex() { return index; }, get selection() { return runtime.selection; }, get selectionState() { return runtime.selectionState; }, get camera() { return runtime.camera; }, get filter() { return runtime.filter; }, get theme() { return runtime.theme; }, get focusState() { return runtime.focusState; }, get navigation() { return runtime.navigation; }, destroy() { abort.abort(); disposeTransition?.(); runtime?.destroy(); controls.remove(); summary.remove(); comparison.remove(); viewports.removeAttribute('data-comparing'); } };
  for (const method of ['selectNode', 'clearSelection', 'focusProject', 'focusRelationship', 'returnToOverview', 'restoreFocus', 'fit', 'reset', 'setCamera', 'setFilter', 'setTheme']) api[method] = (...args) => runtime[method](...args);
  previous.addEventListener('click', () => setFrame(index - 1), { signal: abort.signal });
  next.addEventListener('click', () => setFrame(index + 1), { signal: abort.signal });
  scrub.addEventListener('input', () => setFrame(Number(scrub.value)), { signal: abort.signal });
  then.addEventListener('click', () => setFrame(0), { signal: abort.signal });
  now.addEventListener('click', () => setFrame(frames.length - 1), { signal: abort.signal });
  compare.addEventListener('change', () => compareWithNow(compare.checked), { signal: abort.signal });
  root.addEventListener('camera-change', event => comparisonRoot.querySelector('svg').setAttribute('viewBox', event.detail.viewBox.join(' ')), { signal: abort.signal });
  setFrame(index);
  if (options.emitReady !== false) root.dispatchEvent(new CustomEvent('scene-ready', { detail: { frames: frames.length }, bubbles: true, composed: true }));
  return api;
}
