// A radio group of picture cards. Each card is a live thumbnail of the
// visitor's own map with that choice applied, drawn when the browser is idle.

import { h, icon } from '../dom.mjs';
import { applySetting } from '../settings.mjs';

let galleryId = 0;
const idle = (fn) => (globalThis.requestIdleCallback ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 16));

export function createGallery(setting, { store, engine, actions }, { label = setting.label } = {}) {
  const cards = new Map();
  const urls = new Map();
  const cache = new Map();
  const group = h('div', { class: 'gallery', role: 'radiogroup', 'aria-label': label });
  let generation = 0;

  for (const choice of setting.control.choices) {
    const base = `gallery-${++galleryId}`;
    const thumb = h('div', { class: 'gallery-thumb loading' });
    const hint = h('span', { class: 'gallery-hint', id: `${base}-hint`, text: choice.hint || '' });
    // Named by its name alone; the hint (or why it is unavailable) is its description.
    const card = h('div', {
      class: 'gallery-card', role: 'radio', tabindex: '-1', 'aria-checked': 'false', dataset: { value: String(choice.value) },
      'aria-labelledby': `${base}-name`, 'aria-describedby': `${base}-hint`,
      onclick: () => pick(choice.value),
      onkeydown: (event) => onKey(event, choice.value),
    },
    thumb,
    h('span', { class: 'gallery-name', id: `${base}-name`, text: choice.label }),
    hint,
    h('span', { class: 'check', 'aria-hidden': 'true' }, icon('check', { size: 14 })));
    cards.set(String(choice.value), { card, thumb, hint, choice });
    group.append(card);
  }

  function pick(value) {
    const entry = cards.get(String(value));
    if (!entry || entry.card.getAttribute('aria-disabled') === 'true') return;
    actions.setSetting(setting.id, value);
  }

  function onKey(event, value) {
    const values = [...cards.keys()];
    const index = values.indexOf(String(value));
    // Two-dimensional grid: Up/Down jump a row.
    const columns = Math.max(1, Math.round(group.clientWidth / (cards.get(values[0]).card.offsetWidth || 1)));
    const delta = { ArrowRight: 1, ArrowDown: columns, ArrowLeft: -1, ArrowUp: -columns }[event.key];
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); pick(value); return; }
    if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let next = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : index + delta;
    next = Math.max(0, Math.min(values.length - 1, next));
    const target = cards.get(values[next]);
    target.card.focus();
    if (target.card.getAttribute('aria-disabled') !== 'true') pick(values[next]);
  }

  function thumbnails(state) {
    const current = ++generation;
    const queue = [...cards.values()];
    const step = () => {
      if (current !== generation || !queue.length) return;
      const { choice, thumb } = queue.shift();
      const key = `${state.account}|${choice.value}|${JSON.stringify(state.options)}`;
      let url = cache.get(key);
      if (!url) {
        try {
          const svg = engine.thumbnail(state.account, state.repositories, applySetting(state.options, setting.id, choice.value), { sample: state.sample });
          url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          cache.set(key, url);
          if (cache.size > 120) {
            const [oldKey, oldUrl] = cache.entries().next().value;
            cache.delete(oldKey);
            URL.revokeObjectURL(oldUrl);
          }
        } catch {
          url = null;
        }
      }
      if (url && urls.get(choice.value) !== url) {
        urls.set(choice.value, url);
        thumb.replaceChildren(h('img', { src: url, alt: '', decoding: 'async', loading: 'lazy' }));
      }
      thumb.classList.remove('loading');
      idle(step);
    };
    idle(step);
  }

  let thumbTimer = null;
  let lastValue = null;
  function sync(state, changed = new Set(['options'])) {
    const value = String(setting.read(state.options));
    // Undo or Redo changed the choice while focus was on another card here:
    // focus follows the checked card, so the roving tab stop stays with it.
    const followFocus = lastValue !== null && value !== lastValue && group.contains(document.activeElement)
      && document.activeElement !== cards.get(value)?.card;
    lastValue = value;
    const availability = setting.available?.({ repositories: state.repositories, signedIn: engine.signedIn }) || {};
    let focusable = null;
    for (const [key, { card, hint, choice }] of cards) {
      const checked = key === value;
      card.setAttribute('aria-checked', String(checked));
      const reason = availability[key];
      const disabled = reason !== undefined && reason !== true;
      card.setAttribute('aria-disabled', String(disabled));
      hint.textContent = disabled ? reason : choice.hint || '';
      card.tabIndex = -1;
      if (checked) focusable = card;
    }
    (focusable || cards.values().next().value.card).tabIndex = 0;
    if (followFocus && focusable) focusable.focus();
    // Redraw thumbnails after the visitor pauses, not on every slider tick.
    if (changed.has('options') || changed.has('repositories')) {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => thumbnails(store.get()), 250);
    }
  }

  return { element: group, sync };
}
