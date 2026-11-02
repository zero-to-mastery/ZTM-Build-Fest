import { h, icon } from '../dom.mjs';
import { GROUPS } from '../settings.mjs';
import { mountMap } from './map.mjs';
import { mountStarCard } from './star-card.mjs';
import { mountDialogs } from './dialogs.mjs';
import { mountLookPanel } from './panels/look.mjs';
import { mountLayoutPanel } from './panels/layout.mjs';
import { mountProjectsPanel } from './panels/projects.mjs';
import { mountDetailsPanel } from './panels/details.mjs';

const PANELS = [
  ['look', mountLookPanel],
  ['layout', mountLayoutPanel],
  ['projects', mountProjectsPanel],
  ['details', mountDetailsPanel],
];

export function mountStudio(root, ctx) {
  const { store, actions } = ctx;

  // ------------------------------------------------------------- top bar
  const account = h('button', { class: 'topbar-account', type: 'button', onclick: () => actions.goHome(), title: 'Choose a different account' });
  const iconButton = (name, label, onclick, shortcut) => h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': label, title: shortcut ? `${label} (${shortcut})` : label, onclick,
    'aria-keyshortcuts': shortcut ? shortcut.replace('Ctrl', 'Control') : undefined,
  }, icon(name));
  const undo = iconButton('undo', 'Undo', () => actions.undo(), 'Ctrl+Z');
  const redo = iconButton('redo', 'Redo', () => actions.redo(), 'Ctrl+Shift+Z');
  // aria-label keeps the name when phones hide the visible word.
  const shuffle = h('button', { class: 'btn btn-ghost topbar-tool', type: 'button', 'aria-label': 'Shuffle', onclick: () => actions.shuffle(), title: 'Try a random look and layout. Undo brings yours back.' },
    icon('shuffle', { size: 18 }), h('span', { class: 'topbar-label', text: 'Shuffle' }));
  const save = h('button', { class: 'btn btn-ghost topbar-tool', type: 'button', 'aria-label': 'Save', onclick: () => actions.openDialog('save') },
    icon('save', { size: 18 }), h('span', { class: 'topbar-label', text: 'Save' }));
  const getIt = h('button', { class: 'btn btn-primary topbar-get', type: 'button', 'data-primary': '', onclick: () => actions.openDialog('get-it') },
    icon('download', { size: 18 }), h('span', { text: 'Get it' }));
  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: './', 'aria-label': 'Constellation home', onclick: (event) => { event.preventDefault(); actions.goHome(); } },
      h('svg:svg', { class: 'brand-mark', width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('svg:path', { fill: 'currentColor', d: 'M12 1.5 14.6 9.4 22.5 12l-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z' })),
      h('span', { class: 'brand-text', text: 'constellation' })),
    account,
    h('div', { class: 'topbar-spacer' }),
    h('div', { class: 'topbar-group', role: 'group', 'aria-label': 'History' }, undo, redo),
    h('span', { class: 'topbar-divider', 'aria-hidden': 'true' }),
    shuffle, save, getIt);

  // ---------------------------------------------------------------- stage
  // A visible title over the map: it says whose sky this is, and it is where
  // focus lands on arrival, so a sighted keyboard user can see where they are.
  const heading = h('h1', { class: 'stage-title', tabindex: '-1' });
  const stage = h('section', { class: 'stage', 'aria-labelledby': 'studio-heading' });
  heading.id = 'studio-heading';
  // ---------------------------------------------------------------- panel
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Customize' });
  const scroll = h('div', { class: 'panel-scroll', 'data-scroll': '' });
  const panelFoot = h('div', { class: 'panel-foot' },
    h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => actions.openDialog('fine-tune') }, icon('sliders', { size: 18 }), 'Fine-tune every setting'));
  const panelHeading = h('h2', { class: 'visually-hidden', id: 'panel-heading', text: 'Customize your map' });
  const panel = h('aside', { class: 'panel', 'aria-labelledby': 'panel-heading' }, panelHeading, tabs, scroll, panelFoot);
  const main = h('main', { class: 'studio-body', id: 'studio-main', tabindex: '-1' }, stage, panel);
  root.replaceChildren(topbar, main);
  stage.append(heading);

  const panels = new Map();
  const tabButtons = new Map();
  for (const [id, mount] of PANELS) {
    const group = GROUPS.find((g) => g.id === id);
    const tab = h('button', {
      class: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`,
      onclick: () => actions.setPanel(id),
      onkeydown: (event) => {
        const order = PANELS.map(([key]) => key);
        const index = order.indexOf(id);
        const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: order.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const target = order[(next + order.length) % order.length];
        actions.setPanel(target);
        tabButtons.get(target).focus();
      },
    }, group.label);
    tabButtons.set(id, tab);
    tabs.append(tab);
    const section = h('div', { role: 'tabpanel', id: `panel-${id}`, 'aria-labelledby': `tab-${id}`, class: 'panel-section-list', style: { display: 'grid', gap: 'var(--space-5)' } });
    panels.set(id, { section, mounted: null, mount });
    scroll.append(section);
  }

  mountMap(stage, ctx);
  mountStarCard(stage, ctx);
  mountDialogs(ctx);

  function draw(state, changed) {
    if (changed.has('account') || changed.has('sample') || changed.has('repositories')) {
      account.textContent = state.sample ? 'Example sky' : `@${state.account}`;
      account.setAttribute('aria-label', state.sample ? 'Example sky. Choose a real account' : `@${state.account}. Choose a different account`);
    }
    if (changed.has('account') || changed.has('sample') || changed.has('repositories') || changed.has('options')) {
      const count = state.account ? actions.shownProjects().length : 0;
      const whose = state.sample ? 'An example sky' : `The sky of @${state.account}`;
      const text = `${whose} · ${count} ${count === 1 ? 'project' : 'projects'}`;
      if (heading.textContent !== text) heading.textContent = text;
    }
    if (changed.has('history') || changed.has('options') || changed.has('screen')) {
      const history = store.history();
      undo.disabled = !history.canUndo;
      redo.disabled = !history.canRedo;
      undo.title = history.canUndo ? `Undo ${history.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
      redo.title = history.canRedo ? `Redo ${history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    }
    if (changed.has('panel') || changed.has('screen')) {
      for (const [id, entry] of panels) {
        const active = id === state.panel;
        const tab = tabButtons.get(id);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        entry.section.hidden = !active;
        // Panels mount lazily the first time they are shown.
        if (active && !entry.mounted && state.screen === 'studio') entry.mounted = entry.mount(entry.section, ctx) || true;
      }
      if (changed.has('panel')) scroll.scrollTop = 0;
    }
    if (changed.has('screen') && state.screen === 'studio') {
      save.disabled = state.sample;
      save.title = state.sample ? 'Load your own account to save designs' : 'Save this design to come back to later';
      // Home may have been scrolled; the Studio always starts at the top.
      ctx.win?.scrollTo?.(0, 0);
      queueMicrotask(() => heading.focus({ preventScroll: true }));
    }
  }
  store.subscribe(draw);
}
