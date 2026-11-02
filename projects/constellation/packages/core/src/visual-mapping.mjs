import { seedHash, seededRandom } from './seeded-random.mjs';
import { boundedSize } from './node-sizing.mjs';
import { updatedTime } from './repository-filters.mjs';

const languageColors = { JavaScript: '#f1e05a', TypeScript: '#3178c6', Rust: '#dea584', Python: '#3572a5', CSS: '#663399', HTML: '#e34c26', Go: '#00add8', Java: '#b07219', Ruby: '#701516', 'C++': '#f34b7d', C: '#555555' };
export function paletteColor(key, seed) {
  const random = seededRandom(`${seed}:${key}`);
  // Bright, moderately saturated RGB colors readable against dark backgrounds.
  return '#' + Array.from({ length: 3 }, () => Math.round(90 + random() * 150).toString(16).padStart(2, '0')).join('');
}
export function metricReference(repositories, value) {
  if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new Error('metricDate must be an ISO date.');
  return value ? Date.parse(value) : Math.max(0, ...repositories.map(updatedTime));
}
export function activityScore(repo, reference) {
  return updatedTime(repo) ? 1 / (1 + Math.max(0, reference - updatedTime(repo)) / (180 * 86400000)) : 0;
}
export function mappedColor(repo, mode = 'custom', seed = '', reference = 0) {
  if (mode === 'custom') return null;
  if (mode === 'language') {
    const key = repo.nodeKind && repo.nodeKind !== 'repository' ? repo.nodeKind === 'contributor' ? 'Contributors' : repo.name : repo.language || repo.name;
    return languageColors[key] || paletteColor(key, 'language');
  }
  if (mode === 'seeded') return paletteColor(repo.full_name, seed);
  if (mode === 'category') return paletteColor(repo.nodeKind === 'repository' || !repo.nodeKind ? repo.topics?.[0] || repo.language || 'Other' : repo.name, 'category');
  if (mode === 'contribution') return ['#263b2c', '#0e4429', '#006d32', '#26a641', '#39d353'][Math.min(4, Math.floor(activityScore(repo, reference) * 5))];
  throw new Error('Invalid node color mode.');
}
export function mappedGlow(repo, mode = 'uniform', seed = '', reference = 0) {
  if (mode === 'uniform') return null;
  if (mode === 'stars') return (boundedSize(repo.stargazers_count || 0) - 2.7) / 3.3;
  if (mode === 'activity') return activityScore(repo, reference);
  if (mode === 'seeded') return seededRandom(`${seed}:glow:${repo.full_name}`)();
  throw new Error('Invalid glow mode.');
}
export function connectionWeight(edge, mode = 'uniform') {
  if (mode === 'uniform') return null;
  const count = mode === 'languages' ? edge.sharedLanguages.length : mode === 'topics' ? edge.sharedTopics.length : mode === 'overlap' ? edge.sharedLanguages.length + edge.sharedTopics.length + (edge.sharedRepositories?.length || 0) : NaN;
  if (!Number.isFinite(count)) throw new Error('Invalid connection weight mode.');
  const strength = Math.min(1, Math.log1p(count) / Math.log(9));
  return { width: .6 + strength * 1.8, opacity: .15 + strength * .6 };
}

export function mappingOptions(options) {
  for (const [key, values] of Object.entries({ nodeColorMode: ['custom', 'language', 'seeded', 'category', 'contribution'], nodeGlowMode: ['uniform', 'stars', 'activity', 'seeded'], connectionWeight: ['uniform', 'languages', 'topics', 'overlap'], nodeShape: ['circle', 'star', 'diamond', 'hexagon', 'square', 'mixed'], effect: ['none', 'grid', 'scanlines', 'coordinates'] })) {
    if (options[key] !== undefined && !values.includes(options[key])) throw new Error(`Invalid ${key}.`);
  }
  if (options.legend !== undefined && typeof options.legend !== 'boolean') throw new Error('legend must be boolean.');
}

export function shapeFor(node, shape = 'circle') {
  return shape === 'mixed' ? ({ language: 'hexagon', topic: 'diamond' }[node.nodeKind] || 'circle') : shape;
}
export const shapeDefinitions = `<clipPath id="shape-diamond" clipPathUnits="objectBoundingBox"><path d="M.5 0 1 .5 .5 1 0 .5Z"/></clipPath><clipPath id="shape-square" clipPathUnits="objectBoundingBox"><path d="M.15 .15H.85V.85H.15Z"/></clipPath><clipPath id="shape-hexagon" clipPathUnits="objectBoundingBox"><path d="M.25 .07H.75L1 .5 .75 .93H.25L0 .5Z"/></clipPath><clipPath id="shape-star" clipPathUnits="objectBoundingBox"><path d="M.5 0 .62 .34 .98 .35 .7 .57 .8 .93 .5 .72 .2 .93 .3 .57 .02 .35 .38 .34Z"/></clipPath>`;

export function decoration(options, height, nodes) {
  const effect = options.effect || 'none';
  const lines = effect === 'scanlines' ? Array.from({ length: Math.floor(height / 6) }, (_, i) => `<path d="M0 ${i * 6}H900"/>`).join('')
    : effect === 'grid' ? Array.from({ length: 19 }, (_, i) => `<path d="M${i * 50} 0V${height}"/>`).join('') + Array.from({ length: Math.floor(height / 50) }, (_, i) => `<path d="M0 ${i * 50}H900"/>`).join('') : '';
  const text = effect === 'coordinates' ? nodes.slice(0, 12).map(({ repo, x, y }) => `<text x="${(x + 9).toFixed(1)}" y="${(y + 10).toFixed(1)}">0x${seedHash(repo.full_name).toString(16).slice(0, 4)}</text>`).join('') : '';
  return lines || text ? `<g class="decoration" aria-hidden="true" opacity=".12" stroke="var(--sky-line)" stroke-width=".5" font-family="monospace" font-size="7">${lines}${text}</g>` : '';
}
