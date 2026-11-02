import { h, icon, replace } from '../../dom.mjs';
import { settingsFor } from '../../settings.mjs';
import { createControl } from '../controls.mjs';

const SORTERS = {
  stars: (a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0) || a.name.localeCompare(b.name),
  updated: (a, b) => String(b.pushed_at || b.updated_at || '').localeCompare(String(a.pushed_at || a.updated_at || '')) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};

export function mountProjectsPanel(section, ctx) {
  const { store, engine, actions } = ctx;
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search your projects', 'aria-label': 'Search your projects', oninput: () => drawList(store.get()) });
  const summary = h('p', { class: 'field-help', role: 'status' });
  const reset = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actions.resetProjects() }, 'Choose automatically');
  const list = h('ul', { class: 'project-list', role: 'list', style: { margin: '0', padding: '0', listStyle: 'none' } });
  const controls = settingsFor('projects', 'essential').map((s) => createControl(s, ctx));
  const listBox = h('div', { class: 'project-scroll' }, list);
  // data-scroll marks a box that clips its content; keep it true to the CSS.
  const phone = ctx.win?.matchMedia?.('(max-width: 860px)');
  const markScroller = () => listBox.toggleAttribute('data-scroll', !phone?.matches);
  markScroller();
  phone?.addEventListener?.('change', markScroller);

  section.append(
    h('section', { class: 'panel-section' },
      h('h3', { text: 'On your map' }),
      h('div', { class: 'field-row' }, summary, reset),
      h('div', { class: 'search' }, icon('search', { size: 18 }), search),
      // Its own scroll box on wide screens, so a long list never pushes the
      // settings out of reach. On phones the panel is already the one scroller
      // (app.css), and a scroller inside a scroller traps the thumb.
      listBox),
    h('section', { class: 'panel-section' }, h('h3', { text: 'Choosing projects' }), h('div', { class: 'setting-list' }, controls.map((c) => c.element))),
  );

  const rows = new Map();
  function row(repo) {
    const checkboxId = `project-${repo.full_name.replace(/\W/g, '-')}`;
    const metaId = `${checkboxId}-meta`;
    const checkbox = h('input', { type: 'checkbox', id: checkboxId, 'aria-describedby': metaId, onchange: () => {
      if (!actions.setProjectShown(repo.full_name, checkbox.checked)) checkbox.checked = !checkbox.checked;
    } });
    const feature = h('button', { class: 'icon-btn feature-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': `Feature ${repo.name}`, title: 'Featured projects stand out on the map', onclick: () => actions.toggleFeatured(repo.full_name) }, icon('star', { size: 18 }));
    const year = String(repo.pushed_at || repo.updated_at || '').slice(0, 4);
    const meta = [repo.language, `★ ${repo.stargazers_count || 0}`, year && `updated ${year}`, repo.fork && 'fork', repo.archived && 'archived'].filter(Boolean).join(' · ');
    const element = h('li', { class: 'project-row' },
      checkbox,
      h('label', { for: checkboxId, style: { minWidth: '0', cursor: 'pointer' } },
        h('div', { class: 'project-name', text: repo.name }),
        h('div', { class: 'project-meta', id: metaId, text: meta })),
      feature);
    return { element, checkbox, feature, repo };
  }

  function drawList(state) {
    const query = search.value.trim().toLowerCase();
    const shown = new Set(actions.shownProjects());
    // A stable order: ticking a box never makes its row jump.
    const sorter = SORTERS[state.options.sortBy] || SORTERS.stars;
    const repos = [...state.repositories].sort(sorter);
    const visible = repos.filter((r) => !query || r.name.toLowerCase().includes(query) || (r.description || '').toLowerCase().includes(query) || (r.language || '').toLowerCase().includes(query));
    const nodes = visible.map((repo) => {
      let entry = rows.get(repo.full_name);
      if (!entry) { entry = row(repo); rows.set(repo.full_name, entry); }
      entry.checkbox.checked = shown.has(repo.full_name);
      const featured = actions.isFeatured(repo.full_name);
      entry.feature.setAttribute('aria-pressed', String(featured));
      return entry.element;
    });
    replace(list, nodes.length ? nodes : h('li', { class: 'field-help', text: query ? `No projects match “${search.value.trim()}”.` : 'No projects loaded.' }));
    const explicit = Array.isArray(state.options.includeRepos);
    summary.textContent = `${shown.size} of ${state.repositories.length} projects are on your map${explicit ? ', picked by you.' : ', picked automatically.'}`;
    reset.hidden = !explicit;
  }

  const sync = (state, changed) => {
    if (!(changed.has('options') || changed.has('repositories') || changed.has('screen'))) return;
    if (changed.has('repositories') || changed.has('account')) rows.clear();
    drawList(state);
    for (const control of controls) control.sync(state.options, { signedIn: engine.signedIn });
  };
  sync(store.get(), new Set(['options', 'repositories']));
  return store.subscribe(sync);
}
