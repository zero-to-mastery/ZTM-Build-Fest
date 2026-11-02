export function mountStory(root, source, options, mountExperience) {
  if (!source.story) return mountExperience(root, source, options);
  const chapters = source.story.chapters, abort = new AbortController();
  const section = document.createElement('section'); section.setAttribute('aria-label', 'Story');
  const controls = document.createElement('div'); controls.className = 'constellation-toolbar';
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = 'Previous chapter';
  const next = document.createElement('button'); next.type = 'button'; next.textContent = 'Next chapter';
  const label = document.createElement('label'); label.textContent = 'Chapter '; const select = document.createElement('select'); label.append(select);
  chapters.forEach((chapter, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = chapter.title; select.append(option); });
  const title = document.createElement('h2'); title.tabIndex = -1;
  const narration = document.createElement('p'); narration.setAttribute('aria-live', 'polite');
  controls.append(previous, label, next); section.append(controls, title, narration); root.prepend(section);
  let index = 0, runtime, disposeTransition, disposeCamera;
  function setChapter(value) {
    const target = typeof value === 'string' ? chapters.findIndex(chapter => chapter.id === value) : value;
    if (!Number.isInteger(target) || target < 0 || target >= chapters.length) throw new Error('Unknown story chapter.');
    const mounted = Boolean(runtime), previousScene = mounted ? chapters[index].scene : null, camera = runtime?.camera;
    disposeCamera?.(); disposeTransition?.(); runtime?.destroy(); index = target;
    const chapter = chapters[index], artifact = options.storyArtifacts[index];
    if (options.replaceSVG) disposeTransition = options.replaceSVG(root.querySelector('[data-canvas]'), artifact.svg, previousScene, chapter.scene);
    else root.querySelector('[data-canvas]').innerHTML = artifact.svg;
    const languages = root.querySelector('[data-language]'); if (languages) while (languages.options.length > 1) languages.remove(1);
    runtime = mountExperience(root, chapter.scene, { ...options, ...artifact, emitReady: false, history: false });
    if (chapter.timeline !== undefined) runtime.setFrame(chapter.timeline);
    if (chapter.filter) runtime.setFilter(chapter.filter);
    if (chapter.camera) runtime.setCamera(chapter.camera);
    try {
      if (chapter.focus) runtime.selectNode(chapter.focus);
      for (const [i, id] of chapter.selection.entries()) runtime.selectNode(id, { focus: false, extend: i > 0 });
    } catch { runtime.clearSelection(); }
    if (camera && options.transitionCamera) disposeCamera = options.transitionCamera(runtime, camera, runtime.camera);
    root.constellation = api;
    title.textContent = chapter.title; narration.textContent = chapter.narration;
    select.value = String(index); previous.disabled = index === 0; next.disabled = index === chapters.length - 1;
    if (mounted) title.focus({ preventScroll: true });
    root.dispatchEvent(new CustomEvent('chapter-change', { detail: { index, id: chapter.id, title: chapter.title }, bubbles: true, composed: true }));
  }
  const api = { setChapter, get chapterIndex() { return index; }, get selection() { return runtime.selection; }, get selectionState() { return runtime.selectionState; }, get camera() { return runtime.camera; }, get filter() { return runtime.filter; }, get theme() { return runtime.theme; }, get focusState() { return runtime.focusState; }, get navigation() { return runtime.navigation; }, get scenePath() { return runtime.scenePath; }, get frameIndex() { return runtime.frameIndex; }, destroy() { abort.abort(); disposeCamera?.(); disposeTransition?.(); runtime?.destroy(); section.remove(); } };
  for (const method of ['setTemporalView', 'focusYear', 'focusTemporalNode', 'resetTemporalView', 'selectNode', 'clearSelection', 'focusProject', 'focusRelationship', 'returnToOverview', 'restoreFocus', 'fit', 'reset', 'setCamera', 'setFilter', 'setTheme', 'setFrame', 'setDate', 'compareWithNow', 'openChild', 'back', 'home', 'shareURL']) api[method] = (...args) => { if (!runtime[method]) throw new Error('The chapter does not support this operation.'); return runtime[method](...args); };
  previous.addEventListener('click', () => setChapter(index - 1), { signal: abort.signal }); next.addEventListener('click', () => setChapter(index + 1), { signal: abort.signal }); select.addEventListener('change', () => setChapter(Number(select.value)), { signal: abort.signal });
  for (const type of ['scene-change', 'timeline-change']) root.addEventListener(type, () => { root.constellation = api; }, { signal: abort.signal });
  setChapter(0);
  if (options.emitReady !== false) root.dispatchEvent(new CustomEvent('scene-ready', { detail: { chapters: chapters.length }, bubbles: true, composed: true }));
  return api;
}
