import { seededRandom } from './seeded-random.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const n = value => Number(value).toFixed(2);
const colors = ['#93c5fd', '#c4b5fd', '#f6d99b', '#86efac', '#fda4af'];

export function asteroidFieldMarkup({ id, x, y, radius, snapshot, reference }) {
  if (!snapshot || snapshot.repository?.toLowerCase() !== id.toLowerCase() || !Array.isArray(snapshot.commits)) return '';
  const seen = new Set();
  const commits = snapshot.commits.filter(commit => {
    if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(commit?.sha) || seen.has(commit.sha) || !Number.isFinite(Date.parse(commit.date)) || Date.parse(commit.date) > reference) return false;
    seen.add(commit.sha); return true;
  }).slice(0, 24);
  if (!commits.length) return '';
  const random = seededRandom(`asteroids:${id}`), authors = new Map();
  const rocks = commits.map((commit, i) => {
    const key = commit.login?.toLowerCase() || commit.author || 'Unlinked author';
    if (!authors.has(key)) authors.set(key, { name: commit.author || key, color: colors[authors.size % colors.length] });
    const author = authors.get(key);
    const angle = i * 2.399963 + random() * .3, distance = radius + 16 + (i % 3) * 8;
    const px = Math.cos(angle) * distance, py = Math.sin(angle) * distance * .72;
    const size = 2 + random() * 2.2;
    const points = Array.from({ length: 7 }, (_, j) => { const r = size * (.65 + random() * .5), a = j / 7 * Math.PI * 2; return `${j ? 'L' : 'M'}${n(px + Math.cos(a) * r)} ${n(py + Math.sin(a) * r)}`; }).join('') + 'Z';
    const title = escape(`${snapshot.demo ? 'Demo · ' : ''}${commit.sha.slice(0, 7)} · ${author.name} · ${String(commit.subject || '').slice(0, 140)}`);
    const rock = `<path class="commit-asteroid" d="${points}" fill="var(--sky-line)" stroke="${author.color}" stroke-width=".8"><title>${title}</title></path>`;
    return snapshot.demo ? rock : `<a href="https://github.com/${escape(id)}/commit/${commit.sha}" target="_blank" rel="noopener noreferrer" aria-label="${title}">${rock}</a>`;
  }).join('');
  return `<svg class="activity-asteroid-field" x="${n(x)}" y="${n(y)}" width="1" height="1" overflow="visible" data-repository="${escape(id)}"><title>${escape(id)} · ${commits.length} ${snapshot.demo ? 'demo' : 'loaded'} commit asteroids · ${authors.size} authors</title>${rocks}</svg>`;
}

export const asteroidFieldCSS = `
.activity-asteroid-field{width:1px!important;height:1px!important;background:none!important;overflow:visible}
.commit-asteroid{opacity:.8;transition:opacity .15s,stroke-width .15s}.activity-asteroid-field a:hover .commit-asteroid,.activity-asteroid-field a:focus .commit-asteroid{opacity:1;stroke-width:1.8}
@media(prefers-reduced-motion:reduce){.commit-asteroid{transition:none}}
`;
