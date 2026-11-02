import { renderSceneSVG } from './renderer-svg.mjs';
import { serializeScene } from './scene.mjs';
import { mountInteractive, interactiveStyles } from './interactive-runtime.mjs';
import { contentBounds, fitSceneViewport } from './scene-framing.mjs';
const { bindings, base64 } = await import('./wasm/inline.mjs').catch(() => ({}));
import { mountTimeline } from './timeline-runtime.mjs';
import { replaceInteractiveSVG, transitionCamera } from './scene-transition.mjs';
import { mountHierarchy } from './hierarchy-runtime.mjs';
import { mountStory } from './story-runtime.mjs';
import { mountTemporalStack } from './temporal-stack-runtime.mjs';
import { projectTemporalPlane } from './temporal-stack-model.mjs';
import { createTemporalGeometryMath } from './temporal-geometry.mjs';
import { temporalGeometryDrawing } from './temporal-geometry-drawing.mjs';
import { applyTemporalGeometryDrawing } from './temporal-geometry-runtime.mjs';
import { temporalMotion } from './temporal-motion.mjs';
import { createExplanationHelpers, EVIDENCE_VERSION, dimensionName, layoutSummary, safeEvidenceText } from './evidence.mjs';
import { buildSemanticHierarchy, projectSemanticLevel } from './semantic-groups.mjs';
import { createSemanticZoomState, resolveSemanticZoomMode, SEMANTIC_ZOOM_POLICY } from './semantic-zoom.mjs';
import { evidenceNavigationGraphFromScene } from './evidence-navigation.mjs';
import { evidenceNavigatorAdapter } from './evidence-navigator.mjs';
import { mountFocusHistory } from './interactive-focus.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const scriptJSON = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const runtimeScript = `${bindings}
await __wbg_init({ module_or_path: Uint8Array.from(atob('${base64}'), char => char.charCodeAt(0)) });
const explanationAPI = (${createExplanationHelpers.toString()})(${EVIDENCE_VERSION}, (${dimensionName.toString()}), (${layoutSummary.toString()}));
const scene = JSON.parse(document.getElementById('constellation-scene').textContent);
const semanticArtifacts = JSON.parse(document.getElementById('constellation-semantic-artifacts').textContent);
const semanticMode = JSON.parse(document.getElementById('constellation-semantic-mode').textContent);
const createSemanticZoomState = ${createSemanticZoomState.toString()};
const semanticZoomPolicy = ${scriptJSON(SEMANTIC_ZOOM_POLICY)};
const projectTemporalPlane = ${projectTemporalPlane.toString()};
const temporalGeometryMath = (${createTemporalGeometryMath.toString()})();
const temporalMotion = ${temporalMotion.toString()};
const temporalGeometryDrawing = ${temporalGeometryDrawing.toString()};
const applyTemporalGeometryDrawing = ${applyTemporalGeometryDrawing.toString()};
const mountTemporalStack = ${mountTemporalStack.toString()};
const mountScene = (root, scene, options) => (${mountTimeline.toString()})(root, scene, { ...options, semanticGroupActions: semanticArtifacts.length > 0 }, (root, scene, options) => (${mountInteractive.toString()})(root, scene, options, explanationAPI, ((contentBounds) => (${fitSceneViewport.toString()}))(${contentBounds.toString()})));
const mountExperience = (root, scene, options) => (${mountHierarchy.toString()})(root, scene, options, mountScene);
const navigator = (${evidenceNavigatorAdapter.toString()})(EvidenceNavigator, JSON.parse(document.getElementById('constellation-navigation').textContent));
const runtimeOptions = { engine: { shortest_path, neighbors }, navigator, history: true, replaceSVG: ${replaceInteractiveSVG.toString()}, transitionCamera: ${transitionCamera.toString()}, frameSVGs: JSON.parse(document.getElementById('constellation-frames').textContent), hierarchyArtifacts: JSON.parse(document.getElementById('constellation-hierarchy').textContent), storyArtifacts: JSON.parse(document.getElementById('constellation-story').textContent) };
let experience = (${mountStory.toString()})(document.getElementById('constellation'), scene, runtimeOptions, mountExperience);
const focusHistory = (${mountFocusHistory.toString()})(document.getElementById('constellation'), { runtime: () => experience });
if (semanticArtifacts.some(item => item.id)) {
  const root = document.getElementById('constellation');
  const baseSVG = JSON.parse(document.getElementById('constellation-semantic-base').textContent);
  const byId = new Map(semanticArtifacts.map(item => [item.id, item]));
  let showing = false;
  const show = (nextScene, svg, context, expanded = false) => {
    showing = true;
    try {
      const previousSelection = experience.selectionState?.start;
      const camera = experience.camera, filter = experience.filter, theme = experience.theme;
      experience.destroy?.();
      root.querySelector('[data-canvas]').innerHTML = svg;
      experience = mountExperience(root, nextScene, { ...runtimeOptions, emitReady: false, history: false });
      if (camera) experience.setCamera?.(camera);
      if (filter) experience.setFilter?.(filter);
      if (theme) experience.setTheme?.(theme);
      if (previousSelection && nextScene.nodes.some(node => node.id === previousSelection)) {
        try { experience.selectNode(previousSelection, { focus: false }); } catch {}
      }
      if (context) {
        if (!experience.selectionState?.start && nextScene.nodes.some(node => node.id === context.id)) { try { experience.selectNode(context.id, { focus: false }); } catch {} }
        experience.showSemanticContext?.(context, { expanded });
      }
    } finally { showing = false; }
  };
  root.addEventListener('semantic-group-expand', event => {
    const artifact = byId.get(event.detail.id);
    const group = scene.semanticGroups?.groups.find(item => item.id === event.detail.id);
    if (artifact && group) show(artifact.scene, artifact.svg, group, true);
  });
  root.addEventListener('semantic-group-collapse', event => {
    const group = scene.semanticGroups?.groups.find(item => item.id === event.detail.id);
    if (byId.has(event.detail.id) && group) show(scene, baseSVG, group);
  });
  const projectArtifact = semanticArtifacts.find(item => item.level === 'projects');
  if (semanticMode === 'auto' && projectArtifact) {
    const groups = scene.semanticGroups?.groups || [];
    const state = createSemanticZoomState('groups', semanticZoomPolicy);
    let focus = null, timer;
    const announceChange = (previous, current, reason) => {
      if (previous === current) return;
      experience.announceSemanticLevel?.(current);
      root.dispatchEvent(new CustomEvent('semantic-level-change', { detail: { previous, current, reason }, bubbles: true, composed: true }));
    };
    root.addEventListener('camera-change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const camera = experience.camera, base = projectArtifact.scene.viewport.viewBox;
        const selected = experience.selectionState.start;
        const selectedGroup = groups.find(group => group.id === selected) || groups.find(group => group.members.includes(selected));
        const allowProjects = selectedGroup ? selectedGroup.members.length <= 128 : projectArtifact.scene.nodes.length <= 256;
        const transition = state.update(base[2] / camera[2], { allowProjects });
        if (!transition.changed) return;
        const previous = transition.previous, current = transition.current;
        if (previous !== 'projects' && current !== 'projects') {
          announceChange(previous, current, 'camera');
          return;
        }
        if (current === 'projects') {
          focus = selectedGroup || null;
          const artifact = focus ? byId.get(focus.id) : projectArtifact;
          if (artifact) show(artifact.scene, artifact.svg, focus, Boolean(focus));
        } else {
          const nextFocus = selectedGroup || focus;
          focus = nextFocus;
          show(scene, baseSVG, focus);
        }
        announceChange(previous, current, 'camera');
      }, 140);
    });
    root.addEventListener('node-select', event => {
      if (showing || state.level !== 'projects') return;
      const id = event.detail?.id;
      if (!id) { focus = null; return; }
      const group = groups.find(item => item.id === id) || groups.find(item => item.members.includes(id));
      if (!group || group.id === focus) return;
      if (group.members.length <= 128) {
        const artifact = byId.get(group.id);
        if (!artifact) return;
        focus = group;
        show(artifact.scene, artifact.svg, group, true);
        return;
      }
      // Return to grouped detail instead of retaining unrelated local detail.
      const previous = state.level;
      state.set('groups');
      focus = group;
      show(scene, baseSVG, group);
      announceChange(previous, 'groups', 'focus');
    });
  } else if (semanticMode === 'auto') {
    const status = root.querySelector('[data-status]');
    if (status) status.textContent = 'Grouped detail shown. Automatic project detail is unavailable within this offline artifact’s size limits.';
  }
}
const initialChapter = JSON.parse(document.getElementById('constellation-initial').textContent);
if (initialChapter > 0) experience.setChapter(initialChapter);
focusHistory.restore();`.replace(/\r\n?/g, '\n')
  // Embedded sources contain no multi-line string or template literal (guarded by
  // test/interactive-html.test.mjs), so dropping leading indentation is lossless.
  .replace(/\n[ \t]+/g, '\n');
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runtimeScript));
const scriptHash = btoa(String.fromCharCode(...new Uint8Array(digest)));
export const htmlPolicy = `default-src 'none'; script-src 'sha256-${scriptHash}' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;

export function htmlBundleStatistics(scene) {
  const bytes = value => new TextEncoder().encode(value).length;
  return { htmlBytes: bytes(renderSceneHTML(scene)), sceneBytes: bytes(scriptJSON(scene)), runtimeBytes: bytes(runtimeScript), wasmBytes: Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) };
}

export function interactiveMarkup(svg) {
  return `<main id="constellation" class="constellation-runtime" aria-label="Interactive constellation">
<div class="constellation-toolbar" role="toolbar" aria-label="View controls">
<button type="button" data-action="zoom-in" aria-label="Zoom in">Zoom in</button><button type="button" data-action="zoom-out" aria-label="Zoom out">Zoom out</button>
<button type="button" data-action="fit">Fit</button><button type="button" data-action="reset">Reset</button><button type="button" data-action="clear">Clear selection</button>
<label>Find <input type="search" data-search placeholder="Find nodes"></label><label>Language <select data-language><option value="">All</option></select></label><label>Theme <select data-theme><option value="original">Original</option><option value="midnight">Midnight</option><option value="light">Light</option></select></label>
</div><div data-viewports><div class="constellation-canvas" data-canvas>${svg}</div></div><p class="constellation-status" data-status role="status" aria-live="polite"></p><section class="constellation-details" data-details aria-label="Node details"></section></main>`;
}

export function renderSceneHTML(scene, { title = 'Constellation', initialChapter = 0, semanticLevel, semanticMetadata } = {}) {
  serializeScene(scene); // Validate before embedding either data or SVG.
  scene = sanitizeEvidenceMetadata(scene);
  const mode = semanticLevel || (scene.presentation?.options?.semanticZoom === undefined ? 'projects' : resolveSemanticZoomMode(scene.presentation.options.semanticZoom, 'projects'));
  const level = mode === 'auto' ? 'groups' : mode;
  const canProject = scene.kind === 'scene' && !scene.timeline && !scene.temporalStack;
  const grouped = canProject && (level === 'groups' || level === 'overview');
  const hierarchy = grouped ? buildSemanticHierarchy(scene, { projectFamilies: scene.presentation.options.projectFamilies }) : null;
  const view = !grouped ? scene : projectSemanticLevel(scene, level, { hierarchy });
  if (!Number.isInteger(initialChapter) || initialChapter < 0 || initialChapter >= (view.story?.chapters.length || 1)) throw new Error('Invalid initial story chapter.');
  const svg = renderSceneSVG(view, { interactive: true, semanticLevel: 'projects' });
  let semanticArtifacts = [];
  const sourceBytes = new TextEncoder().encode(JSON.stringify(scene)).length;
  if (grouped && !scene.story && !scene.hierarchy && scene.nodes.length <= 256 && sourceBytes <= 256 * 1024 && hierarchy.groups.length <= 32) {
    semanticArtifacts = hierarchy.groups.map(group => {
      const expanded = projectSemanticLevel(scene, 'groups', { hierarchy, expanded: [group.id] });
      return { id: group.id, group, scene: expanded, svg: renderSceneSVG(expanded, { interactive: true, semanticLevel: 'projects' }) };
    });
    if (mode === 'auto') semanticArtifacts.push({ id: null, level: 'projects', scene, svg: renderSceneSVG(scene, { interactive: true, semanticLevel: 'projects' }) });
    if (new TextEncoder().encode(JSON.stringify(semanticArtifacts)).length > 4 * 1024 * 1024) semanticArtifacts = [];
  }
  const semanticBase = semanticArtifacts.some(item => item.id) ? svg : '';
  const metadataMarkup = semanticMetadata ? `<section aria-label="Semantic graph information"><h1>${escape(semanticMetadata.subjectLabel)}</h1><p>Semantic Graph v${escape(semanticMetadata.version)} · Fingerprint ${escape(semanticMetadata.fingerprint)}</p><p>${semanticMetadata.truncated ? 'Source coverage is incomplete; this graph was truncated.' : 'Source coverage is marked complete.'}</p>${semanticMetadata.privateSource ? '<p role="note">Source visibility is private. This export may disclose repository names, paths, and structure.</p>' : ''}</section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(htmlPolicy)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{margin:0;padding:16px;background:#080b11}${interactiveStyles}</style></head><body>
${metadataMarkup}
${interactiveMarkup(svg)}
<script type="application/json" id="constellation-scene">${scriptJSON(view)}</script>
<script type="application/json" id="constellation-semantic-artifacts">${scriptJSON(semanticArtifacts)}</script>
<script type="application/json" id="constellation-semantic-base">${scriptJSON(semanticBase)}</script>
<script type="application/json" id="constellation-semantic-mode">${scriptJSON(mode)}</script>
<script type="application/json" id="constellation-frames">${scriptJSON(view.timeline?.frames.map(frame => renderSceneSVG(frame.scene)) || [])}</script>
<script type="application/json" id="constellation-hierarchy">${scriptJSON(hierarchyArtifacts(view))}</script>
<script type="application/json" id="constellation-story">${scriptJSON(storyArtifacts(view))}</script>
<script type="application/json" id="constellation-initial">${scriptJSON(initialChapter)}</script>
<script type="application/json" id="constellation-navigation">${scriptJSON(evidenceNavigationGraphFromScene(scene))}</script>
<script type="module">${runtimeScript}</script>
</body></html>\n`;
}

function sanitizeEvidenceMetadata(scene) {
  const copy = structuredClone(scene);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const metadata = value.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      if (typeof metadata.language === 'string' && !safeEvidenceText(metadata.language)) delete metadata.language;
      if (metadata.languages && typeof metadata.languages === 'object' && !Array.isArray(metadata.languages)) {
        for (const language of Object.keys(metadata.languages)) if (!safeEvidenceText(language)) delete metadata.languages[language];
      }
      for (const field of ['topics', 'sharedLanguages', 'sharedTopics', 'sharedRepositories', 'shared']) {
        if (Array.isArray(metadata[field])) metadata[field] = metadata[field].filter(item => safeEvidenceText(item));
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(copy);
  return copy;
}

export function hierarchyArtifacts(scene) {
  return scene.hierarchy?.scenes.map(entry => ({ id: entry.id, svg: renderSceneSVG(entry.scene), frameSVGs: entry.scene.timeline?.frames.map(frame => renderSceneSVG(frame.scene)) || [] })) || [];
}
export function storyArtifacts(scene) {
  return scene.story?.chapters.map(chapter => ({ svg: renderSceneSVG(chapter.scene), frameSVGs: chapter.scene.timeline?.frames.map(frame => renderSceneSVG(frame.scene)) || [], hierarchyArtifacts: hierarchyArtifacts(chapter.scene) })) || [];
}
