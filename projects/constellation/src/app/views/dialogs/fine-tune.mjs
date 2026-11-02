// Fine-tune: every registry setting in one searchable form, plus the whole
// configuration as JSON. Controls are built once per open and filtered by
// toggling `hidden`, so typing in the search box never rebuilds (or blurs) it.

import { h, icon, announce } from '../../dom.mjs';
import { GROUPS, SETTINGS, searchSettings } from '../../settings.mjs';
import { CONFIG_VERSION, MAX_CONFIG_BYTES } from '../../../config-schema.mjs';
import { createControl } from '../controls.mjs';

// Registry wording that reads as engine vocabulary in a flat list of every
// setting. Remove an entry once settings.mjs says it plainly itself.
const WORDING = {
  'layout.arrangement': { label: 'Layout style' },
  'layout.focus': { help: 'Used by the Skills layout.' },
  'layout.seed': { label: 'Layout code', help: 'Any word. The same word always gives the same layout.' },
};
const reworded = (setting) => (WORDING[setting.id] ? { ...setting, ...WORDING[setting.id] } : setting);

const CONFIRM_MS = 4000;
let uid = 0;

/** Gallery settings are big visual pickers in the panels; here a <select> is enough. */
function createSelectControl(setting, { actions }) {
  const id = `fine-tune-${setting.id.replace(/\W/g, '-')}-${++uid}`;
  const helpId = setting.help ? `${id}-help` : undefined;
  const options = new Map(setting.control.choices.map((choice) => [String(choice.value), h('option', { value: String(choice.value), text: choice.label })]));
  // Shown only when the current value isn't one of the choices (own colours, say).
  const other = h('option', { value: '', disabled: true, hidden: true, text: 'Your own' });
  const select = h('select', { class: 'select', id, 'aria-describedby': helpId, onchange: () => actions.setSetting(setting.id, select.value) }, [...options.values()], other);
  const element = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id, text: setting.label }), select,
    setting.help ? h('p', { class: 'field-help', id: helpId, text: setting.help }) : null);
  element.dataset.setting = setting.id;
  return {
    element,
    sync(state, context = {}) {
      const availability = setting.available?.(context) || {};
      for (const choice of setting.control.choices) {
        const reason = availability[choice.value];
        const option = options.get(String(choice.value));
        option.disabled = typeof reason === 'string';
        option.textContent = option.disabled ? `${choice.label} (${reason.replace(/\.$/, '').toLowerCase()})` : choice.label;
      }
      const value = String(setting.read(state));
      other.hidden = options.has(value);
      select.value = options.has(value) ? value : '';
    },
  };
}

export function createFineTuneDialog(ctx) {
  const { store, engine, actions, doc } = ctx;
  doc.head.append(h('link', { rel: 'stylesheet', href: new URL('./fine-tune.css', import.meta.url).href }));
  let cleanup = null;

  function build() {
    cleanup?.();
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

    // ------------------------------------------------------------ search
    const searchId = `fine-tune-search-${++uid}`;
    const search = h('input', {
      class: 'input', type: 'search', id: searchId, placeholder: 'Search, e.g. glow, forks, title', autocomplete: 'off', spellcheck: 'false',
      oninput: () => filter(),
    });
    const emptyText = h('p');
    const empty = h('div', { class: 'notice fine-tune-empty', hidden: true },
      emptyText,
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { search.value = ''; filter(); search.focus(); } }, 'Clear search'));

    // ---------------------------------------------------------- settings
    const controls = SETTINGS.map((setting) => {
      const shown = reworded(setting);
      const control = setting.control.type === 'gallery' ? createSelectControl(shown, ctx) : createControl(shown, ctx);
      return { setting, words: `${shown.label} ${shown.help || ''}`.toLowerCase(), control };
    });
    const groups = GROUPS.map((group) => {
      const members = controls.filter((c) => c.setting.group === group.id);
      const headingId = `fine-tune-group-${group.id}-${uid}`;
      const element = h('section', { class: 'setting-group', 'aria-labelledby': headingId },
        h('h3', { id: headingId, text: group.label }),
        h('p', { class: 'field-help fine-tune-blurb', text: group.blurb }),
        h('div', { class: 'setting-list' }, members.map((c) => c.control.element)));
      return { element, members };
    }).filter((group) => group.members.length);

    let announceTimer = null;
    function filter() {
      const query = search.value.trim();
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = new Set(searchSettings(query).map((s) => s.id));
      let count = 0;
      for (const { setting, words: text, control } of controls) {
        // A reworded setting is also found by the words it shows here.
        const match = matches.has(setting.id) || (WORDING[setting.id] && words.length > 0 && words.every((w) => text.includes(w)));
        control.element.hidden = !match;
        if (match) count++;
      }
      for (const group of groups) group.element.hidden = group.members.every((c) => c.control.element.hidden);
      emptyText.textContent = `No settings match “${query}”.`;
      empty.hidden = count > 0;
      clearTimeout(announceTimer);
      // Wait for a pause in typing so the screen reader isn't flooded.
      announceTimer = later(() => announce(!query ? `All ${controls.length} settings.` : count ? `${count} ${count === 1 ? 'setting matches' : 'settings match'}.` : emptyText.textContent), 500);
    }

    // -------------------------------------------------------------- JSON
    const jsonId = `fine-tune-json-${uid}`;
    let dirty = false;
    const area = h('textarea', {
      class: 'textarea fine-tune-json', id: jsonId, rows: 14, spellcheck: 'false', autocomplete: 'off',
      'aria-describedby': `${jsonId}-help`, oninput: () => { dirty = true; },
    });
    const error = h('div', { class: 'notice', 'data-tone': 'error', role: 'alert', hidden: true });
    const fill = () => { area.value = JSON.stringify(store.get().options, null, 2); dirty = false; error.hidden = true; };
    function apply() {
      const text = area.value;
      const fail = (message) => { error.textContent = message; error.hidden = false; };
      if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) return fail(`That is too large. Settings can be up to ${Math.round(MAX_CONFIG_BYTES / 1000)} KB.`);
      let value;
      try { value = JSON.parse(text); } catch (cause) { return fail(`That isn’t valid JSON: ${cause.message}`); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Settings must be a JSON object, like { "title": "My sky" }.');
      try {
        // Bare options are the visitor's own, so treat them like a current settings file.
        actions.applyConfig('version' in value ? value : { version: CONFIG_VERSION, options: value }, 'Edit settings as JSON');
      } catch (cause) {
        return fail(`Couldn’t apply these settings: ${cause.message}`);
      }
      fill();
      announce('Applied your settings.');
      actions.toast('Applied your settings.', { action: { label: 'Undo', run: () => actions.undo() } });
    }
    const detailsBody = h('div', { class: 'fine-tune-details-body', hidden: true },
      h('label', { class: 'field-label', for: jsonId, text: 'Settings as JSON' }),
      h('p', { class: 'field-help', id: `${jsonId}-help`, text: 'The same settings as above, as text. Paste a settings file here, or edit and apply.' }),
      area, error,
      h('div', { class: 'fine-tune-actions' },
        h('button', { class: 'btn', type: 'button', onclick: apply }, icon('check', { size: 18 }), 'Apply'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { fill(); area.focus(); } }, 'Reset')));
    const details = h('details', {
      class: 'fine-tune-details',
      ontoggle: () => {
        // Closed <details> content still has layout boxes; `hidden` takes it out of hit-testing and budgets too.
        detailsBody.hidden = !details.open;
        if (details.open && !dirty) fill();
      },
    }, h('summary', {}, 'Edit all settings as JSON'), detailsBody);

    // -------------------------------------------------------- start over
    let confirming = null;
    const startOverText = h('span', { text: 'Start over with the default design' });
    const startOver = h('button', {
      class: 'btn btn-ghost btn-danger', type: 'button',
      onclick: () => {
        if (!confirming) {
          // A two-step click instead of a second dialog: nothing is lost either way, Undo brings it back.
          startOverText.textContent = 'Click again to start over';
          announce('Click again to start over.');
          confirming = later(resetStartOver, CONFIRM_MS);
          return;
        }
        resetStartOver();
        actions.startFresh();
        actions.toast('Started over with the default design. Undo brings yours back.', { action: { label: 'Undo', run: () => actions.undo() } });
      },
    }, icon('trash', { size: 18 }), startOverText);
    function resetStartOver() {
      if (confirming) { clearTimeout(confirming); timers.delete(confirming); }
      confirming = null;
      startOverText.textContent = 'Start over with the default design';
    }

    // -------------------------------------------------------------- sync
    const sync = (state, changed) => {
      if (!(changed.has('options') || changed.has('repositories') || changed.has('account'))) return;
      const context = { signedIn: engine.signedIn, repositories: state.repositories || [] };
      for (const { control } of controls) control.sync(state.options, context);
      if (details.open && !dirty) fill();
    };
    sync(store.get(), new Set(['options']));
    const unsubscribe = store.subscribe(sync);
    cleanup = () => {
      unsubscribe();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      cleanup = null;
    };

    return {
      // Search stays put while the settings scroll beneath it.
      body: [
        h('div', { class: 'field fine-tune-search' },
          h('label', { class: 'field-label', for: searchId, text: 'Search settings' }),
          h('div', { class: 'search' }, icon('search', { size: 18 }), search)),
        h('div', { class: 'fine-tune-scroll', 'data-scroll': '' },
          empty,
          ...groups.map((g) => g.element),
          h('section', { class: 'setting-group fine-tune-advanced', 'aria-label': 'Everything at once' }, details, h('div', {}, startOver))),
      ],
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => actions.closeDialog() }, 'Done')],
    };
  }

  return { title: 'Fine-tune', build, onClose: () => cleanup?.() };
}
