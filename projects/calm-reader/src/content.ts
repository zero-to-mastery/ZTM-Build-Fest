import { Readability } from '@mozilla/readability';
import { buildCss } from './profiles';
import { openPanel, PANEL_ID } from './panel';
import { getPrefs, type Msg, type Reply } from './shared';

const STYLE_ID = 'calm-reader-style';
let observer: MutationObserver | null = null;
let timer: number | undefined;

/** Hide fixed pop-ups, banners and overlays. Short bars stuck to the top (site headers) stay. */
function hideOverlays(): void {
  let hidden = 0;
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    if (el.id === PANEL_ID || el.hasAttribute('data-cr-hidden') || el.closest('[data-cr-hidden]')) continue;
    if (getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.top <= 4 && r.height < 120) continue;
    el.setAttribute('data-cr-hidden', '');
    hidden++;
  }
  // Pop-ups often lock page scrolling. Undo that only when we removed something.
  if (hidden > 0) document.documentElement.setAttribute('data-cr-unlock', '');
}

function pauseMedia(): void {
  for (const m of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    m.autoplay = false;
    if (!m.paused) m.pause();
  }
}

// Autoplay only: if the user has never interacted with the page, a play event is not theirs.
function onPlay(e: Event): void {
  if (!navigator.userActivation.hasBeenActive && e.target instanceof HTMLMediaElement) e.target.pause();
}

function remove(): void {
  document.getElementById(STYLE_ID)?.remove();
  observer?.disconnect();
  observer = null;
  document.removeEventListener('play', onPlay, true);
  for (const el of document.querySelectorAll('[data-cr-hidden]')) el.removeAttribute('data-cr-hidden');
  document.documentElement.removeAttribute('data-cr-unlock');
}

async function apply(): Promise<void> {
  const prefs = await getPrefs();
  remove();
  if (!prefs.enabled || prefs.disabledHosts.includes(location.hostname)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildCss(prefs.profile, chrome.runtime.getURL(''));
  document.documentElement.append(style);

  if (prefs.profile === 'adhd' || prefs.profile === 'calm') {
    hideOverlays();
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(hideOverlays, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (prefs.profile === 'calm') {
    pauseMedia();
    document.addEventListener('play', onPlay, true);
  }
}

function pageText(): string {
  const selected = window.getSelection()?.toString().trim();
  if (selected) return selected;
  const article = new Readability(document.cloneNode(true) as Document).parse();
  return (article?.textContent ?? document.body.innerText).replace(/\s+\n/g, '\n').trim();
}

async function simplify(): Promise<void> {
  const panel = openPanel();
  const text = pageText();
  if (!text) {
    panel.error('No readable text found. Try selecting the part you want simplified.');
    return;
  }
  panel.loading();
  try {
    const reply: Reply = await chrome.runtime.sendMessage({ type: 'simplify', text } satisfies Msg);
    if (reply.ok) panel.result(reply.text);
    else panel.error(reply.error);
  } catch {
    panel.error('Calm Reader lost contact with the extension. Reload this page and try again.');
  }
}

chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === 'simplify-page') void simplify();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.prefs) void apply();
});

void apply();
