import { seededRandom } from './seeded-random.mjs';

export const activityCSS = `
.activity-halo,.activity-ring{pointer-events:none;fill:var(--node-color,var(--sky-star))}.activity-ring{fill:none;stroke:var(--node-color,var(--sky-star));stroke-width:.8}
.activity-comet{pointer-events:none;fill:none;stroke:var(--node-color,var(--sky-star));stroke-linecap:round}
.activity-pulse{animation:activity-pulse var(--activity-duration) ease-in-out var(--activity-delay) infinite}
.activity-ripple{transform-box:fill-box;transform-origin:center;animation:activity-ripple var(--activity-duration) ease-out var(--activity-delay) infinite}
.activity-streak{stroke-dasharray:var(--activity-dash);animation:activity-comet var(--activity-duration) linear var(--activity-delay) infinite}
@keyframes activity-pulse{0%,100%{opacity:var(--activity-opacity)}50%{opacity:calc(var(--activity-opacity)*.4)}}
@keyframes activity-ripple{0%,100%{transform:scale(1);opacity:var(--activity-opacity)}80%{transform:scale(1.6);opacity:.04}}
@keyframes activity-comet{from{stroke-dashoffset:var(--activity-travel)}to{stroke-dashoffset:0}}
@media(prefers-reduced-motion:reduce){.activity-pulse,.activity-ripple,.activity-streak{animation:none}.activity-ripple{transform:none}.activity-streak{stroke-dasharray:none;opacity:.3}}
`;

export function cometGeometry(x, y, score, seed, id) {
  const random = seededRandom(`${seed}:activity:${id}`), angle = random() * Math.PI * 2;
  const length = 12 + Math.max(0, Math.min(1, score)) * 20;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  return { path: `M${(x - dx * length).toFixed(1)} ${(y - dy * length).toFixed(1)}Q${(x - dx * length / 2 - dy * 4).toFixed(1)} ${(y - dy * length / 2 + dx * 4).toFixed(1)} ${(x - dx * 3).toFixed(1)} ${(y - dy * 3).toFixed(1)}`,
    length, duration: 10 - score * 5, delay: -random() * 10 };
}

// Sibling primitives inside the repository group follow the existing motion engine.
// No nested groups, external assets or raw event payloads enter SVG markup.
export function activityMarkup({ x, y, radius, id, activity, effect, detail, seed, animate }) {
  if (!activity || effect === 'off') return '';
  const { score } = activity;
  const geometry = cometGeometry(x, y, score, seed, id);
  const opacity = (.12 + score * .28).toFixed(3);
  const timing = `--activity-opacity:${opacity};--activity-duration:${geometry.duration.toFixed(2)}s;--activity-delay:${geometry.delay.toFixed(2)}s`;
  const ring = (size, motion = '') => `<circle class="activity-ring${motion}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(1)}" opacity="${opacity}" style="${timing}"/>`;
  let markup = `<circle class="activity-halo${animate && effect === 'pulse' ? ' activity-pulse' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(radius + 3 + score * 4).toFixed(1)}" opacity="${opacity}" style="filter:url(#glow);${timing}"/>`;
  if (effect === 'comet') markup += `<path class="activity-comet${animate ? ' activity-streak' : ''}" d="${geometry.path}" opacity="${(.25 + score * .45).toFixed(3)}" stroke-width="${(.8 + score).toFixed(2)}" style="${timing};--activity-dash:${(geometry.length * .55).toFixed(1)} ${(geometry.length * .65).toFixed(1)};--activity-travel:${(geometry.length * 1.2).toFixed(1)}"/>`;
  if (effect === 'ripple') markup += ring(radius + 4 + score * 3, animate ? ' activity-ripple' : '');
  if (detail === 'event-types') {
    if (activity.dominantEvent === 'pull-request') markup += ring(radius + 3) + ring(radius + 6);
    else if (activity.dominantEvent === 'release' || activity.newRepository) markup += ring(radius + 8);
  }
  return markup;
}
