import { graphSelection } from './engine.mjs';

export const selectionCSS = `
svg[data-exploring] .repository,svg[data-exploring] .repo-label{opacity:.16}
svg[data-exploring] .shared-language{opacity:.025}
svg[data-exploring] .repository[data-related],svg[data-exploring] .repo-label[data-related]{opacity:1}
svg[data-exploring] .shared-language[data-related]{opacity:1;stroke:var(--sky-accent);stroke-width:1.8}
svg[data-exploring] .repository[data-related] .star{animation:none;opacity:1}
.repository[aria-pressed=true] .star-halo{opacity:.45}`;

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

// Apply the same focus to standalone SVGs and their animated/reduced-motion views.
export function focusSVG(svg, selection = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || ['start', 'end'].some(key => selection[key] != null && typeof selection[key] !== 'string')) throw new Error('selection must contain start/end node IDs.');
  const names = [...svg.matchAll(/<circle class="star"[^>]*data-repo="([^"]+)"/g)].map(match => match[1]);
  const start = selection.start ? escape(selection.start) : null;
  const end = selection.end && names.includes(escape(selection.end)) ? escape(selection.end) : null;
  if (!names.includes(start)) return svg;
  const edgeTags = [...svg.matchAll(/<(?:path|line) class="shared-language"[^>]*>/g)].map(match => match[0]);
  const endpoints = tag => [tag.match(/data-from="([^"]+)"/)[1], tag.match(/data-to="([^"]+)"/)[1]];
  const pairs = edgeTags.flatMap(tag => endpoints(tag).map(id => names.indexOf(id)));
  const related = new Set(graphSelection(names, pairs, start, end));
  related.add(start); if (end) related.add(end);
  const path = end ? graphSelection(names, pairs, start, end) : [];
  let focused = svg.replace('<svg ', `<svg data-exploring="" data-focus-start="${start}"${end ? ` data-focus-end="${end}"` : ''} `)
    .replace(/<g class="repository"[^>]*>[\s\S]*?<\/g>/g, group => {
      const id = group.match(/data-repo="([^"]+)"/)[1];
      return group.replace('<g ', `<g${related.has(id) ? ' data-related=""' : ''} aria-pressed="${id === start || id === end}" `);
    }).replace(/<text class="repo-label"[^>]*>/g, label => {
      const id = label.match(/data-repo="([^"]+)"/)[1];
      return related.has(id) ? label.replace('<text ', '<text data-related="" ') : label;
    }).replace(/<(?:path|line) class="shared-language"[^>]*>/g, edge => {
      const [from, to] = endpoints(edge);
      const shown = end ? path.some((name, i) => i > 0 && ((path[i - 1] === from && name === to) || (path[i - 1] === to && name === from))) : from === start || to === start;
      return shown ? edge.replace(' class=', ' data-related="" class=') : edge;
    });
  // Insert attributes after class so the animation builder can still identify nodes.
  focused = focused.replace(/<g( data-related="")? aria-pressed="(true|false)" class="repository"/g, (_, related, pressed) => `<g class="repository"${related || ''} aria-pressed="${pressed}"`)
    .replace(/<text data-related="" class="repo-label"/g, '<text class="repo-label" data-related=""')
    .replace(/<(path|line) data-related="" class="shared-language"/g, '<$1 class="shared-language" data-related=""');
  return focused.replace('</style>', `${selectionCSS}\n</style>`).replace('</desc>', ` Focused view: ${start}${end ? ` to ${end}` : ' and its connected nodes'}; unrelated nodes are dimmed.</desc>`);
}
