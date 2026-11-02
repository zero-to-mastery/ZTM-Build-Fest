import { seededRandom } from './seeded-random.mjs';
import { visualThemes, themePalettes } from './themes.mjs';

export const compositionFields = {
  styling: ['visualTheme','theme','colors','nodeColors','nodeColorMode','visualStyle','nodeShape','nodeGlowMode','nodeSize','sizingMode','effect','css','customCSS'],
  layout: ['layout','exportProfile','arrangement','nodeMode','snapToRings','identityRing','ringRotation','ringRotations','ringPlacements','starPositions','labelPositions','labelOffsets','temporalStack','temporalGeometry','layoutRefinement','profileEmphasis','layoutEngine','layoutOptions','nodeCap','simplifyAbove'],
  semantics: ['ringMeaning','accountSun','semanticLegend','ringOrganization'],
  connections: ['connectionBasis','connectionDensity','connectionWeight','colorConnections','bridges'],
  repositories: ['includeRepos','maxRepos','repoSource','includeForks','includeArchived','minStars','updatedWithin','repoQuery','languages','topics','sortBy','hiddenNodes','showOther'],
  animations: ['animate','starlightAnimate','activityAnimate','codingRhythmAnimate','ringAnimation','floatingAnimation'],
};
export function lockRandomParts(current, candidate, locks = {}) {
  const result = structuredClone(candidate);
  const retain = key => { if (Object.hasOwn(current,key)) result[key] = structuredClone(current[key]); else delete result[key]; };
  for (const [part, locked] of Object.entries(locks)) if (locked) for (const key of compositionFields[part] || []) retain(key);
  if (locks.styling) result.starfield = {...current.starfield, twinkle: result.starfield?.twinkle};
  if (locks.animations) {
    result.starfield = {...result.starfield, twinkle: current.starfield?.twinkle ?? false};
    result.perspective = {...result.perspective, animate: current.perspective?.animate ?? false, range: current.perspective?.range ?? 5, duration: current.perspective?.duration ?? 12};
    result.contributionOrbit = {...result.contributionOrbit, animate: current.contributionOrbit?.animate ?? false};
    if (current.history) result.history = structuredClone(current.history);
  }
  // A semantic composition includes its layout and project node representation.
  if (locks.semantics && current.ringMeaning && current.ringMeaning !== 'identity') {
    for (const key of compositionFields.layout) retain(key);
  }
  retain('projectShowcase');
  retain('projectRelationships');
  if (Object.values(locks).some(Boolean)) delete result.designCode;
  return result;
}
export function changedParts(before, after) {
  const result = Object.keys(compositionFields).filter(part => compositionFields[part].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])));
  if (JSON.stringify(before.starfield) !== JSON.stringify(after.starfield) && !result.includes('styling')) result.push('styling');
  if (['perspective','contributionOrbit','history'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])) && !result.includes('animations')) result.push('animations');
  return result;
}

// Partial draws retain the account, topology, filters and all unselected settings.
export function randomizeParts(current, recipe, parts, repositories = []) {
  const options = structuredClone(current);
  const copy = keys => { for (const key of keys) options[key] = structuredClone(recipe[key]); };
  if (parts.layout) copy(compositionFields.layout.filter(key => Object.hasOwn(recipe,key)));
  if (parts.connections) copy(compositionFields.connections.filter(key => Object.hasOwn(recipe,key)));
  if (parts.semantics) {
    const random = seededRandom(`${recipe.designCode}:semantics`);
    options.ringMeaning = ['identity','capability','showcase','activity','era'][Math.floor(random()*5)];
    options.arrangement = 'rings'; options.nodeMode = 'repositories';
    options.temporalStack = {...current.temporalStack, enabled:false};
    delete options.layoutEngine; delete options.layoutOptions;
  }
  if (parts.styling) {
    copy(['visualTheme', 'nodeShape', 'nodeGlowMode', 'connectionWeight', 'colorConnections', 'effect']);
    const theme = visualThemes[recipe.visualTheme];
    options.theme = 'auto'; options.colors = {}; options.nodeColors = {};
    options.nodeColorMode = recipe.nodeColorMode;
    options.visualStyle = { ...recipe.visualStyle, ...themePalettes(theme), glow: theme.glow, secondaryOpacity: theme.opacity,
      labels: current.visualStyle?.labels ?? true };
    options.starfield = { ...recipe.starfield, twinkle: current.starfield?.twinkle ?? false };
    options.css = ''; options.customCSS = '';
  }
  if (parts.animations) {
    copy(['animate', 'starlightAnimate', 'activityAnimate', 'codingRhythmAnimate', 'ringAnimation', 'floatingAnimation']);
    options.starfield = { ...options.starfield, twinkle: recipe.starfield.twinkle };
    options.perspective = { ...current.perspective, animate: recipe.perspective.animate,
      range: recipe.perspective.range, duration: recipe.perspective.duration };
    options.contributionOrbit = { ...current.contributionOrbit, animate: recipe.contributionOrbit.animate };
    if (current.history?.timeLapse?.enabled) options.history.timeLapse = {
      ...current.history.timeLapse, mode: recipe.history.timeLapse.mode, duration: recipe.history.timeLapse.duration,
    };
  }
  if (parts.repositories) {
    const ids = [...new Set(repositories.map(repo => repo.full_name))].sort();
    if (!ids.length) throw new Error('No repositories match your current filters. Adjust the filters before shuffling projects.');
    const random = seededRandom(`${recipe.designCode}:repositories`);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const limit = Math.min(ids.length, current.maxRepos || 45);
    const minimum = Math.min(5, limit);
    const count = minimum + Math.floor(random() * (limit - minimum + 1));
    options.includeRepos = ids.slice(0, count);
  }
  // A recipe code alone cannot recreate a design assembled from several draws.
  delete options.designCode;
  return options;
}
