// One host for every modal sheet. A dialog module exports
//   create(ctx) => { title, build(): { body: Node[], foot?: Node[] }, onClose?() }
// The host owns <dialog>, the title, the close button, Escape, focus return,
// the inert page behind, and where announcements and toasts go while open.

import { h, icon } from '../dom.mjs';
import { createGetItDialog } from './dialogs/get-it.mjs';
import { createFineTuneDialog } from './dialogs/fine-tune.mjs';
import { createSaveDialog, createSavedDialog } from './dialogs/designs.mjs';
import { createSignInDialog } from './dialogs/sign-in.mjs';

const FACTORIES = {
  'get-it': createGetItDialog,
  'fine-tune': createFineTuneDialog,
  save: createSaveDialog,
  saved: createSavedDialog,
  'sign-in': createSignInDialog,
};

const FOCUSABLE = '[autofocus], input:not([type=hidden]):not([disabled]), button:not([disabled]), select, textarea, a[href]';
const NOT_TYPING = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image']);
/** Focusing this would open an on-screen keyboard. */
const opensKeyboard = (element) => element?.tagName === 'TEXTAREA' || (element?.tagName === 'INPUT' && !NOT_TYPING.has(element.type));

export function mountDialogs(ctx) {
  const { store, actions, doc } = ctx;
  const titleId = 'sheet-title';
  // tabindex -1: on touch screens the heading takes focus instead of a text field.
  const title = h('h2', { id: titleId, tabindex: '-1' });
  const body = h('div', { class: 'sheet-body', 'data-scroll': '' });
  const foot = h('div', { class: 'sheet-foot' });
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => actions.closeDialog() }, icon('close'));
  // Live regions behind a modal are not read, so the sheet has its own.
  const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-announcer': '' });
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': titleId },
    h('div', { class: 'sheet-head' }, title, close), body, foot, live);
  doc.body.append(dialog);

  const background = () => ['home', 'studio'].map((id) => doc.getElementById(id)).filter(Boolean);
  const toasts = doc.getElementById('toasts');
  const coarse = ctx.win?.matchMedia?.('(pointer: coarse)');
  // While a sheet is open its toasts sit at the top of the screen, and the
  // sheet gives up that much height, so a toast never covers its content.
  const measureToasts = () => {
    const height = toasts?.classList.contains('in-dialog') ? toasts.getBoundingClientRect().height : 0;
    dialog.style.setProperty('--toast-room', height ? `${Math.ceil(height) + 20}px` : '0px');
  };
  if (toasts) new ResizeObserver(measureToasts).observe(toasts);
  const instances = new Map();
  let current = null;
  let returnFocus = null;

  // Escape takes the same path as the Close button, so onClose and focus
  // return always run.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    actions.closeDialog();
  });
  dialog.addEventListener('click', (event) => {
    // A click on the backdrop (outside the sheet box) closes it.
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) actions.closeDialog();
  });

  function open(name) {
    const factory = FACTORIES[name];
    if (!factory) return;
    if (!instances.has(name)) instances.set(name, factory(ctx));
    current = instances.get(name);
    const content = current.build();
    title.textContent = current.title;
    dialog.dataset.dialog = name;
    body.replaceChildren(...[content.body].flat().filter(Boolean));
    foot.replaceChildren(...[content.foot || []].flat().filter(Boolean));
    foot.hidden = !foot.childElementCount;
    if (!dialog.open) {
      returnFocus = doc.activeElement;
      dialog.showModal();
      for (const element of background()) element.inert = true;
      // Toasts (and their Undo buttons) must stay reachable above the modal.
      if (toasts) { toasts.classList.add('in-dialog'); dialog.append(toasts); measureToasts(); }
    }
    // Focus the first meaningful control rather than the close button. On a
    // touch screen a text field would pop up the keyboard over the sheet, so
    // the heading takes focus and the visitor taps the field when ready.
    const first = body.querySelector(FOCUSABLE) || foot.querySelector(FOCUSABLE);
    if (coarse?.matches && opensKeyboard(first)) title.focus();
    else (first || close).focus();
    body.scrollTop = 0;
  }

  function shut() {
    current?.onClose?.();
    current = null;
    for (const element of background()) element.inert = false;
    if (toasts) { toasts.classList.remove('in-dialog'); doc.body.append(toasts); }
    dialog.style.setProperty('--toast-room', '0px');
    dialog.close();
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  store.subscribe((state, changed) => {
    if (!changed.has('dialog')) return;
    if (state.dialog) open(state.dialog);
    else if (dialog.open) shut();
  });

  /** Lets a dialog re-render itself, e.g. after switching an inner step. */
  ctx.refreshDialog = () => { if (store.get().dialog) open(store.get().dialog); };
}
