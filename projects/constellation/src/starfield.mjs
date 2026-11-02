import { seededRandom } from './seeded-random.mjs';

export const defaultStarfield = { mode: 'space', density: 55, brightness: .8, depth: .8, twinkle: true, seed: '' };

// Keep the historical dust sequence shared by ordinary and temporal worlds.
export function renderClassicDust(seed, { compact = false, count = 85 } = {}) {
  const hash = value => {
    let n = [...value].reduce((n, char) => (Math.imul(n, 31) + char.charCodeAt(0)) >>> 0, 7);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return (n ^ (n >>> 16)) >>> 0;
  };
  return Array.from({ length: count }, (_, i) => `<circle cx="${20 + hash(`${seed}:x:${i}`) % 860}" cy="${(compact ? 58 : 90) + hash(`${seed}:y:${i}`) % (compact ? 180 : 405)}" r="${i % 3 ? '.6' : '1'}" opacity=".25"/>`).join('');
}

export function starfieldOptions(value) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('starfield must be an object.');
  const options = { ...defaultStarfield, mode: 'classic', ...value };
  if (Object.keys(options).some(key => !Object.hasOwn(defaultStarfield, key))) throw new Error('Unknown starfield setting.');
  if (!['off', 'classic', 'space', 'milky-way'].includes(options.mode)) throw new Error('Invalid starfield mode.');
  for (const [key, max] of [['density', 100], ['brightness', 1], ['depth', 1]]) {
    if (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > max) throw new Error(`Starfield ${key} must be between 0 and ${max}.`);
  }
  if (typeof options.twinkle !== 'boolean' || typeof options.seed !== 'string' || options.seed.length > 120) throw new Error('Invalid starfield twinkle or seed.');
  return options;
}

// A separate random stream keeps decorative stars stable when graph data changes.
// Increasing density extends the same point sequence instead of moving the sky.
export function generateStarfield(seed, value, { width = 900, height = 560, densityHeight = height, detail = 1 } = {}) {
  const options = starfieldOptions(value);
  if (!Number.isFinite(width) || width < 12 || width > 4000 || !Number.isFinite(height) || height < 12 || height > 4000 || !Number.isFinite(densityHeight) || densityHeight < 12 || densityHeight > 4000 || !Number.isFinite(detail) || detail < 0 || detail > 1) throw new Error('Invalid starfield bounds.');
  if (!['space', 'milky-way'].includes(options.mode)) return [];
  const count = Math.min(500, Math.round(500 * options.density / 100 * Math.min(1, densityHeight / 560) * detail));
  const random = seededRandom(`starfield-v1:${options.seed || seed}`);
  const points = [];
  for (let i = 0; i < count; i++) {
    const x = random(), y = random(), distance = random(), spread = random(), band = random(), temperature = random(), variation = random(), phase = random();
    const gaussian = Math.sqrt(-2 * Math.log(Math.max(1e-8, y))) * Math.cos(2 * Math.PI * spread);
    const bandY = .5 + .2 * Math.sin(x * Math.PI * 1.4 - .7) + gaussian * .09;
    const layer = distance < .72 ? 'far' : distance < .95 ? 'middle' : 'near';
    const radius = layer === 'far' ? .3 + variation * .3 : layer === 'middle' ? .65 + variation * .35 : 1 + variation * .5;
    const opacity = layer === 'far' ? .16 + variation * .22 : layer === 'middle' ? .35 + variation * .3 : .65 + variation * .25;
    points.push({ x: 6 + x * (width - 12), y: 6 + Math.max(0, Math.min(1, options.mode === 'milky-way' && band < .78 ? bandY : y)) * (height - 12),
      radius: .6 + (radius - .6) * options.depth, opacity: .35 + (opacity - .35) * options.depth,
      layer, tone: temperature < .08 ? 'warm' : temperature > .88 ? 'cool' : 'neutral',
      sparkle: layer === 'near' && variation > .65 && options.depth > .5,
      twinkle: options.twinkle && layer !== 'far' && variation > .45, duration: 6 + variation * 8, delay: -phase * 14,
    });
  }
  return points;
}

export const starfieldCSS = `
.starfield{pointer-events:none}.starfield-point,.starfield-spark{fill:var(--sky-foreground)}
.starfield .tone-cool{fill:#bdd9ff}.starfield .tone-warm{fill:#ffe0b3}
.starfield-twinkle{animation:sky-shimmer var(--sky-duration) ease-in-out var(--sky-delay) infinite}
@keyframes sky-shimmer{0%,100%{opacity:var(--sky-opacity)}50%{opacity:calc(var(--sky-opacity)*.4)}}
@media(prefers-reduced-motion:reduce){.starfield-twinkle{animation:none}}
`;

export function renderStarfield(seed, value, { x = 0, y = 0, width = 900, height = 560, densityHeight = height, detail = 1, animate = true, transparent = false } = {}) {
  const options = starfieldOptions(value);
  const stars = generateStarfield(seed, options, { width, height, densityHeight, detail });
  if (!stars.length || !options.brightness) return '';
  const haze = options.mode === 'milky-way' && !transparent
    ? `<defs><radialGradient id="starfield-haze"><stop stop-color="var(--sky-accent)" stop-opacity=".045"/><stop offset="1" stop-color="var(--sky-accent)" stop-opacity="0"/></radialGradient></defs>` + [0, 1, 2, 3, 4].map(i => `<ellipse cx="${(x + width * (.1 + i * .2)).toFixed(1)}" cy="${(y + height * (.5 + .2 * Math.sin((i + .5) / 5 * Math.PI * 1.4 - .7))).toFixed(1)}" rx="${(width * (240 / 900)).toFixed(1)}" ry="${(height * .2).toFixed(1)}" fill="url(#starfield-haze)"/>`).join('') : '';
  const points = stars.map(star => {
    const opacity = star.opacity.toFixed(3);
    const motion = animate && star.twinkle;
    const px = x + star.x, py = y + star.y;
    const circle = `<circle class="starfield-point tone-${star.tone}${motion ? ' starfield-twinkle' : ''}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${star.radius.toFixed(2)}" opacity="${opacity}"${motion ? ` style="--sky-opacity:${opacity};--sky-duration:${star.duration.toFixed(1)}s;--sky-delay:${star.delay.toFixed(1)}s"` : ''}/>`;
    const sx = px, sy = py, r = star.radius * 2;
    const spark = star.sparkle ? `<path class="starfield-spark" opacity=".2" d="M${(sx - r).toFixed(1)} ${sy.toFixed(1)}l${(r * .8).toFixed(1)} -.3 .3 -${(r * .8).toFixed(1)} .3 ${ (r * .8).toFixed(1)} ${ (r * .8).toFixed(1)} .3 -${(r * .8).toFixed(1)} .3 -.3 ${ (r * .8).toFixed(1)} -.3 -${(r * .8).toFixed(1)}Z"/>` : '';
    return circle + spark;
  }).join('');
  return `<g class="dust starfield" aria-hidden="true" pointer-events="none"><g opacity="${options.brightness}">${haze}${points}</g></g>`;
}
