import { seededRandom, newSeed } from './seeded-random.mjs';
// Frozen with the v5 format: adding selectable themes must not change old recipes.
const v5Themes = ['mnix', 'github-dark', 'deep-space', 'terminal', 'solarized', 'dracula', 'synthwave', 'monochrome', 'contribution', 'rustacean', 'javascript'];

// Bit order is part of the v5 format. Never reorder released entries.
export const motionParts = Object.freeze([
  ['starlight', 'Repository twinkle'], ['starfield', 'Background stars'],
  ['ring1', 'Ring 1 · inner'], ['ring2', 'Ring 2'], ['ring3', 'Ring 3'], ['ring4', 'Ring 4 · outer'],
  ['floating', 'Floating nodes'], ['perspective', 'Perspective'], ['activity', 'Activity effects'],
  ['codingRhythm', 'Coding rhythm'], ['contributionOrbit', 'Contribution orbit'], ['timeLapse', 'Time-lapse'],
]);
export function newV5Code({ motion = true, animations = {}, firstYear, year = new Date().getUTCFullYear() } = {}) {
  firstYear ??= Math.max(1970, year - 8);
  if (!Number.isInteger(year) || !Number.isInteger(firstYear) || firstYear < 1970 || year > 9998 || firstYear > year) throw new Error('Invalid design history range.');
  const mask = motionParts.reduce((value, [key], i) => value | (motion && animations[key] !== false ? 1 << i : 0), 0);
  return `v5:m${mask.toString(16).padStart(3, '0')}-y${year}-f${firstYear}-${newSeed()}`;
}
export function v5Parameters(code) {
  const match = /^v5:m([0-9a-f]{3})-y(\d{4})-f(\d{4})-([a-z\d-]+)$/i.exec(code);
  if (!match || code.length > 103) throw new Error('Invalid v5 design code.');
  const mask = parseInt(match[1], 16), year = Number(match[2]), firstYear = Number(match[3]);
  if (firstYear < 1970 || year > 9998 || firstYear > year) throw new Error('Invalid design history range.');
  return { year, firstYear, animations: Object.fromEntries(motionParts.map(([key], i) => [key, !!(mask & (1 << i))])) };
}
export function randomizeV5(code) {
  const { animations: motion, year, firstYear } = v5Parameters(code);
  // Motion choices do not change the random draw sequence or the visual recipe.
  const random = seededRandom(code.replace(/^v5:m[0-9a-f]{3}/i, 'v5:visual'));
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
  const pick = values => values[integer(0, values.length - 1)];
  const bool = () => random() < .5;
  const decimal = (min, max, step = .05) => Number((integer(Math.round(min / step), Math.round(max / step)) * step).toFixed(3));
  const visualTheme = pick(v5Themes);
  const palette = dark => Object.fromEntries(['background', 'foreground', 'accent', 'line', 'star'].map((key, i) => {
    const ranges = dark ? [[4, 28], [185, 245], [100, 235], [55, 125], [130, 250]] : [[235, 255], [20, 65], [35, 125], [100, 160], [20, 100]];
    const [min, max] = ranges[i];
    return [key, '#' + Array.from({ length: 3 }, () => integer(min, max).toString(16).padStart(2, '0')).join('')];
  }));
  const visualStyle = { light: palette(false), dark: palette(true), lineWidth: decimal(.5, 2, .1), lineOpacity: decimal(.3, .9), secondaryOpacity: decimal(.05, .3), bridgeOpacity: decimal(.1, .5), glow: decimal(0, 5, .5), dustOpacity: decimal(.1, .8), labelSize: integer(9, 14), labels: bool() };
  const ring = Array.from({ length: 4 }, () => ({ rotation: integer(0, 359), speed: decimal(.25, 3, .25), direction: pick(['clockwise', 'counterclockwise']), mode: pick(['spin', 'sway']), amplitude: integer(1, 24) * 5, easing: pick(['linear', 'smooth']) }));
  const linked = bool();
  const shared = ring.map((value, i) => linked ? ring[0] : ring[i]);
  const rawHistoryMode = pick(['current', 'historical', 'time-lapse']);
  const chosenYear = integer(firstYear, year);
  const historyMode = rawHistoryMode === 'time-lapse' && !motion.timeLapse ? 'current' : rawHistoryMode;
  const recipe = {
    designCode: code, seedMode: 'custom', seed: code.replace(/^v5:m[0-9a-f]{3}/i, 'v5:visual'), visualTheme, theme: pick(['auto', 'midnight', 'light']), colors: {}, visualStyle,
    arrangement: pick(['field', 'rings', 'orbital', 'force', 'galaxy', 'solar-system']), layout: pick(['atlas', 'compact']), exportProfile: pick(['custom', 'profile', 'repository', 'compact', 'hero', 'transparent']),
    maxRepos: integer(2, 20) * 5, includeForks: bool(), includeArchived: bool(), minStars: pick([0, 0, 0, 1, 5, 10]), updatedWithin: pick([0, 0, 1, 2, 5]), sortBy: pick(['stars', 'updated', 'name']), repoQuery: '',
    nodeMode: pick(['repositories', 'languages', 'topics', 'combined']), nodeSize: pick(['legacy', 'uniform', 'stars', 'activity', 'age', 'languages', 'topics', 'membership']), nodeColorMode: pick(['custom', 'language', 'seeded', 'category', 'contribution']), nodeGlowMode: pick(['uniform', 'stars', 'activity', 'seeded']), nodeShape: pick(['circle', 'star', 'diamond', 'hexagon', 'square', 'mixed']),
    connectionWeight: pick(['uniform', 'languages', 'topics', 'overlap']), connectionBasis: pick(['languages', 'topics', 'both']), connectionDensity: pick(['balanced', 'all']), bridges: bool(), colorConnections: bool(), majorMetric: pick(['stars', 'updated']),
    effect: pick(['none', 'grid', 'scanlines', 'coordinates']), legend: bool(), identityRing: bool(), snapToRings: bool(), showOther: bool(),
    animate: Object.values(motion).some(Boolean), starlightAnimate: motion.starlight, activityAnimate: motion.activity,
    ringRotations: ring.map(value => value.rotation),
    ringAnimation: { enabled: [1, 2, 3, 4].some(i => motion[`ring${i}`]), linked: linked && [1, 2, 3, 4].every(i => motion[`ring${i}`] === motion.ring1), speeds: shared.map((value, i) => motion[`ring${i + 1}`] ? value.speed : 0), directions: shared.map(value => value.direction), modes: shared.map(value => value.mode), amplitudes: shared.map(value => value.amplitude), easing: shared.map(value => value.easing) },
    floatingAnimation: { enabled: motion.floating, mode: pick(['drift', 'bob', 'orbit']), amplitude: integer(1, 20), duration: integer(8, 60) },
    perspective: { enabled: bool(), animate: motion.perspective, horizontal: integer(-55, 55), vertical: integer(0, 65), zoom: integer(60, 100), range: integer(1, 25), duration: integer(8, 60) },
    starfield: { mode: pick(['off', 'classic', 'space', 'milky-way']), density: integer(10, 100), brightness: decimal(.2, 1), depth: decimal(0, 1), twinkle: motion.starfield, seed: `${code.slice(-16)}-sky` },
    activityEffect: pick(['off', 'glow', 'pulse', 'comet', 'ripple']), activityWindow: pick(['1d', '7d', '30d', 'auto']), activityDetail: pick(['simple', 'event-types']), activityConnections: bool(),
    codingRhythm: bool(), codingRhythmStyle: pick(['orbit', 'active-arc', 'halo', 'hidden']), codingRhythmWindow: pick(['7d', '14d', '30d']), codingRhythmTimezone: 'UTC', codingRhythmDays: pick(['off', 'subtle', 'full']), codingRhythmAnimate: motion.codingRhythm, codingRhythmPeakLabel: bool(), codingRhythmLabels: pick(['none', 'quarters', 'cardinal']), codingRhythmCelestialMarkers: bool(), codingRhythmProjectHints: bool(),
    history: { mode: historyMode, year: historyMode === 'historical' ? chosenYear : null, maxHistoricalFrames: integer(2, 8), timeLapse: { enabled: historyMode === 'time-lapse', mode: pick(['grow', 'crossfade', 'orbit']), duration: integer(8, 30), loop: bool() } },
    contributionOrbit: { enabled: bool(), period: '52w', granularity: 'week', style: pick(['segments', 'dots', 'pulse-ring']), showCurrent: bool(), animate: motion.contributionOrbit },
    languageEvolution: { enabled: bool(), style: pick(['rings', 'timeline', 'trails', 'eras']), buckets: pick(['automatic', 'yearly', '2-year']) },
    stellarAges: { enabled: bool(), mode: pick(['appearance', 'color', 'halo', 'subtle']), showArchivedRemnants: bool(), thresholds: { newborn: pick([30, 60, 90]), active: pick([7, 14, 30]), mature: pick([180, 365, 730]), quiet: pick([90, 180, 270]), dormant: pick([365, 540, 730]) } },
    foreignGalaxies: { enabled: bool(), limit: integer(1, 12), minimumContribution: pick(['any', 'issue', 'pr', 'merged-pr', 'code']), layout: 'outer' },
    nodeColors: {}, starPositions: {}, labelPositions: {}, labelOffsets: {}, hiddenNodes: [], hiddenLabels: [], selection: {}, css: '', customCSS: '',
  };
  return recipe;
}
