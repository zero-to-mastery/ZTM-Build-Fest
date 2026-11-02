export { mountInteractive, interactiveStyles } from './interactive-runtime.mjs';
export { createSemanticZoomState, resolveSemanticZoomMode, SEMANTIC_ZOOM_MODES, SEMANTIC_ZOOM_POLICY } from './semantic-zoom.mjs';
export { mountTimeline } from './timeline-runtime.mjs';
export { replaceInteractiveSVG, transitionCamera } from './scene-transition.mjs';
export { mountHierarchy } from './hierarchy-runtime.mjs';
export { hierarchyArtifacts } from './renderer-html.mjs';
export { mountStory } from './story-runtime.mjs';
export { storyArtifacts } from './renderer-html.mjs';
export { interactiveMarkup } from './renderer-html.mjs';
// The core entry initializes these bindings before a component mounts.
export { shortest_path, neighbors } from './wasm/constellation_core.js';
import { shortest_path, neighbors, EvidenceNavigator } from './wasm/constellation_core.js';
import { evidenceNavigationGraphFromScene } from './evidence-navigation.mjs';
import { evidenceNavigatorAdapter } from './evidence-navigator.mjs';
export { mountFocusHistory, installFocusAPI } from './interactive-focus.mjs';

// Engine for mounted runtimes: graph paths plus one retained Evidence Navigation
// index per scene object, released with the scene.
const navigators = new WeakMap();
export const interactiveEngine = Object.freeze({
  shortest_path, neighbors,
  navigatorFor(scene) {
    if (!scene || typeof scene !== 'object') return null;
    if (!navigators.has(scene)) navigators.set(scene, evidenceNavigatorAdapter(EvidenceNavigator, evidenceNavigationGraphFromScene(scene)));
    return navigators.get(scene);
  },
});
