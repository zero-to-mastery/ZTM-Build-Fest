import { createScene } from './constellation.mjs';
import { assertScene } from './scene.mjs';
import { createLayers } from './scene-layers.mjs';
import { validateStory, STORY_VERSION } from './story-model.mjs';

export function createStory(definition, runtime = {}) {
  if (!definition || !Array.isArray(definition.chapters) || definition.chapters.length > 64) throw new Error('Story requires chapter definitions.');
  const catalog = new Map((definition.scenes || []).map(entry => [entry.id, entry]));
  if (catalog.size !== (definition.scenes || []).length) throw new Error('Duplicate story scene ID.');
  const chapters = definition.chapters.map((chapter, index) => {
    runtime.signal?.throwIfAborted();
    const entry = typeof chapter.scene === 'string' ? catalog.get(chapter.scene) : { scene: chapter.scene, definition: chapter.definition };
    if (!entry) throw new Error('Missing story scene reference.');
    if (chapter.layout !== undefined && (!entry.definition || typeof chapter.layout !== 'string')) throw new Error('Chapter layout requires a declarative scene definition.');
    const scene = entry.definition ? createScene(entry.definition.account, entry.definition.records, { ...entry.definition.options, ...(chapter.layout ? { arrangement: chapter.layout } : {}) }, runtime) : structuredClone(assertScene(entry.scene));
    if (scene.kind !== 'scene' || scene.story) throw new Error('Story chapters require plain or temporal scenes.');
    const apply = target => {
      if (chapter.theme !== undefined) { if (!['auto', 'midnight', 'light'].includes(chapter.theme)) throw new Error('Invalid chapter theme.'); target.presentation.options.theme = chapter.theme; }
      if (chapter.layers !== undefined) target.layers = createLayers({ ...Object.fromEntries(target.layers.map(layer => [layer.id, { visible: layer.visible, opacity: layer.opacity, order: layer.order }])), ...chapter.layers });
      if (chapter.annotations !== undefined) target.annotations = structuredClone(chapter.annotations);
    };
    apply(scene); for (const frame of scene.timeline?.frames || []) apply(frame.scene);
    const result = { id: chapter.id || `chapter-${index + 1}`, title: chapter.title || `Chapter ${index + 1}`, narration: chapter.narration || '', scene, selection: chapter.path ? [chapter.path.start, chapter.path.end] : chapter.selection || [] };
    for (const key of ['camera', 'focus', 'filter', 'timeline']) if (chapter[key] !== undefined) result[key] = structuredClone(chapter[key]);
    return result;
  });
  const story = validateStory({ version: STORY_VERSION, chapters }, assertScene);
  return { ...structuredClone(chapters[0].scene), story };
}
