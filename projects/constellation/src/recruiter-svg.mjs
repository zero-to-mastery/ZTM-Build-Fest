import { recruiterBands, recruiterRadii } from './recruiter.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const shorten = (value, length) => [...String(value || '')].length > length ? [...String(value)].slice(0, length - 1).join('') + '…' : value;
// Conservative glyph budgets avoid long repository/account names crossing the diagram.
const fitName = (value, width, size) => {
  const chars = [...String(value || '')];
  const units = char => /[MWmw@]/.test(char) ? 1 : /[ilI.,'! ]/.test(char) ? .38 : /[A-Z]/.test(char) ? .75 : .6;
  let total = chars.reduce((sum, char) => sum + units(char), 0), shortened = false;
  while (chars.length && (total + (shortened ? 1 : 0)) * size > width) { total -= units(chars.pop()); shortened = true; }
  return chars.join('') + (shortened ? '…' : '');
};
const text = (x, y, value, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${escape(value)}</text>`;
const circle = (x, y, r, attrs = '') => `<circle cx="${x}" cy="${y}" r="${r}" ${attrs}/>`;
export function renderRecruiterSVG(scene) {
  const options = scene.presentation.options, account = scene.metadata.account;
  const nodes = scene.nodes, byId = new Map(nodes.map(node => [node.id, node]));
  const languages = new Map();
  for (const node of nodes) {
    const language = node.metadata.language || 'Unknown';
    const entry = languages.get(language) || { count: 0, color: node.style.color };
    entry.count++; languages.set(language, entry);
  }
  const summary = [...languages].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const light = options.theme !== 'midnight';
  const palette = { background: light ? '#f7f8fc' : '#0d1117', foreground: light ? '#18213a' : '#e6edf3', line: light ? '#7a869c' : '#68768d', accent: light ? '#395bbe' : '#9ab9ff', star: light ? '#966500' : '#f6d99b', ...options.colors };
  const transparent = options.transparentTheme || options.exportProfile === 'transparent';
  const topicCounts = new Map();
  const noisyTopics = new Set(['github', 'repository', 'repo', 'project', 'portfolio', 'awesome', 'readme']);
  for (const node of nodes) {
    for (const topic of new Set((Array.isArray(node.metadata.topics) ? node.metadata.topics : [])
      .filter(topic => typeof topic === 'string' && /^[a-z0-9][a-z0-9-]{1,29}$/i.test(topic))
      .map(topic => topic.toLowerCase()).filter(topic => !noisyTopics.has(topic)))) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }
  const topics = [...topicCounts].filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([topic]) => topic);
  const technologies = summary.filter(([language]) => language !== 'Unknown').slice(0, 3).map(([language]) => language);
  const displayName = options.accountData?.name || account;
  const description = `${displayName} (@${account}). ${technologies.join(' · ')}${topics.length ? '. Repository topics: ' + topics.join(' · ') : ''}. Size shows developer-curated presentation importance, not quality or skill: Featured, Supporting, then small Experimental/Historical projects; unassigned projects have a conservative default. Distance shows last repository push or observed work event: NOW under 30 days, RECENT under six months, EARLIER otherwise. Unknown recency is placed outside and identified in project titles. Repository activity is not necessarily the developer’s own activity. Color shows primary language; counts cover displayed repositories, not skill. Featured labels may show other loaded contributors, excluding this account; missing scans do not establish solo work. A + contributor count is a lower bound. Observed active months remain in project titles; partial history is a lower bound, not lifetime continuity or personal effort. Thin lines are explicitly curated project relationships. Other repositories counts cover loaded public repositories, including those outside current filters, not necessarily the whole account. No scores or engineering roles are inferred.`;
  const paths = scene.edges.map(edge => {
    const a = byId.get(edge.from).geometry, b = byId.get(edge.to).geometry;
    return `<path class="related" d="M${a.x} ${a.y} Q600 380 ${b.x} ${b.y}"><title>${escape(edge.from)} ↔ ${escape(edge.to)} · curated relationship</title></path>`;
  }).join('');
  const projects = nodes.map(node => {
    const { x, y, radius } = node.geometry, evidence = node.recruiter, label = evidence.label;
    const activity = evidence.months ? `${evidence.months}${evidence.complete ? '' : '+'} observed active mo` : 'history unavailable';
    const contributors = evidence.others === null ? 'contributors unknown' : `${evidence.others}${evidence.contributorPartial ? '+' : ''} other contributor${evidence.others === 1 ? '' : 's'}`;
    const participation = evidence.contributed ? 'confirmed external participation' : evidence.external ? 'external ownership; participation unverified' : 'account-owned repository';
    const details = evidence.others > 0 ? contributors : '';
    const end = label.side ? 270 : 930;
    return `<g class="repository ${escape(evidence.role)}" data-repo="${escape(node.id)}"><title>${escape(`${node.id} · ${node.metadata.language || 'Unknown language'} · ${activity} · ${contributors} · ${participation} · ${evidence.unknownRecency ? 'recency unavailable' : recruiterBands[evidence.band] + ' repository activity'} · ${evidence.role}`)}</title>
      ${node.interaction.labelHidden ? '' : `<path class="leader" d="M${x} ${y} L${end} ${y}"/>`}
      ${evidence.featured && evidence.band === 0 && !evidence.unknownRecency ? circle(x, y, radius + 6, 'class="recent-pulse"') : ''}
      ${circle(x, y, radius, `class="planet star" data-repo="${escape(node.id)}" data-label="${escape(node.metadata.name)}" style="--planet:${node.style.color}"`)}
      ${node.interaction.labelHidden ? '' : `<g class="project-label"><text class="repo-label${evidence.featured ? ' featured' : ''}" data-repo="${escape(node.id)}" x="${label.x}" y="${label.y}">${escape(fitName(node.metadata.name, 213, evidence.featured ? 22 : 20))}</text>${evidence.featured ? text(label.x, label.y + 26, fitName((node.metadata.language || 'Unknown language') + (evidence.contributed ? ' · contributed' : ''), 213, 16), 'class="detail"') + (details ? text(label.x, label.y + 50, fitName(details, 213, 16), 'class="detail muted"') : '') : ''}</g>`}
    </g>`;
  }).join('');
  const languageLine = summary.slice(0, 5).map(([language, entry], index) => `<g transform="translate(${32 + index * 230} 738)">${circle(0, -6, 5, `fill="${entry.color}"`)}${text(13, 0, `${shorten(language, 17)} ×${entry.count}`, 'class="detail"')}</g>`).join('');
  const legend = `<g class="key">
    ${text(32, 788, 'HOW TO READ', 'class="eyebrow"')}
    ${text(220, 788, 'size · curated importance')}
    ${text(555, 788, 'distance · recency')}
    ${text(840, 788, 'color · primary language')}
    ${scene.edges.length ? text(32, 818, 'line · related project', 'class="detail muted"') : ''}
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="840" viewBox="0 0 1200 840" role="img" aria-labelledby="recruiter-title recruiter-description">
  <title id="recruiter-title">${escape(options.title || `${account} · project constellation`)}</title><desc id="recruiter-description">${escape(description)}</desc>
  <style>svg{${Object.entries(palette).map(([name, value]) => `--sky-${name}:${value}`).join(';')};color:var(--sky-foreground);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}text{fill:currentColor;font-size:17px}.background{fill:${transparent ? 'none' : 'var(--sky-background)'}}.guide{fill:none;stroke:var(--sky-line);stroke-width:1;opacity:.10}.band{font-size:14px;letter-spacing:1px;opacity:.8}.leader{fill:none;stroke:var(--sky-line);stroke-width:1;opacity:.22}.related{fill:none;stroke:var(--sky-accent);stroke-width:1;opacity:.16}.repository .planet{filter:none;fill:var(--planet);stroke:var(--sky-foreground);stroke-width:1}.repository.historical{opacity:.55}.repository.experimental{opacity:.75}.project-label .repo-label{font-size:20px;display:inline;font-weight:500}.project-label .repo-label.featured{font-weight:800;font-size:22px}.detail{font-size:16px}.muted{opacity:.8}.eyebrow{font-size:14px;font-weight:700;letter-spacing:2px}.overflow{font-size:14px}.key{fill:currentColor}.recent-pulse{fill:none;stroke:var(--sky-accent);opacity:.3}.sun{fill:var(--sky-star);opacity:.14;stroke:var(--sky-star);stroke-width:1.5}${options.animate !== false ? '@keyframes recruiter-pulse{50%{opacity:.1}}.recent-pulse{animation:recruiter-pulse 10s ease-in-out infinite}@media(prefers-reduced-motion:reduce){.recent-pulse{animation:none}}' : ''}${escape(options.css || '')}</style>
  <rect class="background" width="1200" height="840" rx="16"/>
  ${text(32, 35, 'PROJECT CONSTELLATION', 'class="eyebrow"')}${text(1168, 35, `As of ${scene.metadata.referenceDate.slice(0, 10)}`, 'class="detail muted" text-anchor="end"')}
  ${recruiterRadii.map((r, index) => `<path class="guide" d="M${600 - r * .94} ${380 - r * .342} A${r} ${r} 0 0 1 ${600 + r * .94} ${380 - r * .342} M${600 + r * .94} ${380 + r * .342} A${r} ${r} 0 0 1 ${600 - r * .94} ${380 + r * .342}"/>${text(600, 380 - r - 9, recruiterBands[index], 'class="band" text-anchor="middle"')}`).join('')}
  ${paths}${projects}
  <g class="developer" text-anchor="middle"><title>${escape(`${displayName} · @${account}`)}</title>${circle(600, 380, 113, 'class="sun"')}${text(600, 350, fitName(displayName, 280, 26), 'font-weight="750" style="font-size:26px"')}${text(600, 381, fitName('@' + account, 280, 18), 'style="font-size:18px"')}${technologies.length ? text(600, 419, fitName(technologies.join(' · '), 325, 16), 'class="detail technology-summary"') : ''}${topics.length ? text(600, 447, fitName(topics.join(' · '), 325, 16), 'class="detail muted topic-summary"') : ''}</g>
  ${text(1168, 818, scene.presentation.recruiterOmitted ? `+${scene.presentation.recruiterOmitted} other repositories` : `${nodes.length} selected repositories`, 'class="detail muted" text-anchor="end"')}
  ${languageLine}${summary.length > 5 ? text(1168, 710, `+${summary.length - 5} languages`, 'class="detail" text-anchor="end"') : ''}
  <path d="M32 759H1168" class="guide"/>${legend}</svg>`.replace(/^[ \t]+$/gm, '');
}
