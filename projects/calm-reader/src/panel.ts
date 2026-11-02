// Side panel in a shadow root, so page CSS cannot break it and ours cannot leak.
// Model output is only ever written with textContent, never as HTML.

export const PANEL_ID = 'calm-reader-panel';

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(400px, 100vw); z-index: 2147483647;
  box-sizing: border-box; padding: 20px; overflow-y: auto;
  background: #fffdf8; color: #222; border-left: 2px solid #3b7d6e;
  font: 17px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: -8px 0 24px rgba(0,0,0,.15);
}
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
h2 { margin: 0; font-size: 1.1em; }
button {
  font: inherit; padding: 6px 12px; background: transparent; color: #222;
  border: 2px solid #3b7d6e; border-radius: 8px; cursor: pointer;
}
button:focus-visible { outline: 3px solid #e0a100; outline-offset: 2px; }
.tldr { background: #e8f2ee; border-radius: 8px; padding: 12px 14px; margin: 0 0 16px; }
.tldr strong { display: block; font-size: .8em; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
p { margin: 0 0 1em; }
.error { color: #b3261e; }
/* Dark overrides last, so they win over the base rules above. */
@media (prefers-color-scheme: dark) {
  .panel { background: #1e211f; color: #ece9e1; border-left-color: #6fb3a2; }
  .tldr { background: #26302d; }
  button { color: #ece9e1; border-color: #6fb3a2; }
  .error { color: #ff8a80; }
}
`;

export interface Panel {
  loading(): void;
  result(text: string): void;
  error(message: string): void;
}

export function openPanel(): Panel {
  document.getElementById(PANEL_ID)?.remove();

  const host = document.createElement('div');
  host.id = PANEL_ID;
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const panel = document.createElement('aside');
  panel.className = 'panel';
  panel.setAttribute('aria-label', 'Calm Reader simplified text');

  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = 'Calm Reader';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  header.append(title, close);

  const body = document.createElement('div');
  body.setAttribute('aria-live', 'polite');

  panel.append(header, body);
  root.append(style, panel);
  document.documentElement.append(host);

  const dismiss = () => {
    document.removeEventListener('keydown', onKey, true);
    host.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey, true);
  close.focus();

  const para = (text: string, cls?: string) => {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    p.textContent = text;
    return p;
  };

  return {
    loading() {
      body.replaceChildren(para('Simplifying…'));
    },
    error(message) {
      body.replaceChildren(para(message, 'error'));
    },
    result(text) {
      const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      const nodes: Node[] = [];
      if (parts[0] && /^TL;DR:?/i.test(parts[0])) {
        const box = document.createElement('div');
        box.className = 'tldr';
        const label = document.createElement('strong');
        label.textContent = 'In short';
        const line = document.createElement('span');
        line.textContent = parts.shift()!.replace(/^TL;DR:?\s*/i, '');
        box.append(label, line);
        nodes.push(box);
      }
      for (const part of parts) nodes.push(para(part));
      body.replaceChildren(...nodes);
    },
  };
}
