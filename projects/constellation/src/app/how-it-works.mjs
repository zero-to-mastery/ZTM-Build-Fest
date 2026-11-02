// The "How it works" page's live example: the Studio's own engine draws the
// built-in example sky, with no GitHub requests. The page reads fine without
// it; if WebAssembly is blocked, the fallback sentence stays in place.
import { createEngine, defaultOptions } from './engine.mjs';
import { applySetting } from './settings.mjs';

const stage = document.getElementById('demo-stage');
const controls = document.getElementById('demo-controls');
const status = document.getElementById('demo-status');

const engine = createEngine();
const { account, repositories, profile } = engine.sample();
const base = defaultOptions(account, repositories, profile);
// Names come from the visible labels, so what is announced matches what is shown.
const labelOf = (input) => input.closest('label').textContent.trim();

// A shadow root keeps the page's styles away from the map's own nested SVGs,
// as the Studio's map does.
const host = document.createElement('div');
host.className = 'guide-sky';
const shadow = host.attachShadow({ mode: 'open' });

function draw(changed = null) {
  const layout = controls.querySelector('input[name="layout"]:checked');
  const theme = controls.querySelector('input[name="theme"]:checked');
  let options = applySetting(base, 'look.theme', theme.value);
  options = applySetting(options, 'layout.arrangement', layout.value);
  // A "Generated …" date means nothing on a made-up example.
  const svg = engine.render(account, repositories, options, { sample: true }).svg
    .replace(/<text class="generated-at"[^>]*>[^<]*<\/text>/, '');
  shadow.innerHTML = `<style>:host{display:block}svg{display:block;width:100%;height:auto}</style>${svg}`;
  const picture = shadow.querySelector('svg');
  picture.removeAttribute('aria-labelledby');
  picture.setAttribute('role', 'img');
  picture.setAttribute('aria-label', `An example sky of ${repositories.length} projects: ${labelOf(layout)} layout, ${labelOf(theme)} theme`);
  if (changed) status.textContent = `Showing the ${labelOf(changed)} ${changed.name}.`;
}

draw();
stage.replaceChildren(host);
controls.addEventListener('change', (event) => draw(event.target));
controls.hidden = false;
