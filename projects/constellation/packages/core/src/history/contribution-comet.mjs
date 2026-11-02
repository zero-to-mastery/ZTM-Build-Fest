import { sanitizeActivityEvents } from '../activity.mjs';
import { DAY } from './historical-snapshot.mjs';

// A day still in progress never breaks a streak. Unknown coverage never does either.
export function contributionComet(snapshot, reference) {
  const unknown = { state: 'unknown', days: 0, events: 0 };
  if (!snapshot || snapshot.diagnostic || !Number.isFinite(reference)) return unknown;
  const end = Date.parse(snapshot.asOf), start = Date.parse(snapshot.coverageStart);
  if (!Number.isFinite(end)) return unknown;
  const today = Math.floor(reference / DAY) * DAY;
  const counts = new Map();
  for (const event of sanitizeActivityEvents(snapshot.events)) {
    const time = Date.parse(event.createdAt);
    if (['watch', 'fork'].includes(event.kind) || time > Math.min(reference, end) || time < start) continue;
    const day = Math.floor(time / DAY) * DAY;
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  const latest = Math.max(-Infinity, ...counts.keys());
  if (!Number.isFinite(latest)) return unknown;
  let days = 0, events = 0;
  for (let day = latest; counts.has(day); day -= DAY) { days++; events += counts.get(day); }
  if (latest >= today - DAY) return { state: 'active', days, events };
  const missed = latest + DAY;
  if (!Number.isFinite(start) || start > missed || end < missed + DAY - 1) return unknown;
  return { state: 'burst', days, events, missedDate: new Date(missed).toISOString().slice(0, 10) };
}

export function renderContributionComet(data, geometry, animate = true) {
  const y = geometry.centerY - geometry.spreadY * .68;
  const label = data.state === 'unknown' ? 'Comet awaiting activity history' : data.state === 'burst'
    ? `${data.days}-day comet burst · ${data.missedDate} off · a new streak awaits`
    : `${data.days}-day comet · ${data.events} public events`;
  const length = Math.min(190, 55 + data.days * 9);
  const particles = Array.from({ length: 36 }, (_, i) => {
    const angle = i * 2.399963, distance = 24 + (i % 7) * 12;
    const x = (Math.cos(angle) * distance).toFixed(2), y = (Math.sin(angle) * distance * .65).toFixed(2);
    return `<circle class="comet-shard" cx="${x}" cy="${y}" r="${1 + i % 3 * .6}" fill="${['#67e8f9', '#c4b5fd', '#fef3c7'][i % 3]}" style="--shard-x:${x}px;--shard-y:${y}px"/>`;
  }).join('');
  return `<g class="contribution-comet comet-${data.state}${animate ? ' comet-motion' : ''}" role="img" aria-label="${label}" pointer-events="none"><title>${label}. Based on observed public activity, using UTC days; private contributions are not included.</title><g transform="translate(690 ${y.toFixed(2)})"><g class="comet-flight"><path d="M0 0 Q-${length * .45} -25 -${length} 5 Q-${length * .5} 12 0 0" fill="#67e8f9" opacity=".2"/><path d="M0 0 Q-${length * .4} -8 -${length * .85} 3" fill="none" stroke="#c4b5fd" stroke-width="3" opacity=".65"/><path d="M0 0 L-${length * .65} 2" stroke="#a5f3fc" stroke-width="2"/><circle r="15" fill="#67e8f9" opacity=".12"/><circle r="8" fill="#a5f3fc" opacity=".4"/><circle r="4" fill="#fff7ed"/></g><g class="comet-explosion"><circle class="comet-shockwave" r="65" fill="none" stroke="#a5f3fc" stroke-width="1.5" opacity=".35"/>${particles}<circle r="5" fill="#fff7ed" opacity=".7"/></g></g><text x="450" y="${geometry.height - 60}" text-anchor="middle" fill="var(--sky-foreground)" font-size="10" opacity=".8">${label}</text></g>`;
}

export const cometCSS = `
.comet-explosion{display:none}.comet-unknown .comet-flight{opacity:.15}
.comet-active.comet-motion .comet-flight{animation:comet-cruise 12s linear infinite}
.comet-burst .comet-flight{display:none}.comet-burst .comet-explosion{display:inline}
.comet-burst.comet-motion .comet-flight{display:inline;animation:comet-arrival 3.8s ease-out both}
.comet-burst.comet-motion .comet-shard{animation:comet-scatter 3.8s cubic-bezier(.16,1,.3,1) both}
.comet-burst.comet-motion .comet-shockwave{transform-box:fill-box;transform-origin:center;animation:comet-wave 3.8s ease-out both}
@keyframes comet-cruise{0%{transform:translate(-760px,36px) rotate(-8deg);opacity:0}10%,90%{opacity:1}50%{transform:translate(0,0) rotate(0deg)}100%{transform:translate(760px,36px) rotate(8deg);opacity:0}}
@keyframes comet-arrival{0%{transform:translate(-760px,36px) rotate(-8deg);opacity:0}6%{opacity:1}30%{transform:translate(0,0) rotate(0deg);opacity:1}35%,100%{transform:translate(0,0);opacity:0}}
@keyframes comet-scatter{0%,30%{transform:translate(calc(-1 * var(--shard-x)),calc(-1 * var(--shard-y)));opacity:0}34%{opacity:1}85%,100%{transform:translate(0,0);opacity:.55}}
@keyframes comet-wave{0%,30%{transform:scale(.02);opacity:0}35%{opacity:.85}100%{transform:scale(1);opacity:.15}}
@media(prefers-reduced-motion:reduce){.contribution-comet *{animation:none!important}.comet-burst .comet-flight{display:none!important}}
`;
