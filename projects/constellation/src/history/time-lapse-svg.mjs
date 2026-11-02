import { historyYears, historicalSnapshot } from './historical-snapshot.mjs';
import { xml, historyLayers } from './history-svg.mjs';
import { projectLifecycle } from './project-lifecycle.mjs';

function repositoryGroups(svg, transform) {
  let cursor = 0, output = '';
  while (true) {
    const start = svg.indexOf('<g class="repository"', cursor);
    if (start < 0) return output + svg.slice(cursor);
    const tags = /<\/?g\b[^>]*>/g; tags.lastIndex = start;
    let depth = 0, match, end = start;
    while ((match = tags.exec(svg))) {
      depth += match[0].startsWith('</') ? -1 : 1;
      if (!depth) { end = tags.lastIndex; break; }
    }
    if (end === start) return output + svg.slice(cursor);
    output += svg.slice(cursor, start) + transform(svg.slice(start, end)); cursor = end;
  }
}

// Crossfade uses bounded real snapshots. Grow/orbit share a single scene and reveal
// nodes, category systems and edges together, keeping the default export compact.
export function renderTimeLapse(account, repositories, options, render, reference) {
  const settings = options.history.timeLapse;
  const years = historyYears(repositories, reference, options.history.maxHistoricalFrames);
  const base = { ...options, history: { ...options.history, mode: 'current', timeLapse: { ...settings, enabled: false } }, timeLapse: false, historicalYear: undefined, generatedAt: new Date(reference).toISOString(), referenceDate: new Date(reference).toISOString() };
  let latest = render(account, repositories, base);
  if (years.length < 2 || options.animate === false) return latest;
  const duration = settings.duration, repeat = settings.loop ? 'infinite' : '1';
  const animation = name => `${name} ${duration}s linear ${repeat} both`;
  let css = '', extra = '';
  if (settings.mode === 'crossfade') {
    // Keep the common background, CSS and card furniture only once.
    const scenePattern = /<!--history-scene-start-->([\s\S]*?)<!--history-scene-end-->/;
    const frameScenes = years.map((year, i) => {
      const source = i === years.length - 1 ? latest : render(account, repositories, { ...base, history: { ...base.history, mode: 'historical', year } });
      const scene = source.match(scenePattern)?.[1] || '';
      const start = i / years.length * 100, end = (i + 1) / years.length * 100;
      const last = i === years.length - 1;
      css += `.history-frame-${i}{opacity:${last ? 1 : 0};animation:${animation(`history-frame-${i}`)}}@keyframes history-frame-${i}{0%{opacity:${i === 0 ? 1 : 0}}${start > 0 ? `${(start - .01).toFixed(3)}%{opacity:0}${start.toFixed(3)}%{opacity:1}` : ''}${(end - 2).toFixed(3)}%{opacity:1}${end.toFixed(3)}%,100%{opacity:${last ? 1 : 0}}}`;
      // Frame-local connection gradients must not collide across snapshots.
      const scoped = scene.replace(/id="([^"]+)"/g, `id="hf${i}-$1"`).replace(/url\(#connection-color-/g, `url(#hf${i}-connection-color-`);
      return `<g class="history-frame history-frame-${i}" data-year="${year}">${scoped}</g>`;
    });
    latest = latest.replace(scenePattern, frameScenes.join(''));
    css += `@media(prefers-reduced-motion:reduce){.history-frame{animation:none!important;opacity:0}.history-frame-${years.length - 1}{opacity:1}}`;
  } else {
    const compact = options.layout === 'compact';
    const eventFrames = years.map((year, i) => {
      const time = i === years.length - 1 ? reference : Math.min(reference, Date.UTC(year + 1, 0, 1) - 1);
      const layers = historyLayers(account, [], { ...base, languageEvolution: { ...options.languageEvolution, enabled: false }, referenceDate: new Date(time).toISOString() }, { centerY: compact ? 126 : 270, spreadY: compact ? 88 : 192, height: compact ? 280 : 560 });
      return `<g class="history-year history-year-${i}">${layers.markup}</g>`;
    });
    latest = latest.replace(/<!--history-events-start-->[\s\S]*?<!--history-events-end-->/, eventFrames.join(''));
    const dates = new Map(repositories.filter(repo => repo.private !== true).map(repo => [repo.full_name, Date.parse(repo.created_at)]));
    const birth = id => {
      const time = dates.get(id);
      if (!Number.isFinite(time)) return years.length - 1;
      const i = years.findIndex(year => time < Date.UTC(year + 1, 0, 1));
      return Math.max(0, i);
    };
    const categoryBirth = new Map();
    latest.replace(/<circle class="star"[^>]*data-repo="([^"]*)"[^>]*data-members="([^"]*)"/g, (_, id, members) => {
      const decoded = members.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
      try { categoryBirth.set(id, Math.min(...JSON.parse(decoded).map(birth))); } catch {}
      return '';
    });
    const indexFor = id => categoryBirth.get(id) ?? birth(id);
    const wrap = (markup, index) => `<g class="history-reveal history-birth-${index}">${markup}</g>`;
    let nodeIndex = 0;
    latest = repositoryGroups(latest, markup => {
      const id = markup.match(/data-repo="([^"]*)"/)?.[1];
      const repo = repositories.find(repo => xml(repo.full_name) === id);
      if (repo && options.stellarAges.enabled) {
        const key = `history-life-${nodeIndex++}`;
        const states = years.map((year, i) => {
          const time = i === years.length - 1 ? reference : Math.min(reference, Date.UTC(year + 1, 0, 1) - 1);
          const snapshot = i === years.length - 1 ? repo : historicalSnapshot([repo], time)[0];
          return snapshot ? projectLifecycle(snapshot, time, options.stellarAges.thresholds, options.historyData?.events || []) : 'unknown';
        });
        const appearance = state => `--history-opacity:${state === 'quiet' ? .7 : state === 'dormant' ? .4 : 1};--history-core:${state === 'archived' && options.stellarAges.showArchivedRemnants ? 0 : 1};--history-shell:${state === 'archived' && options.stellarAges.showArchivedRemnants ? 1 : 0};--history-halo:${state === 'newborn' ? .23 : state === 'mature' ? .13 : .07}`;
        css += `.${key}{${appearance(states.at(-1))};animation:${key} ${duration}s steps(1,end) ${repeat} both}@keyframes ${key}{${states.map((state, i) => `${(i / years.length * 100).toFixed(3)}%{${appearance(state)}}`).join('')}100%{${appearance(states.at(-1))}}`;
        markup = `<g class="history-life ${key}">${markup}</g>`;
      }
      return wrap(markup, indexFor(id));
    });
    latest = latest.replace(/<text class="repo-label"[^>]*data-repo="([^"]*)"[^>]*>[\s\S]*?<\/text>/g, (markup, id) => wrap(markup, indexFor(id)));
    latest = latest.replace(/<(path|line) class="shared-language"[^>]*data-from="([^"]*)"[^>]*data-to="([^"]*)"[^>]*>[\s\S]*?<\/\1>/g, (markup, tag, from, to) => wrap(markup, Math.max(indexFor(from), indexFor(to))));
    latest = latest.replace(/<g class="bridges">[\s\S]*?<\/g>/g, markup => `<g class="history-year history-year-${years.length - 1}">${markup}</g>`);
    // Current activity decorations are evidence only for the latest snapshot.
    latest = latest.replace(/<(?:circle|path) class="activity-[^>]*\/>/g, markup => `<g class="history-year history-year-${years.length - 1}">${markup}</g>`);
    latest = latest.replace(/<g data-era="(\d+)"/g, (_, year) => `<g class="history-reveal history-birth-${Math.max(0, years.findIndex(y => y >= Number(year)))}" data-era="${year}"`);
    for (let i = 0; i < years.length; i++) {
      const start = i / years.length * 100;
      const move = settings.mode === 'orbit' ? 'transform:scale(.55)' : '';
      css += `.history-birth-${i}{animation:${animation(`history-birth-${i}`)};transform-origin:450px ${options.layout === 'compact' ? 126 : 270}px}@keyframes history-birth-${i}{0%{opacity:${i ? 0 : 1};${move}}${i ? `${(start - .01).toFixed(3)}%{opacity:0;${move}}${start.toFixed(3)}%{opacity:1;${move}}` : ''}100%{opacity:1;transform:scale(1)}}`;
    }
    css += '@media(prefers-reduced-motion:reduce){.history-reveal{animation:none!important;opacity:1;transform:none}}';
    css += '.history-life .repository{opacity:var(--history-opacity)}.history-life .repository .star{fill:var(--node-color,var(--sky-star));fill-opacity:var(--history-core);stroke:var(--node-color,var(--sky-star));stroke-opacity:var(--history-shell);stroke-width:1}.history-life .repository .star-core{display:initial;opacity:var(--history-core)}.history-life .repository .star-halo{opacity:var(--history-halo)}@media(prefers-reduced-motion:reduce){.history-life{animation:none!important}}';
  }
  years.forEach((year, i) => {
    const start = i / years.length * 100, end = (i + 1) / years.length * 100;
    css += `.history-year-${i}{opacity:${i === years.length - 1 ? 1 : 0};animation:${animation(`history-year-${i}`)}}@keyframes history-year-${i}{0%{opacity:${i === 0 ? 1 : 0}}${i ? `${(start - .01).toFixed(3)}%{opacity:0}${start.toFixed(3)}%{opacity:1}` : ''}${(end - .01).toFixed(3)}%{opacity:1}${end.toFixed(3)}%,100%{opacity:${i === years.length - 1 ? 1 : 0}}}`;
    extra += `<text class="history-year history-year-${i}" x="450" y="${options.layout === 'compact' ? 260 : 540}" text-anchor="middle" font-size="11">${year}</text>`;
  });
  css += `@media(prefers-reduced-motion:reduce){.history-year{animation:none!important;opacity:0}.history-year-${years.length - 1}{opacity:1}}`;
  // Year captions are added by the legacy temporal adapter after scene assembly.
  // Apply the same annotation controls to this final contribution.
  const annotation = options.layers?.annotations;
  if (annotation?.visible === false || annotation?.opacity === 0) extra = '';
  else if (annotation?.opacity !== undefined && annotation.opacity !== 1) extra = `<g data-scene-layer="annotations" opacity="${annotation.opacity}">${extra}</g>`;
  const result = latest.replace('</style>', `${css}</style>`).replace('</desc>', `${xml(` Growth of surviving public repositories from ${years[0]} to ${years.at(-1)}; ${years.length} sampled years. Current metadata is used where history is unavailable.`)}</desc>`).replace(/<\/svg>\s*$/, `${extra}</svg>\n`);
  if (settings.mode === 'crossfade' && new TextEncoder().encode(result).length > 750000) return renderTimeLapse(account, repositories, { ...options, history: { ...options.history, timeLapse: { ...settings, mode: 'grow' } } }, render, reference).replace('</desc>', ' Crossfade exceeded the 750 KB budget; compact growth animation is used.</desc>');
  return result;
}
