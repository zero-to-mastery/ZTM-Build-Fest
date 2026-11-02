import { h, replace, icon } from '../dom.mjs';

const LAST_ACCOUNT = 'constellation:last-account';

// A quiet, deterministic star field behind the hero. Decorative only.
function drawSky(host) {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const svg = h('svg:svg', { viewBox: '0 0 1600 900', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false' });
  const stars = Array.from({ length: 140 }, () => ({ x: random() * 1600, y: random() * 900, r: random() * 1.6 + 0.3, o: random() * 0.6 + 0.2 }));
  const bright = stars.filter((s) => s.r > 1.5).slice(0, 9).sort((a, b) => a.x - b.x);
  const path = bright.map((s, i) => `${i ? 'L' : 'M'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`).join(' ');
  svg.append(h('svg:path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-opacity': '.18', 'stroke-width': '1' }));
  for (const s of stars) svg.append(h('svg:circle', { cx: s.x.toFixed(1), cy: s.y.toFixed(1), r: s.r.toFixed(2), fill: 'currentColor', 'fill-opacity': s.o.toFixed(2) }));
  svg.style.color = 'var(--primary)';
  host.replaceChildren(svg);
}

export function mountHome(root, { store, engine, actions, win, doc = win.document }) {
  const form = root.querySelector('#account-form');
  const input = root.querySelector('#username');
  const submit = root.querySelector('#open-studio');
  const status = root.querySelector('#status');
  const alt = root.querySelector('#home-alt');
  const headActions = root.querySelector('#home-head-actions');
  const title = root.querySelector('.home-title');
  const lede = root.querySelector('.home-lede');
  drawSky(root.querySelector('.home-sky'));

  let remembered = '';
  try { remembered = win.localStorage.getItem(LAST_ACCOUNT) || ''; } catch {}
  if (remembered && !input.value) input.value = remembered;

  submit.disabled = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      store.update({ status: { text: 'Enter a GitHub username, like “octocat”.', tone: 'error' } });
      input.focus();
      return;
    }
    actions.openAccount(value);
  });
  input.addEventListener('input', () => {
    if (store.get().status?.tone === 'error') store.update({ status: null });
  });

  // Loading state: replaces the form, keeps the headline so nothing jumps.
  const loadingText = h('p', { class: 'home-lede', role: 'status', 'aria-live': 'polite' });
  const loading = h('div', { class: 'loading-screen', hidden: true, style: { minHeight: 'auto', padding: '0' } },
    h('div', { class: 'loading-orbit', 'aria-hidden': 'true' }),
    loadingText,
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => actions.goHome() }, 'Cancel'));
  form.after(loading);

  function drawAlternatives(state) {
    const saved = actions.savedDesigns();
    replace(alt,
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => actions.openSample() }, icon('sparkle', { size: 18 }), 'Try an example'),
      saved.length ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => actions.openDialog('saved') }, icon('folder', { size: 18 }), `Your saved designs (${saved.length})`) : null);
    const viewer = engine.viewer;
    const canSignIn = engine.signIn.configured || engine.signIn.tokenAllowed;
    replace(headActions,
      viewer
        ? h('button', { class: 'btn btn-sm', type: 'button', title: 'Sign out or switch account', onclick: () => actions.openDialog('sign-in') }, icon('github', { size: 18 }), `Signed in as @${viewer.login}`)
        : engine.signIn.local
          ? h('span', { class: 'fact', title: 'The local preview server is using your GitHub token.' }, icon('github', { size: 16 }), 'Signed in locally')
          : canSignIn ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => actions.openDialog('sign-in') }, icon('github', { size: 18 }), 'Sign in') : null);
  }

  function draw(state, changed) {
    if (changed.has('status') || changed.has('screen')) {
      const text = state.status?.text || '';
      const isError = state.status?.tone === 'error';
      if (state.screen === 'loading') loadingText.textContent = text || 'Finding your projects…';
      else status.textContent = isError ? text : '';
    }
    if (changed.has('screen')) {
      const loadingNow = state.screen === 'loading';
      form.hidden = loadingNow;
      alt.hidden = loadingNow;
      loading.hidden = !loadingNow;
      lede.hidden = loadingNow;
      title.textContent = '';
      title.append('Your code, written in the ', h('em', { text: 'stars' }), '.');
      if (state.screen === 'home') {
        drawAlternatives(state);
        if (state.status?.tone === 'error') queueMicrotask(() => input.focus());
      }
      if (state.screen === 'studio' && state.account && !state.sample) {
        try { win.localStorage.setItem(LAST_ACCOUNT, state.account); } catch {}
        input.value = state.account;
      }
    }
  }
  store.subscribe(draw);
  engine.onSessionChange(() => drawAlternatives(store.get()));
  drawAlternatives(store.get());
  // Give keyboard and screen reader users the field first. The field also has
  // autofocus, so this only matters when something else took focus.
  if (!new URL(win.location.href).searchParams.size) queueMicrotask(() => { if (doc.activeElement === doc.body) input.focus({ preventScroll: true }); });
  // Enter pressed before the app was ready (index.html keeps it): go now.
  if (form.dataset.pending !== undefined) {
    delete form.dataset.pending;
    if (input.value.trim()) queueMicrotask(() => form.requestSubmit());
  }
}
