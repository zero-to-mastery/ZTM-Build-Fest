// 'Save this design' and 'Your saved designs'. Both talk to the config store
// directly so a full or blocked localStorage is reported here instead of
// pretending the save worked.

import { h, icon, announce } from '../../dom.mjs';
import { parseConfig } from '../../../config-schema.mjs';

const NAME_MAX = 80;
const PER_ACCOUNT = 30;
const CONFIRM_MS = 4000;

let styled = false;
function loadStyles(doc) {
  if (styled) return;
  styled = true;
  doc.head.append(h('link', { rel: 'stylesheet', href: new URL('./designs.css', import.meta.url).href }));
}

const errorNotice = (id, ...children) => h('div', { class: 'notice', id, role: 'alert', dataset: { tone: 'error' } }, icon('info', { size: 18 }), h('div', { class: 'designs-notice-text' }, ...children));

// ------------------------------------------------------------------- Save

export function createSaveDialog(ctx) {
  const { store, actions, designs, doc } = ctx;
  loadStyles(doc);

  const presetsFor = (account) => { try { return designs.presets(account); } catch { return []; } };

  function defaultName(account) {
    const day = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(new Date());
    const base = `My sky – ${day}`;
    const taken = new Set(presetsFor(account).map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n <= PER_ACCOUNT + 1; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
    return base;
  }

  function buildNoAccount() {
    return {
      body: [
        h('p', { text: 'Saved designs belong to a GitHub account. This is an example sky, so there is nothing to save it to.' }),
        h('p', { class: 'field-help', text: 'Load your own account, then use Save to keep a design in this browser.' }),
      ],
      foot: [
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => actions.closeDialog() }, 'Not now'),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-primary': '', onclick: () => actions.goHome() }, icon('github', { size: 18 }), 'Choose an account'),
      ],
    };
  }

  function build() {
    const { account, sample } = store.get();
    if (!account || sample) return buildNoAccount();

    const helpText = 'Saved in this browser. Download the settings file to keep a backup.';
    const input = h('input', {
      class: 'input', id: 'save-name', name: 'name', type: 'text', autocomplete: 'off', spellcheck: 'false',
      value: defaultName(account), 'aria-describedby': 'save-name-help', required: true,
    });
    const help = h('p', { class: 'field-help', id: 'save-name-help', text: helpText });
    const errorSlot = h('div', { class: 'designs-error-slot' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', form: 'save-form', 'data-primary': '' }, icon('save', { size: 18 }), h('span', { text: 'Save' }));
    const submitLabel = submit.querySelector('span');

    const existing = (title) => presetsFor(account).some((p) => p.name === title);
    function syncReplace() {
      const title = input.value.trim();
      const replacing = Boolean(title) && existing(title);
      submitLabel.textContent = replacing ? 'Replace' : 'Save';
      help.textContent = replacing
        ? `You already saved a design called “${title}” for @${account}. Saving will replace it.`
        : helpText;
    }

    function clearError() {
      errorSlot.replaceChildren();
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby', 'save-name-help');
    }
    function showError(...children) {
      errorSlot.replaceChildren(errorNotice('save-name-error', ...children));
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'save-name-help save-name-error');
      input.focus();
    }

    function save(event) {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return showError(h('p', { text: 'Give your design a name.' }));
      if (title.length > NAME_MAX) return showError(h('p', { text: `Keep the name to ${NAME_MAX} characters or fewer. It has ${title.length} now.` }));
      if (!existing(title) && presetsFor(account).length >= PER_ACCOUNT) {
        return showError(
          h('p', { text: `You can keep up to ${PER_ACCOUNT} saved designs for @${account}. Delete one you no longer need, or reuse a name to replace it.` }),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actions.openDialog('saved') }, icon('folder', { size: 16 }), 'See your saved designs'));
      }
      let stored = false;
      try {
        stored = designs.savePreset(account, title, store.get().options);
      } catch (error) {
        // The store's own limits; the checks above should catch these first.
        return showError(h('p', { text: /30/.test(error.message) ? `You can keep up to ${PER_ACCOUNT} saved designs for @${account}.` : `That name can’t be used. Use 1 to ${NAME_MAX} characters.` }));
      }
      if (!stored) {
        return showError(
          h('p', { text: 'This browser won’t let us save right now. Its storage may be full or turned off.' }),
          h('p', { text: 'To keep a copy anyway, use Get it → Save the settings file.' }),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actions.openDialog('get-it') }, icon('download', { size: 16 }), 'Open Get it'));
      }
      actions.closeDialog();
      actions.toast(`Saved “${title}”.`);
    }

    input.addEventListener('input', () => { clearError(); syncReplace(); });
    syncReplace();
    // The host focuses the field; select the suggested name so typing replaces it.
    // Select the suggested name only if focus landed here (on touch screens the
    // dialog focuses its heading so the keyboard doesn't pop up uninvited).
    queueMicrotask(() => { if (input.isConnected && doc.activeElement === input) input.select(); });

    const form = h('form', { id: 'save-form', class: 'designs-form', novalidate: true, onsubmit: save },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'save-name', text: 'Name' }),
        input,
        help),
      errorSlot);
    return {
      body: [form],
      foot: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => actions.closeDialog() }, 'Cancel'), submit],
    };
  }

  return { title: 'Save this design', build };
}

// ------------------------------------------------------------------ Saved

export function createSavedDialog(ctx) {
  const { store, actions, designs, doc } = ctx;
  loadStyles(doc);
  const timers = new Set();
  let rowSeq = 0;

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  const emptyState = () => h('p', { class: 'designs-empty', tabindex: '-1', text: 'Nothing saved yet. Use Save in the Studio to keep a design.' });

  function build() {
    clearTimers();
    let entries = [];
    try { entries = designs.library(); } catch {}
    const body = h('div', { class: 'designs-saved' });
    const errorSlot = h('div', { class: 'designs-error-slot' });
    if (!entries.length) return { body: [emptyState()] };

    // One section per account; the account on screen comes first.
    const current = store.get().screen === 'studio' && !store.get().sample ? store.get().account?.toLowerCase() : null;
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.account)) groups.set(entry.account, []);
      groups.get(entry.account).push(entry);
    }
    const order = [...groups.keys()].sort((a, b) => (b === current) - (a === current) || a.localeCompare(b));

    async function open(entry, button) {
      errorSlot.replaceChildren();
      button.disabled = true;
      try {
        const { screen, account } = store.get();
        const sameAccount = screen === 'studio' && account && account.toLowerCase() === entry.account.toLowerCase();
        // From Home the Studio may still hold this account from earlier, so
        // always load it rather than editing a hidden Studio.
        const ok = sameAccount
          ? await actions.openDesign(entry)
          : await actions.openAccount(entry.account, { options: parseConfig(entry.config, entry.account).options });
        if (ok) actions.toast(`Opened “${entry.name}”.`);
      } catch {
        if (button.isConnected) button.disabled = false;
        errorSlot.replaceChildren(errorNotice('saved-error', h('p', { text: `“${entry.name}” couldn’t be opened. Its settings may be from a newer version.` })));
      }
    }

    function remove(entry, row, button) {
      if (button.dataset.confirm !== 'true') {
        button.dataset.confirm = 'true';
        button.className = 'btn btn-sm btn-danger';
        button.setAttribute('aria-label', `Confirm delete ${entry.name}`);
        button.replaceChildren(icon('trash', { size: 16 }), h('span', { text: 'Confirm delete' }));
        announce(`Press again to delete ${entry.name}.`);
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!button.isConnected) return;
          button.dataset.confirm = 'false';
          button.className = 'icon-btn';
          button.setAttribute('aria-label', `Delete ${entry.name}`);
          button.replaceChildren(icon('trash'));
        }, CONFIRM_MS);
        timers.add(timer);
        return;
      }
      let ok = false;
      try { ok = designs.delete(entry.account, entry.name); } catch {}
      if (!ok) {
        errorSlot.replaceChildren(errorNotice('saved-error', h('p', { text: 'This browser won’t let us change saved designs right now.' })));
        return;
      }
      // Keep focus in the list: next row, else previous row, else the empty note.
      const list = row.parentElement;
      const section = list.closest('section');
      const neighbour = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      if (!list.childElementCount) section.remove();
      announce(`Deleted “${entry.name}”.`);
      if (neighbour) neighbour.querySelector('button')?.focus();
      else {
        const next = body.querySelector('.design-row button');
        if (next) next.focus();
        else {
          const empty = emptyState();
          body.replaceChildren(empty);
          empty.focus();
        }
      }
    }

    for (const account of order) {
      const headingId = `saved-account-${++rowSeq}`;
      const list = h('ul', { class: 'designs-list', 'aria-labelledby': headingId });
      for (const entry of groups.get(account)) {
        const row = h('li', { class: 'design-row' });
        const openButton = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Open ${entry.name}` }, 'Open');
        openButton.addEventListener('click', () => open(entry, openButton));
        const deleteButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${entry.name}`, title: 'Delete' }, icon('trash'));
        deleteButton.addEventListener('click', () => remove(entry, row, deleteButton));
        row.append(h('span', { class: 'design-name', text: entry.name }), h('span', { class: 'design-actions' }, openButton, deleteButton));
        list.append(row);
      }
      body.append(h('section', { class: 'designs-group' }, h('h3', { id: headingId, text: `@${account}` }), list));
    }
    return {
      body: [h('p', { class: 'field-help', text: 'Designs are kept in this browser. Opening one for another account loads that account.' }), errorSlot, body],
    };
  }

  return { title: 'Your saved designs', build, onClose: clearTimers };
}
