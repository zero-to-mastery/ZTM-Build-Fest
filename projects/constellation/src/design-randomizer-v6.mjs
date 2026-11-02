import { seededRandom } from './seeded-random.mjs';
import { newV5Code, randomizeV5, v5Parameters } from './design-randomizer-v5.mjs';

// Eligibility is captured in the code. Replaying never consults today's clock.
export function temporalEligibility(repositories = [], snapshots = [], year) {
  const validYear = value => { if (typeof value !== 'string') return null; const y = new Date(value).getUTCFullYear(); return y >= 1970 && y <= year ? y : null; };
  const years = [...new Set(repositories.map(repo => validYear(repo.created_at)).filter(y => y !== null))].sort((a, b) => a - b);
  const observed = [...new Set([...snapshots.filter(frame => frame.records?.length >= 4).map(frame => validYear(frame.date)), ...(repositories.length >= 4 ? [year] : [])].filter(y => y !== null && y >= year - 19))].sort((a, b) => a - b);
  const eligible = snapshots.length ? observed.length >= 3 : repositories.length >= 6 && years.length >= 3;
  return { eligible, firstYear: eligible ? Math.min(...(snapshots.length ? observed : years)) : year };
}

export function newV6Code({ repositories = [], snapshots = [], year = new Date().getUTCFullYear(), ...settings } = {}) {
  const history = temporalEligibility(repositories, snapshots, year);
  return newV5Code({ ...settings, year, firstYear: history.eligible ? history.firstYear : settings.firstYear ?? year })
    .replace('v5:', 'v6:').replace(/(-f\d{4})-/, `$1-e${Number(history.eligible)}-`);
}

export function v6Parameters(code) {
  if (typeof code !== 'string' || !/^v6:m[0-9a-f]{3}-y\d{4}-f\d{4}-e[01]-[a-z\d-]+$/i.test(code) || code.length > 106) throw new Error('Invalid v6 design code.');
  const legacy = code.replace(/^v6:/i, 'v5:').replace(/-e[01]-/, '-');
  const parameters = v5Parameters(legacy);
  return { ...parameters, eligible: /-e1-/.test(code) && parameters.year - parameters.firstYear >= 2, legacy };
}

export function randomizeV6(code, context = {}) {
  const { year, firstYear, eligible, legacy, animations } = v6Parameters(code);
  const base = randomizeV5(legacy);
  const seed = code.replace(/^v6:m[0-9a-f]{3}/i, 'v6:visual');
  const random = seededRandom(`${seed}:temporal`);
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
  const pick = values => values[integer(0, values.length - 1)];
  const recipe = { ...base, designCode: code, seed, referenceDate: `${year}-12-31T23:59:59.999Z` };
  const available = context.repositories === undefined || temporalEligibility(context.repositories, context.snapshots, year).eligible;
  if (!eligible || !available || random() >= .28) return recipe;
  const shape = pick(['stack', 'stack', 'cylinder', 'cylinder', 'cylinder', 'sphere', 'sphere', 'sphere', 'dome', 'dome', 'cone', 'hourglass', 'helix']);
  const radius = integer(27, 36) * 10;
  Object.assign(recipe, {
    arrangement: 'temporal-stack', layout: 'atlas', exportProfile: 'custom', nodeMode: 'repositories',
    maxRepos: 36, minStars: 0, updatedWithin: 0, includeArchived: true, includeForks: true,
    nodeShape: 'circle', nodeSize: 'stars', nodeColorMode: 'language', effect: 'none', legend: false,
    theme: 'midnight', visualTheme: 'deep-space', visualStyle: { ...base.visualStyle,
      light: { background: '#080e20', foreground: '#e6edff', accent: '#9ab9ff', line: '#596f98', star: '#f6d99b' },
      dark: { background: '#080e20', foreground: '#e6edff', accent: '#9ab9ff', line: '#596f98', star: '#f6d99b' },
      glow: 2.5, lineWidth: .8, lineOpacity: .45, secondaryOpacity: .12, labelSize: 11, dustOpacity: .8, labels: true },
    identityRing: true, snapToRings: true, bridges: false, colorConnections: false,
    temporalStack: { enabled: true, innerArrangement: 'rings', yearStart: firstYear, yearEnd: year, yearStep: Math.max(1, Math.ceil((year - firstYear) / 5)), tilt: integer(28, 48) / 100, perspective: integer(25, 60) / 100, connections: 'same-node' },
    temporalGeometry: { shape, radius, depth: shape === 'sphere' ? radius * 2 : shape === 'dome' ? radius : integer(48, 75) * 10,
      startRadius: radius, endRadius: integer(10, 18) * 10, waist: integer(35, 55) / 100,
      twist: shape === 'helix' ? pick([-180, 180, 240]) : 0, surface: pick(['wireframe', 'wireframe', 'off', 'translucent']),
      orientation: { x: integer(-8, 8), y: integer(-20, 20), z: integer(-5, 5) } },
    starfield: { mode: shape === 'helix' ? 'milky-way' : pick(['space', 'space', 'milky-way', 'classic']), density: integer(40, 65), brightness: .85, depth: .8, twinkle: animations.starfield, seed: `${seed}-sky` },
    perspective: { ...base.perspective, enabled: true, animate: animations.perspective, range: 5, duration: 48 },
    floatingAnimation: { enabled: animations.floating, mode: 'drift', amplitude: 3, duration: 60 },
    ringAnimation: { ...base.ringAnimation, linked: false, speeds: base.ringAnimation.speeds.map((speed, i) => animations[`ring${i + 1}`] && i % 2 === 1 ? .25 : 0), modes: Array(4).fill('sway'), amplitudes: Array(4).fill(15) },
    ringPlacements: structuredClone(context.ringPlacements || {}),
    history: { ...base.history, mode: base.history.timeLapse.enabled ? 'time-lapse' : 'current', year: null },
    languageEvolution: { ...base.languageEvolution, enabled: false },
  });
  if (context.snapshots?.length) {
    recipe.timeline = { referenceDate: recipe.referenceDate, snapshots: structuredClone(context.snapshots) };
    recipe.temporalStack.yearStart = Math.max(firstYear, year - 19);
    recipe.temporalStack.yearStep = 1;
  }
  return recipe;
}
