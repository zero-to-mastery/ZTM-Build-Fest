import { seededRandom } from './seeded-random.mjs';
import { visualThemes } from './themes.mjs';
import { randomizeV5 } from './design-randomizer-v5.mjs';
import { newV6Code, randomizeV6 } from './design-randomizer-v6.mjs';

export const newDesignCode = newV6Code;

// Only the Randomize action uses this search. Restoring a code remains exact.
// Bound attempts so an empty source cannot leave the studio in an endless loop.
export function randomizeMatchingDesign(makeCode, matches, maxAttempts = 256, context = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const recipe = randomizeDesign(makeCode(), context);
    if (matches(recipe)) return recipe;
  }
  return null;
}

// Freeze released recipes: future recipes get a new prefix so shared codes never drift.
export function randomizeDesign(code, context = {}) {
  if (typeof code === 'string' && /^v6:/i.test(code)) return randomizeV6(code, context);
  if (typeof code === 'string' && /^v5:/i.test(code)) return randomizeV5(code);
  if (typeof code === 'string' && /^v4:[a-z\d-]{1,100}$/i.test(code)) {
    const base = randomizeDesign(code.replace(/^v4:/i, 'v2:'));
    const random = seededRandom(`${code}:independent-motion`);
    const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
    const pick = values => values[integer(0, values.length - 1)];
    const enabled = !code.slice(3).startsWith('still-');
    const rings = Array.from({ length: 4 }, () => ({
      rotation: integer(0, 359), speed: integer(1, 6) * .25,
      direction: pick(['clockwise', 'counterclockwise']),
      mode: pick(['spin', 'sway']), amplitude: integer(2, 12) * 5,
      easing: pick(['linear', 'smooth']),
    }));
    // These layers can combine, rather than selecting one exclusive motion preset.
    const tilted = random() < .85;
    return { ...base, designCode: code, seed: code, animate: enabled,
      ringRotations: rings.map(ring => ring.rotation),
      ringAnimation: { enabled, linked: false,
        speeds: rings.map(ring => ring.speed), directions: rings.map(ring => ring.direction),
        modes: rings.map(ring => ring.mode), amplitudes: rings.map(ring => ring.amplitude), easing: rings.map(ring => ring.easing) },
      floatingAnimation: { enabled: enabled && base.arrangement !== 'rings', mode: pick(['drift', 'bob', 'orbit']), amplitude: integer(3, 10), duration: integer(10, 30) },
      perspective: { enabled: tilted, animate: enabled && tilted && random() < .8,
        horizontal: integer(-35, 35), vertical: integer(10, 50), zoom: integer(75, 100), range: integer(4, 18), duration: integer(16, 50) },
    };
  }
  if (typeof code === 'string' && /^v3:[a-z\d-]{1,100}$/i.test(code)) {
    const base = randomizeDesign(code.replace(/^v3:/i, 'v2:'));
    const random = seededRandom(`${code}:motion`);
    const enabled = !code.slice(3).startsWith('still-');
    const style = Math.floor(random() * 4);
    const speed = .25 + Math.floor(random() * 3) * .25;
    return { ...base, designCode: code, seed: code, animate: enabled,
      arrangement: enabled && style < 2 ? 'rings' : enabled && style === 2 && base.arrangement === 'rings' ? 'orbital' : base.arrangement,
      ringAnimation: { enabled: enabled && style < 2, linked: true, speeds: Array(4).fill(speed), directions: Array(4).fill(random() < .5 ? 'clockwise' : 'counterclockwise'), modes: Array(4).fill(style === 0 ? 'sway' : 'spin'), amplitudes: Array(4).fill(10 + Math.floor(random() * 3) * 5), easing: Array(4).fill(style === 0 ? 'smooth' : 'linear') },
      floatingAnimation: { enabled: enabled && style === 2, mode: ['drift', 'bob', 'orbit'][Math.floor(random() * 3)], amplitude: 3 + Math.floor(random() * 5), duration: 12 + Math.floor(random() * 12) },
      perspective: { enabled: enabled && style === 3, animate: enabled && style === 3, horizontal: Math.floor(random() * 20) - 10, vertical: 25, zoom: 90, range: 5 + Math.floor(random() * 5), duration: 25 + Math.floor(random() * 15) },
    };
  }
  if (typeof code === 'string' && /^v2:[a-z\d-]{1,100}$/i.test(code)) {
    const random = seededRandom(`${code}:sky`);
    return { ...randomizeDesign(code.replace(/^v2:/i, 'v1:')), designCode: code, seed: code,
      starfield: { mode: random() < .65 ? 'space' : 'milky-way', density: 35 + Math.floor(random() * 36), brightness: .8, depth: .8, twinkle: true, seed: '' } };
  }
  if (typeof code !== 'string' || !/^v1:[a-z\d-]{1,100}$/i.test(code)) throw new Error('Use a valid v1:, v2:, v3:, v4: v5: or v6: design code.');
  const random = seededRandom(code);
  const pick = values => values[Math.floor(random() * values.length)];
  const visualTheme = pick(['github-dark', 'deep-space', 'terminal', 'solarized', 'dracula', 'synthwave', 'monochrome', 'contribution', 'rustacean', 'javascript']);
  const preset = visualThemes[visualTheme];
  const palette = Object.fromEntries(['background', 'foreground', 'accent', 'line', 'star'].map((key, i) => [key, preset.palette[i]]));
  return {
    designCode: code, seedMode: 'custom', seed: code, visualTheme, theme: 'auto', colors: {},
    arrangement: pick(['rings', 'orbital', 'galaxy', 'solar-system']),
    layout: pick(['atlas', 'compact']), exportProfile: 'custom',
    nodeSize: pick(['stars', 'activity', 'uniform', 'languages', 'topics']),
    nodeColorMode: pick(['custom', 'language', 'seeded', 'category']),
    nodeGlowMode: pick(['uniform', 'stars', 'activity', 'seeded']),
    connectionWeight: pick(['uniform', 'overlap', 'languages']),
    nodeShape: pick(['circle', 'circle', 'mixed', 'diamond', 'hexagon']),
    effect: pick(['none', 'none', 'grid', 'coordinates']), legend: false,
    animate: preset.animate ?? true, bridges: false,
    ringRotations: Array.from({ length: 4 }, () => Math.floor(random() * 360)),
    ringAnimation: { enabled: false }, floatingAnimation: { enabled: false }, perspective: { enabled: false },
    identityRing: true, snapToRings: true, colorConnections: false,
    nodeColors: {}, starPositions: {}, labelPositions: {}, labelOffsets: {}, hiddenNodes: [], hiddenLabels: [], selection: {},
    css: '', customCSS: '',
    visualStyle: { light: { ...palette }, dark: { ...palette }, lineWidth: .9, lineOpacity: .8, secondaryOpacity: preset.opacity, bridgeOpacity: .35, glow: preset.glow, dustOpacity: .6, labelSize: 11, labels: true },
  };
}
