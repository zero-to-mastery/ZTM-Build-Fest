import { h, icon, replace } from '../dom.mjs';
import { settingsById, LAYOUT_CHOICES } from '../settings.mjs';
import { starsMove } from '../motion.mjs';

const sourceLabel = { source: 'From GitHub', derived: 'Worked out by Constellation', user: 'Your choice' };

function facts(repo) {
  const items = [];
  if (repo.language) items.push(repo.language);
  items.push(`★ ${repo.stargazers_count || 0}`);
  if (repo.created_at) items.push(`Started ${String(repo.created_at).slice(0, 4)}`);
  const updated = String(repo.pushed_at || repo.updated_at || '').slice(0, 10);
  if (updated) items.push(`Updated ${updated}`);
  if (repo.fork) items.push('Fork');
  if (repo.archived) items.push('Archived');
  return items;
}

const read = (id, options) => settingsById.get(id)?.read(options);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Plain sentences about why this star is here and why it looks the way it
 * does. They are written from the visitor's own settings and the project's
 * GitHub data, not from engine vocabulary, and each says where it comes from.
 */
function reasons(repo, state, shownCount) {
  const { options, repositories } = state;
  const id = repo.full_name;
  const out = [];

  let why;
  if (Array.isArray(options.includeRepos)) why = ['You picked it for your map.', 'user'];
  else if (shownCount >= repositories.length) why = ['All of your public projects fit on the map.', 'derived'];
  else {
    const sort = read('projects.sort', options);
    const among = sort === 'updated' ? `your ${shownCount} most recently updated projects`
      : sort === 'name' ? `the first ${shownCount} of your projects from A to Z`
        : `your ${shownCount} most-starred projects`;
    why = [`It’s one of ${among}.`, 'derived'];
  }
  out.push(['Why it’s here', ...why]);
  if (options.projectShowcase?.[id]?.role === 'featured') out.push(['Featured', 'You featured it, so it stands out.', 'user']);

  const layout = read('layout.arrangement', options);
  const layoutName = LAYOUT_CHOICES.find((c) => c.value === layout)?.label || 'your layout';
  const where = options.starPositions?.[id] ? ['You moved it here.', 'user']
    : layout === 'galaxy' ? [repo.language ? `It sits with your other ${repo.language} projects.` : 'It sits with projects that have no detected language.', 'derived']
      : layout === 'era-rings' ? [`Older projects sit further out. This one started in ${String(repo.created_at || '').slice(0, 4) || 'an unknown year'}.`, 'source']
        : layout === 'temporal-stack' ? [`It’s on the ${String(repo.created_at || '').slice(0, 4) || 'undated'} layer, the year it started.`, 'source']
          : layout === 'solar-system' ? ['The biggest projects become planets and the rest circle them.', 'derived']
            : layout === 'force' ? ['Projects that share languages or topics pull closer together.', 'derived']
              : layout === 'profile' ? ['It’s grouped with projects that do a similar kind of work.', 'derived']
                : [`${layoutName} spreads stars out evenly. Where a star sits doesn’t rank it.`, 'derived'];
  out.push(['Where it sits', ...where]);

  const size = read('details.size', options);
  const stars = repo.stargazers_count || 0;
  out.push(['Its size',
    size === 'stars' ? `Bigger stars have more GitHub stars. This one has ${plural(stars, 'star')}.`
      : size === 'activity' ? 'Bigger stars were worked on more recently.'
        : size === 'age' ? 'Bigger stars are older projects.'
          : 'Every star is the same size.',
    size === 'stars' ? 'source' : 'derived']);

  const colour = read('details.color', options);
  out.push(['Its colour',
    colour === 'language' ? (repo.language ? `Its colour shows its main language, ${repo.language}.` : 'It has no detected language, so it uses the colour for other projects.')
      : colour === 'custom' ? 'It uses your theme’s star colour.'
        : colour === 'seeded' ? 'Every project gets a colour of its own.'
          : 'Its colour comes from your settings.',
    colour === 'language' && repo.language ? 'source' : 'derived']);
  return out;
}

export function mountStarCard(stage, { store, actions, doc }) {
  const content = h('div', { style: { display: 'grid', gap: 'var(--space-3)' } });
  const close = h('button', { class: 'icon-btn close', type: 'button', 'aria-label': 'Close project details', onclick: () => actions.select(null) }, icon('close'));
  const card = h('section', { class: 'star-card', hidden: true, 'aria-labelledby': 'star-card-title', tabindex: '-1' }, close, content);
  stage.append(card);
  // The star that opened the card, so closing it can hand focus back.
  let opener = null;
  let returnToStar = true;

  function position() {
    // Phones: dock to the bottom of the map. Wider: top-left corner, below
    // the map's title. Either way at least 12px from every edge of the map.
    // Narrow maps (portrait phones) dock the card; a short, wide map (a phone
    // on its side) keeps the corner card so the map stays visible beside it.
    const narrow = stage.clientWidth < 480;
    const title = doc.getElementById('studio-heading');
    const titleBottom = title && title.offsetParent === stage ? title.offsetTop + title.offsetHeight : 0;
    const top = Math.max(16, titleBottom + 8);
    Object.assign(card.style, narrow
      // --stage-overlap: how far the phone panel's rounded top covers the map.
      ? { left: '12px', right: '12px', bottom: 'calc(12px + var(--stage-overlap, 0px))', top: 'auto', width: 'auto', maxHeight: `min(62%, calc(100% - ${top + 12}px - var(--stage-overlap, 0px)))` }
      : { left: '16px', top: `${top}px`, right: 'auto', bottom: 'auto', width: '', maxHeight: `calc(100% - ${top + 12}px)` });
  }

  function starFor(id) {
    const root = stage.querySelector('[data-map]')?.shadowRoot;
    if (!root || !id) return null;
    return [...root.querySelectorAll('.repository')].find((group) => group.querySelector('.star')?.dataset.repo === id) || null;
  }

  function hide() {
    if (card.hidden) return;
    const hadFocus = card.contains(doc.activeElement) || doc.activeElement === doc.body;
    card.hidden = true;
    const id = opener;
    opener = null;
    if (!hadFocus) return;
    const star = returnToStar ? starFor(id) : null;
    // Hidden projects have no star left, so the Studio heading takes focus.
    (star || doc.getElementById('studio-heading'))?.focus({ preventScroll: true });
    returnToStar = true;
  }

  function draw(state) {
    const id = state.selected;
    const repo = id && state.repositories.find((r) => r.full_name === id);
    if (!repo) { hide(); return; }
    const featured = actions.isFeatured(id);
    const shownList = actions.shownProjects();
    const shown = shownList.includes(id);
    const why = reasons(repo, state, shownList.length);
    // Redrawing replaces the buttons; keep focus on the one that was pressed.
    const focused = content.contains(doc.activeElement) ? doc.activeElement.dataset.action : null;
    const { options } = state;
    const movable = !starsMove(options);
    replace(content,
      h('h2', { id: 'star-card-title', text: repo.name }),
      // Actions straight after the name: on a small phone the card is short,
      // and the buttons must be on screen without scrolling it.
      h('div', { class: 'card-actions' },
        // A toggle keeps one name; aria-pressed and the filled star show the state.
        h('button', { class: 'btn btn-sm feature-btn', type: 'button', 'data-action': 'feature', 'aria-pressed': String(featured), onclick: () => actions.toggleFeatured(id) }, icon('star', { size: 16 }), 'Feature it'),
        shown ? h('button', {
          class: 'btn btn-sm', type: 'button', 'data-action': 'hide',
          onclick: () => {
            if (!actions.setProjectShown(id, false)) return;
            returnToStar = false;
            actions.select(null);
            actions.toast(`Took ${repo.name} off the map.`, { action: { label: 'Undo', run: () => actions.undo() } });
          },
        }, icon('eyeOff', { size: 16 }), 'Hide it') : null,
        // Moving is a mode you choose, so arrow keys on the map can move focus.
        shown && movable ? h('button', {
          class: 'btn btn-sm', type: 'button', 'data-action': 'move',
          title: 'Then use the arrow keys, or drag the star. Press Enter when it’s in place.',
          onclick: () => store.update({ selected: null, moving: id }),
        }, icon('move', { size: 16 }), 'Move it') : null,
        repo.html_url && !state.sample ? h('a', { class: 'btn btn-sm', href: repo.html_url, target: '_blank', rel: 'noopener noreferrer' }, icon('github', { size: 16 }), 'Open on GitHub') : null),
      repo.description ? h('p', { class: 'field-help', text: repo.description }) : null,
      h('div', { class: 'facts' }, facts(repo).map((text) => h('span', { class: 'fact', text }))),
      h('dl', { class: 'why' }, why.flatMap(([title, text, provenance]) => [
        h('dt', { text: title }),
        h('dd', {}, text, h('span', { class: 'locked', style: { display: 'block' }, text: sourceLabel[provenance] || '' })),
      ])),
    );
    if (focused) content.querySelector(`[data-action="${focused}"]`)?.focus();
    const opening = card.hidden || opener !== id;
    opener = id;
    card.hidden = false;
    position();
    if (opening) card.focus({ preventScroll: true });
  }

  card.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); actions.select(null); }
  });
  store.subscribe((state, changed) => {
    if (changed.has('selected') || (state.selected && (changed.has('render') || changed.has('options')))) draw(state);
    if (changed.has('screen') && state.screen !== 'studio') { card.hidden = true; opener = null; }
  });
  new ResizeObserver(() => { if (!card.hidden) position(); }).observe(stage);
}
