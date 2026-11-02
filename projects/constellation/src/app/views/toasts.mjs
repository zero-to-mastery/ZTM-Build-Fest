import { h } from '../dom.mjs';

// Short confirmations with an optional single action ("Undo"). The host is an
// aria-live region, so each toast is announced.
//  - key: a toast with the same key replaces the previous one instead of stacking.
//  - Action toasts stay at least 10 s and pause while hovered or focused, so a
//    keyboard or screen reader user can reach the button (WCAG 2.2.1).
export function mountToasts(host) {
  const live = new Map();

  const show = (text, { tone = 'info', action = null, timeout, key = null } = {}) => {
    if (key && live.has(key)) live.get(key)();
    const toast = h('div', { class: 'toast', role: tone === 'error' ? 'alert' : 'status', dataset: { tone } }, h('span', { text }));
    let timer = null;
    let remaining = timeout ?? (tone === 'error' ? 9000 : action ? 10000 : 3500);
    let started = 0;
    const dismiss = () => {
      clearTimeout(timer);
      toast.remove();
      if (key && live.get(key) === dismiss) live.delete(key);
    };
    const run = () => { started = Date.now(); timer = setTimeout(dismiss, remaining); };
    const pause = () => { clearTimeout(timer); remaining = Math.max(1500, remaining - (Date.now() - started)); };
    if (action) {
      toast.append(h('button', { class: 'btn', type: 'button', onclick: () => { dismiss(); action.run(); } }, action.label));
      toast.addEventListener('pointerenter', pause);
      toast.addEventListener('pointerleave', run);
      toast.addEventListener('focusin', pause);
      toast.addEventListener('focusout', run);
    }
    host.append(toast);
    while (host.children.length > 3) host.firstElementChild.remove();
    if (key) live.set(key, dismiss);
    run();
    return dismiss;
  };

  /** Remove every toast, e.g. when leaving the Studio so an Undo can't act unseen. */
  const dismissAll = () => {
    for (const dismiss of [...live.values()]) dismiss();
    host.replaceChildren();
  };

  return { show, dismissAll };
}
