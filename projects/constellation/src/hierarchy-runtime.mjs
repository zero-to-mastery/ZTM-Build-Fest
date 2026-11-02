export function mountHierarchy(root, source, options, mountScene) {
  if (!source.hierarchy) return mountScene(root, source, options);
  const catalog = new Map(source.hierarchy.scenes.map(entry => [entry.id, entry]));
  const artifacts = new Map(options.hierarchyArtifacts.map(entry => [entry.id, entry]));
  const rootId = source.hierarchy.root, key = options.historyKey || 'constellation';
  const abort = new AbortController();
  const nav = document.createElement('nav'); nav.className = 'constellation-toolbar'; nav.setAttribute('aria-label', 'Scene navigation');
  const home = document.createElement('button'); home.type = 'button'; home.textContent = 'Home';
  const back = document.createElement('button'); back.type = 'button'; back.textContent = 'Back';
  const crumbs = document.createElement('span'); crumbs.setAttribute('aria-label', 'Breadcrumbs'); crumbs.setAttribute('aria-live', 'polite');
  nav.append(home, back, crumbs); root.prepend(nav);
  let path = [rootId], runtime, disposeTransition;
  const stateCache = new Map();
  const children = scene => [...scene.nodes, ...scene.timeline?.frames.flatMap(frame => frame.scene.nodes) || []];
  function validPath(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value[0] !== rootId) return false;
    return value.every((id, i) => catalog.has(id) && (!i || children(catalog.get(value[i - 1]).scene).some(node => node.interaction.childScene === id)));
  }
  function readPath() {
    try { if (location.hash.length > 16384) return [rootId]; const text = new URLSearchParams(location.hash.slice(1)).get(key); if (!text || text.length > 8192) return [rootId]; const value = JSON.parse(text); return validPath(value) ? value : [rootId]; } catch { return [rootId]; }
  }
  function shareURL() { const url = new URL(location.href); const hash = new URLSearchParams(url.hash.slice(1)); hash.set(key, JSON.stringify(path)); url.hash = hash.toString(); return url.href; }
  function navigate(value, historyMode = 'push') {
    if (!validPath(value)) throw new Error('Invalid hierarchy navigation path.');
    if (runtime && JSON.stringify(path) === JSON.stringify(value)) return;
    const before = runtime && catalog.get(path.at(-1)).scene;
    if (runtime) {
      stateCache.delete(path.at(-1)); stateCache.set(path.at(-1), { camera: runtime.camera, filter: runtime.filter, theme: runtime.theme, selection: runtime.selectionState, frame: runtime.frameIndex });
      while (stateCache.size > 8) stateCache.delete(stateCache.keys().next().value);
    }
    runtime?.destroy(); disposeTransition?.(); path = [...value];
    const entry = catalog.get(path.at(-1)), artifact = artifacts.get(entry.id);
    if (options.replaceSVG) disposeTransition = options.replaceSVG(root.querySelector('[data-canvas]'), artifact.svg, before, entry.scene);
    else root.querySelector('[data-canvas]').innerHTML = artifact.svg;
    const languages = root.querySelector('[data-language]'); if (languages) while (languages.options.length > 1) languages.remove(1);
    runtime = mountScene(root, entry.scene, { ...options, emitReady: false, frameSVGs: artifact.frameSVGs });
    const saved = stateCache.get(entry.id);
    if (saved) {
      if (saved.frame !== undefined && runtime.setFrame) runtime.setFrame(saved.frame);
      runtime.setCamera(saved.camera); runtime.setFilter(saved.filter); runtime.setTheme(saved.theme);
      try { if (saved.selection.start) runtime.selectNode(saved.selection.start, { focus: false }); if (saved.selection.end) runtime.selectNode(saved.selection.end, { focus: false, extend: true }); } catch { runtime.clearSelection(); }
    }
    root.constellation = api;
    back.disabled = path.length === 1; crumbs.replaceChildren();
    path.forEach((id, i) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = catalog.get(id).title;
      if (i === path.length - 1) button.setAttribute('aria-current', 'page');
      button.dataset.ancestor = String(i); crumbs.append(button);
    });
    if (options.history && historyMode !== 'none') {
      try { history[historyMode === 'replace' ? 'replaceState' : 'pushState']({ ...history.state, [key]: [...path] }, '', shareURL()); } catch { /* Local navigation still works in restrictive embedding contexts. */ }
    }
    if (before) crumbs.lastElementChild?.focus({ preventScroll: true });
    root.dispatchEvent(new CustomEvent('scene-change', { detail: { id: entry.id, path: [...path], scene: structuredClone(entry.scene) }, bubbles: true, composed: true }));
  }
  function openChild(id) { navigate([...path, id]); }
  const api = { openChild, navigate, home: () => navigate([rootId]), back: () => { if (path.length > 1) navigate(path.slice(0, -1)); }, shareURL,
    get scenePath() { return [...path]; }, get navigationCacheStatistics() { return { entries: stateCache.size, maxEntries: 8 }; }, get frameIndex() { return runtime.frameIndex; }, get selection() { return runtime.selection; }, get selectionState() { return runtime.selectionState; }, get camera() { return runtime.camera; }, get filter() { return runtime.filter; }, get theme() { return runtime.theme; }, get focusState() { return runtime.focusState; }, get navigation() { return runtime.navigation; },
    destroy() { abort.abort(); stateCache.clear(); disposeTransition?.(); runtime?.destroy(); nav.remove(); },
  };
  for (const method of ['setTemporalView', 'focusYear', 'focusTemporalNode', 'resetTemporalView', 'selectNode', 'clearSelection', 'focusProject', 'focusRelationship', 'returnToOverview', 'restoreFocus', 'fit', 'reset', 'setCamera', 'setFilter', 'setTheme', 'setFrame', 'setDate', 'compareWithNow']) api[method] = (...args) => { if (!runtime[method]) throw new Error('The active scene does not support this operation.'); return runtime[method](...args); };
  home.addEventListener('click', api.home, { signal: abort.signal }); back.addEventListener('click', api.back, { signal: abort.signal });
  crumbs.addEventListener('click', event => { const button = event.target.closest('[data-ancestor]'); if (button) navigate(path.slice(0, Number(button.dataset.ancestor) + 1)); }, { signal: abort.signal });
  root.addEventListener('scene-open-request', event => openChild(event.detail.id), { signal: abort.signal });
  root.addEventListener('timeline-change', () => { root.constellation = api; }, { signal: abort.signal });
  if (options.history) window.addEventListener('popstate', () => navigate(readPath(), 'none'), { signal: abort.signal });
  navigate(options.history ? readPath() : [rootId], options.history ? 'replace' : 'none');
  if (options.emitReady !== false) root.dispatchEvent(new CustomEvent('scene-ready', { detail: { path: [...path] }, bubbles: true, composed: true }));
  return api;
}
