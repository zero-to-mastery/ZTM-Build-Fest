export const STORY_VERSION = 1;
export function validateStory(story, validateScene) {
  if (!story || story.version !== STORY_VERSION || !Array.isArray(story.chapters) || story.chapters.length < 1 || story.chapters.length > 64) throw new Error('Story requires 1–64 chapters.');
  const ids = new Set(); let count = 0;
  for (const chapter of story.chapters) {
    if (typeof chapter.id !== 'string' || !chapter.id || chapter.id.length > 256 || ids.has(chapter.id) || typeof chapter.title !== 'string' || chapter.title.length > 200 || typeof chapter.narration !== 'string' || chapter.narration.length > 10000 || chapter.scene?.kind !== 'scene' || chapter.scene.story !== undefined) throw new Error('Invalid story chapter.');
    ids.add(chapter.id); validateScene?.(chapter.scene);
    const members = [chapter.scene, ...chapter.scene.hierarchy?.scenes.map(entry => entry.scene) || []];
    count += members.reduce((sum, scene) => sum + scene.nodes.length + (scene.timeline?.frames.reduce((sum, frame) => sum + frame.scene.nodes.length, 0) || 0), 0);
    if (count > 16384) throw new Error('Story exceeds 16,384 chapter nodes.');
    if (chapter.camera !== undefined && (!Array.isArray(chapter.camera) || chapter.camera.length !== 4 || !chapter.camera.every(Number.isFinite) || chapter.camera[2] <= 0 || chapter.camera[3] <= 0)) throw new Error('Invalid chapter camera.');
    if (chapter.focus !== undefined && typeof chapter.focus !== 'string') throw new Error('Chapter focus must be a node ID.');
    if (!Array.isArray(chapter.selection) || chapter.selection.length > 2 || chapter.selection.some(id => typeof id !== 'string')) throw new Error('Chapter selection supports zero, one or two node IDs.');
    const available = new Set([...chapter.scene.nodes, ...chapter.scene.timeline?.frames.flatMap(frame => frame.scene.nodes) || []].map(node => node.id));
    if ([chapter.focus, ...chapter.selection].filter(Boolean).some(id => !available.has(id))) throw new Error('Chapter references a missing node.');
    if (chapter.filter !== undefined && (!chapter.filter || typeof chapter.filter !== 'object' || Object.entries(chapter.filter).some(([key, value]) => !['query', 'language'].includes(key) || typeof value !== 'string' || value.length > 512))) throw new Error('Invalid chapter filter.');
    if (chapter.timeline !== undefined && (!chapter.scene.timeline || !Number.isInteger(chapter.timeline) || chapter.timeline < 0 || chapter.timeline >= chapter.scene.timeline.frames.length)) throw new Error('Invalid chapter timeline frame.');
  }
  return story;
}
