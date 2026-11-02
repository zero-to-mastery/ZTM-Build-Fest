import { historyOptions } from './settings.mjs';
import { referenceDate } from './historical-snapshot.mjs';
import { contributionHistory } from './contribution-history.mjs';
import { contributionComet, renderContributionComet, cometCSS } from './contribution-comet.mjs';
import { languageHistory } from './language-history.mjs';
import { externalContributions } from './external-contributions.mjs';
export const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const n = value => value.toFixed(2);
export function timelinePositions(repositories, reference, compact) {
  const times = repositories.map(repo => Date.parse(repo.created_at)).filter(time => Number.isFinite(time) && time <= reference);
  const start = Math.min(reference, ...times), span = Math.max(1, reference - start);
  return Object.fromEntries(repositories.filter(repo => Number.isFinite(Date.parse(repo.created_at))).map((repo, index) => {
    const age = (Date.parse(repo.created_at) - start) / span;
    const angle = age * Math.PI * 3 - Math.PI / 2 + index * .11;
    const radius = .25 + age * .65;
    return [repo.full_name, { x: 450 + Math.cos(angle) * radius * 350, y: (compact ? 126 : 270) + Math.sin(angle) * radius * (compact ? 75 : 180) }];
  }));
}
function arc(cx, cy, rx, ry, start, end) {
  return `M${n(cx + Math.cos(start) * rx)} ${n(cy + Math.sin(start) * ry)}A${n(rx)} ${n(ry)} 0 ${end - start > Math.PI ? 1 : 0} 1 ${n(cx + Math.cos(end) * rx)} ${n(cy + Math.sin(end) * ry)}`;
}
export function renderContributionOrbit(data, settings, { centerY, spreadY }, animate = true) {
  if (!settings.enabled || !data) return '';
  const rx = 402, ry = spreadY + 23;
  if (data.weeks.every(week => !week.count && !week.observed)) return `<g class="contribution-orbit"><ellipse cx="450" cy="${centerY}" rx="${rx}" ry="${ry}" fill="none" stroke="var(--sky-accent)" opacity=".045"><title>Public event history unavailable at this reference date</title></ellipse></g>`;
  const marks = data.weeks.map((week, i) => {
    const a = i / 52 * Math.PI * 2 - Math.PI / 2, b = a + Math.PI * 2 / 52 * .77;
    const opacity = week.count ? .22 + week.level * .18 : week.observed ? .12 : .045;
    const title = `<title>Week of ${new Date(week.start).toISOString().slice(0, 10)}: ${week.count ? `${week.count} observed public events` : week.observed ? 'no observed events' : 'history unavailable'}</title>`;
    return settings.style === 'dots' ? `<circle cx="${n(450 + Math.cos(a) * rx)}" cy="${n(centerY + Math.sin(a) * ry)}" r="${1 + week.level * .45}" fill="var(--sky-accent)" opacity="${opacity}">${title}</circle>` : `<path d="${arc(450, centerY, rx, ry, a, b)}" fill="none" stroke="var(--sky-accent)" stroke-width="${1 + week.level * .65}" opacity="${opacity}">${title}</path>`;
  }).join('');
  const marker = settings.showCurrent ? `<circle cx="${n(450 + Math.cos(51 / 52 * Math.PI * 2 - Math.PI / 2) * (rx + 6))}" cy="${n(centerY + Math.sin(51 / 52 * Math.PI * 2 - Math.PI / 2) * (ry + 4))}" r="2" fill="var(--sky-foreground)"><title>Reference week</title></circle>` : '';
  return `<g class="contribution-orbit${settings.animate && animate ? ' history-pulse' : ''}">${settings.style === 'pulse-ring' ? `<ellipse cx="450" cy="${centerY}" rx="${rx}" ry="${ry}" fill="none" stroke="var(--sky-accent)" opacity=".08"/>` : ''}${marks}${marker}</g>`;
}
export function renderLanguageEvolution(eras, settings, { centerY, spreadY }) {
  if (!settings.enabled) return '';
  const count = Math.max(1, eras.length);
  return `<g class="language-evolution" fill="none">${eras.map((era, i) => {
    const rx = 70 + (i + 1) / count * 270, ry = 25 + (i + 1) / count * (spreadY - 35);
    let angle = -Math.PI / 2;
    const paths = era.languages.slice(0, 8).map(language => {
      const end = angle + language.prominence * Math.PI * 1.98;
      const d = settings.style === 'trails' ? `M${n(450 + Math.cos(angle) * rx * .6)} ${n(centerY + Math.sin(angle) * ry * .6)}Q450 ${centerY} ${n(450 + Math.cos(end) * rx)} ${n(centerY + Math.sin(end) * ry)}` : arc(450, centerY, rx, ry, angle, end);
      angle = end;
      return `<path d="${d}" stroke="${language.color}" stroke-width="${settings.style === 'eras' ? 7 : 2}" opacity=".18"><title>${xml(language.name)} · ${era.start}–${era.end} · inferred creation cohort</title></path>`;
    }).join('');
    return `<g data-era="${era.start}">${paths}<text x="450" y="${n(centerY - ry - 4)}" text-anchor="middle" fill="var(--sky-foreground)" stroke="none" font-size="8" opacity=".5">${era.start}${era.end !== era.start ? `–${era.end}` : ''}${era.languages.length ? ` · ${xml(era.languages[0].name)}` : ''}</text></g>`;
  }).join('')}</g>`;
}
export function renderForeignGalaxies(galaxies, { centerY, spreadY }) {
  return `<g class="foreign-galaxies">${galaxies.map((galaxy, i) => {
    const left = i % 2 === 0, row = Math.floor(i / 2), rows = Math.ceil(galaxies.length / 2);
    const x = left ? 25 : 875, y = centerY - spreadY * .7 + (row + .5) / rows * spreadY * 1.4;
    return `<a href="https://github.com/${xml(galaxy.repository)}" target="_blank" rel="noopener noreferrer"><g transform="translate(${x} ${n(y)})" fill="var(--sky-accent)" opacity=".65"><title>${xml(galaxy.repository)} · ${galaxy.count} public contribution events · ${galaxy.kinds.join(', ')}</title><ellipse rx="${5 + galaxy.weight / 5}" ry="3" fill="none" stroke="var(--sky-accent)" transform="rotate(-30)"/><circle r="1.6"/><circle cx="-7" cy="4" r=".8"/><circle cx="6" cy="-4" r=".7"/><text x="${left ? 10 : -10}" y="16" text-anchor="${left ? 'start' : 'end'}" font-size="8">${xml(galaxy.repository.length > 25 ? galaxy.repository.slice(0, 24) + '…' : galaxy.repository)}</text></g></a>`;
  }).join('')}</g>`;
}
export function historyLayers(account, repositories, options, geometry) {
  const settings = historyOptions(options), reference = referenceDate(options);
  const contribution = settings.contributionOrbit.enabled ? contributionHistory(options.historyData, reference) : null;
  const comet = settings.contributionComet.enabled ? contributionComet(options.historyData, reference) : null;
  const eras = settings.languageEvolution.enabled ? languageHistory(repositories, reference, settings.languageEvolution.buckets) : [];
  const galaxies = settings.foreignGalaxies.enabled ? externalContributions(account, options.historyData, reference, settings.foreignGalaxies) : [];
  const diagnostics = [];
  if ((settings.contributionOrbit.enabled || settings.foreignGalaxies.enabled) && (!options.historyData || options.historyData.diagnostic)) diagnostics.push('Public history unavailable; event layers omitted.');
  else if (settings.contributionOrbit.enabled) diagnostics.push('52 weeks · observed public events · gaps unknown');
  if (settings.languageEvolution.enabled) diagnostics.push('Language eras inferred from project creation');
  if (settings.history.mode === 'historical') diagnostics.push(`${settings.history.year} · surviving projects, current metadata`);
  return {
    markup: `<!--history-events-start-->${renderContributionOrbit(contribution, settings.contributionOrbit, geometry, options.animate !== false)}${renderForeignGalaxies(galaxies, geometry)}${comet ? renderContributionComet(comet, geometry, options.animate !== false) : ''}<!--history-events-end-->` + renderLanguageEvolution(eras, settings.languageEvolution, geometry),
    note: diagnostics.length ? `<text class="history-note" x="450" y="${geometry.height - 44}" text-anchor="middle" font-size="8" opacity=".65">${xml(diagnostics.join(' · '))}</text>` : '',
    description: (contribution ? ' Outer orbit represents observed public activity over 52 weeks; missing history is unknown.' : '') + (eras.length ? ' Language rings show inferred creation cohorts, using current language data.' : '') + (settings.stellarAges.enabled ? ' Node appearance reflects project age and known maintenance.' : '') + (galaxies.length ? ` ${galaxies.length} external repositories represent public open-source contributions.` : '') + (settings.history.mode === 'historical' ? ` Historical view of ${settings.history.year}; deleted repositories cannot be reconstructed.` : ''),
  };
}
export const historyCSS = cometCSS + `
.repository[data-lifecycle="quiet"]{opacity:.7}.repository[data-lifecycle="dormant"]{opacity:.4}
.repository[data-lifecycle="archived"] .star{fill:none;stroke:var(--node-color,var(--sky-star));stroke-width:1;filter:none;animation:none}
.repository[data-lifecycle="archived"] .star-core{display:none}
.repository[data-lifecycle="newborn"] .star-halo{opacity:.23;stroke:var(--node-color,var(--sky-star));stroke-width:.6}
.repository[data-lifecycle="mature"] .star-halo{opacity:.13;stroke:var(--node-color,var(--sky-star));stroke-width:1}
.repository[data-lifecycle="mature"] .star{animation:none}
.repository[data-age-mode="halo"]{opacity:1}.repository[data-age-mode="subtle"]{opacity:.85}
.repository[data-age-mode="halo"][data-lifecycle="quiet"] .star-halo{opacity:.04}.repository[data-age-mode="halo"][data-lifecycle="dormant"] .star-halo{opacity:.02;fill:none;stroke:var(--node-color,var(--sky-star));stroke-width:.5}
.repository[data-age-mode="color"] .star-halo{fill:var(--age-color,var(--sky-accent));opacity:.25}
.repository[data-lifecycle="newborn"]{--age-color:#93c5fd}.repository[data-lifecycle="active"]{--age-color:#a7f3d0}.repository[data-lifecycle="mature"]{--age-color:#fde68a}.repository[data-lifecycle="quiet"]{--age-color:#c4b5fd}.repository[data-lifecycle="dormant"]{--age-color:#94a3b8}
.history-pulse{animation:history-pulse 16s ease-in-out infinite}@keyframes history-pulse{50%{opacity:.55}}
@media(prefers-reduced-motion:reduce){.history-pulse{animation:none}}
`;
