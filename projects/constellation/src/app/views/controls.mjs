// Build an accessible control for one registry setting. Controls are created
// once and then synced in place, so dragging a slider never loses focus.

import { h } from '../dom.mjs';

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

// Even rows: four choices sit 2×2 and six sit 3×2, so none is left alone.
const columnsFor = (count) => (count <= 3 ? count : count === 4 ? 2 : 3);

function formatNumber(value, control) {
  const decimals = String(control.step ?? 1).split('.')[1]?.length || 0;
  return `${Number(value).toFixed(decimals)}${control.unit || ''}`;
}

/**
 * @returns {{ element: HTMLElement, sync(options, context): void }}
 * context: { signedIn, repositories } for availability checks.
 */
export function createControl(setting, { actions }) {
  const { control } = setting;
  const id = nextId(setting.id.replace(/\W/g, '-'));
  const helpId = setting.help ? `${id}-help` : undefined;
  const help = setting.help ? h('p', { class: 'field-help', id: helpId, text: setting.help }) : null;
  const signInNote = setting.needsSignIn ? h('p', { class: 'locked', hidden: true }, 'Sign in with GitHub to use this.') : null;
  const commit = (value) => actions.setSetting(setting.id, value);
  let element;
  let sync;

  if (control.type === 'toggle') {
    const input = h('input', { type: 'checkbox', role: 'switch', id, 'aria-describedby': helpId, onchange: () => commit(input.checked) });
    element = h('div', { class: 'field' },
      h('div', { class: 'field-row' }, h('label', { class: 'field-label', for: id, text: setting.label }), h('span', { class: 'switch' }, input)),
      help, signInNote);
    sync = (options) => { input.checked = Boolean(setting.read(options)); };
  } else if (control.type === 'segmented') {
    const name = nextId('choice');
    const inputs = control.choices.map((choice) => {
      const input = h('input', { type: 'radio', name, value: String(choice.value), onchange: () => input.checked && commit(choice.value) });
      return [choice, input];
    });
    const legendId = `${id}-legend`;
    element = h('fieldset', { class: 'field', style: { border: '0', padding: '0', margin: '0', minWidth: '0' }, 'aria-describedby': helpId },
      h('legend', { class: 'field-label', id: legendId, text: setting.label, style: { padding: '0', marginBottom: '8px' } }),
      h('div', { class: 'segmented', style: { '--columns': String(columnsFor(inputs.length)) } }, inputs.map(([choice, input]) => h('label', { title: choice.hint }, input, h('span', { text: choice.label })))),
      help, signInNote);
    sync = (options) => {
      const value = String(setting.read(options));
      for (const [choice, input] of inputs) input.checked = String(choice.value) === value;
    };
  } else if (control.type === 'select') {
    const select = h('select', { class: 'select', id, 'aria-describedby': helpId, onchange: () => commit(select.value) },
      control.choices.map((choice) => h('option', { value: String(choice.value), text: choice.label })));
    element = h('div', { class: 'field' }, h('label', { class: 'field-label', for: id, text: setting.label }), select, help, signInNote);
    sync = (options) => { select.value = String(setting.read(options)); };
  } else if (control.type === 'range') {
    // The slider already announces its value (aria-valuetext), so the visible number is not read again.
    const output = h('output', { for: id, 'aria-hidden': 'true' });
    const input = h('input', {
      type: 'range', id, min: control.min, max: control.max, step: control.step ?? 1, 'aria-describedby': helpId,
      oninput: () => { output.textContent = formatNumber(input.value, control); commit(input.value); },
    });
    element = h('div', { class: 'field' }, h('label', { class: 'field-label', for: id, text: setting.label }), h('div', { class: 'range' }, input, output), help);
    sync = (options) => {
      const value = setting.read(options);
      if (document.activeElement !== input) input.value = value;
      output.textContent = formatNumber(value, control);
      input.setAttribute('aria-valuetext', formatNumber(value, control));
    };
  } else if (control.type === 'number') {
    const input = h('input', { class: 'input', type: 'number', id, min: control.min, max: control.max, step: control.step ?? 1, inputmode: 'numeric', 'aria-describedby': helpId, onchange: () => commit(input.value) });
    element = h('div', { class: 'field' }, h('label', { class: 'field-label', for: id, text: setting.label }), input, help);
    sync = (options) => { if (document.activeElement !== input) input.value = setting.read(options); };
  } else if (control.type === 'color') {
    const input = h('input', { class: 'color-input', type: 'color', id, 'aria-describedby': helpId, oninput: () => commit(input.value) });
    element = h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { class: 'field-label', for: id, text: setting.label }), input), help);
    sync = (options) => { const value = setting.read(options); input.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#8f86ff'; };
  } else if (control.type === 'text' || control.type === 'textarea') {
    const area = control.type === 'textarea';
    const input = h(area ? 'textarea' : 'input', {
      class: area ? 'textarea' : 'input', id, maxlength: control.maxLength, rows: control.rows, placeholder: control.placeholder,
      'aria-describedby': helpId, spellcheck: area ? 'false' : undefined,
      // Text commits when you leave the field, so each keystroke is not an Undo step.
      onchange: () => commit(input.value),
    });
    element = h('div', { class: 'field' }, h('label', { class: 'field-label', for: id, text: setting.label }), input, help);
    sync = (options) => { if (document.activeElement !== input) input.value = setting.read(options) ?? ''; };
  } else {
    throw new Error(`No control for ${control.type}`);
  }

  element.dataset.setting = setting.id;
  return {
    element,
    sync(options, context = {}) {
      sync(options);
      if (setting.needsSignIn) {
        const locked = !context.signedIn;
        signInNote.hidden = !locked;
        for (const input of element.querySelectorAll('input, select, textarea')) input.disabled = locked;
      }
    },
  };
}
